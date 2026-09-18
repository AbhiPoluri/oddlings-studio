/**
 * A stopwatch the studio can switch on.
 *
 * The builder is the slowest thing in this project by two orders of magnitude,
 * and "it feels slow" is not a number you can optimise against. This is the
 * smallest thing that produces numbers: named spans, counters, and a rolling
 * table the `?perf=1` overlay reads.
 *
 * Off by default, and off costs a boolean test. That matters because `mark` is
 * called from inside `buildSpec`, which runs on every edit — an instrument that
 * allocates on a hot path is a second performance problem. Nothing here is
 * imported for its side effects either: a production bundle that never calls
 * `setPerf(true)` never records anything and never grows a listener.
 */

export type Span = {
  /** What was measured, e.g. `build`, `surface.sample`, `audit`. */
  name: string;
  /** Wall-clock milliseconds. */
  ms: number;
  /** When it finished, on the same clock `now()` reads. */
  at: number;
};

export type Row = {
  name: string;
  count: number;
  /** Milliseconds in the most recent span with this name. */
  last: number;
  /** Total across every span with this name since the last reset. */
  total: number;
  max: number;
};

/** Enough history for a session of poking at one spec, not for a leak. */
const LIMIT = 400;

let on = false;
const spans: Span[] = [];
const counters = new Map<string, number>();
const listeners = new Set<() => void>();

/**
 * The clock.
 *
 * `performance` exists in browsers, workers and Node 16+, but a bare `now()`
 * that throws in some future host would take the builder down with it, so the
 * fallback is real rather than decorative.
 */
export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Turn recording on or off. Turning it off clears what was collected. */
export function setPerf(next: boolean): void {
  if (on === next) return;
  on = next;
  if (!on) {
    spans.length = 0;
    counters.clear();
    gauges.clear();
  }
  announce();
}

export function perfOn(): boolean {
  return on;
}

/**
 * Switch on from the address bar.
 *
 * Called once by the studio shell rather than at import time: a module that
 * reads `location` when it loads cannot be imported by the CLI, the MCP server
 * or the build worker, and all three pull in the builder this instruments.
 */
export function perfFromLocation(search: string): boolean {
  const wanted = /(^|[?&])perf=1(&|$)/.test(search);
  if (wanted) setPerf(true);
  return wanted;
}

/** Start of a span. Cheap enough to call unconditionally. */
export function mark(): number {
  return on ? now() : 0;
}

/**
 * End of a span opened by `mark`, returning its length so a caller can report
 * the number without going back through the table.
 */
export function measure(name: string, from: number): number {
  if (!on) return 0;
  const ms = now() - from;
  spans.push({ name, ms, at: now() });
  if (spans.length > LIMIT) spans.splice(0, spans.length - LIMIT);
  announce();
  return ms;
}

/** Time a synchronous call. Returns whatever it returned. */
export function timed<T>(name: string, run: () => T): T {
  if (!on) return run();
  const from = now();
  try {
    return run();
  } finally {
    measure(name, from);
  }
}

/** Count something that has no duration — a React commit, a dropped build. */
export function bump(name: string, by = 1): void {
  if (!on) return;
  counters.set(name, (counters.get(name) ?? 0) + by);
  announce();
}

export function countOf(name: string): number {
  return counters.get(name) ?? 0;
}

/**
 * Record that something happened, with no duration.
 *
 * `rate` counts spans within a window, so an event that is a moment rather
 * than a stretch — a React commit — is written down as a span of zero.
 */
export function tally(name: string): void {
  if (!on) return;
  measure(name, now());
}

/** Last-value metrics, for things that are a reading rather than a total. */
const gauges = new Map<string, number>();

export function gauge(name: string, value: number): void {
  if (!on) return;
  if (gauges.get(name) === value) return;
  gauges.set(name, value);
  announce();
}

export function gaugeOf(name: string): number | undefined {
  return gauges.get(name);
}

/** Every counter, for the overlay. */
export function counts(): ReadonlyMap<string, number> {
  return counters;
}

/** Raw spans, newest last. The overlay uses this for per-event readouts. */
export function history(): readonly Span[] {
  return spans;
}

/** The most recent span with this name, or undefined. */
export function lastSpan(name: string): Span | undefined {
  for (let i = spans.length - 1; i >= 0; i--)
    if (spans[i].name === name) return spans[i];
  return undefined;
}

/** How many spans with this name finished in the last `window` milliseconds. */
export function rate(name: string, window = 1000): number {
  const cutoff = now() - window;
  let seen = 0;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].at < cutoff) break;
    if (spans[i].name === name) seen++;
  }
  return seen;
}

/** The table: one row per span name, in first-seen order. */
export function table(): Row[] {
  const rows = new Map<string, Row>();
  for (const span of spans) {
    let row = rows.get(span.name);
    if (!row) {
      row = { name: span.name, count: 0, last: 0, total: 0, max: 0 };
      rows.set(span.name, row);
    }
    row.count++;
    row.last = span.ms;
    row.total += span.ms;
    if (span.ms > row.max) row.max = span.ms;
  }
  return [...rows.values()];
}

export function resetPerf(): void {
  spans.length = 0;
  counters.clear();
  gauges.clear();
  announce();
}

/** Subscribe to "something was recorded". Returns the unsubscribe. */
export function watchPerf(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Coalesced, because a build records a handful of spans in the same tick and a
 * React overlay that re-rendered once per span would be measuring itself.
 */
let pending = false;
function announce(): void {
  if (!listeners.size || pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const listener of listeners) listener();
  });
}

/** Print the table to the console, for a Node bench or a browser session. */
export function logTable(): void {
  const rows = table().map((row) => ({
    name: row.name,
    count: row.count,
    last: Math.round(row.last),
    avg: Math.round(row.total / row.count),
    max: Math.round(row.max),
  }));
  if (rows.length) console.table(rows);
  if (counters.size) console.table([...counters].map(([name, n]) => ({ name, n })));
}
