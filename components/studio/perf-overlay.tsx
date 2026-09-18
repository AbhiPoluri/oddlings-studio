'use client';
import { useEffect, useRef, useState } from 'react';
import {
  gaugeOf,
  lastSpan,
  logTable,
  perfFromLocation,
  perfOn,
  rate,
  resetPerf,
  table,
  tally,
  watchPerf,
  type Row,
} from '@/lib/perf';

/**
 * What `?perf=1` shows.
 *
 * Four numbers, because these are the four this studio was actually slow in.
 * How long a build takes and where inside it the time goes. How long the main
 * thread was blocked, which is what "the UI froze" means in a number — a
 * `longtask` entry is the browser saying it could not paint. How many times the
 * shell re-rendered in the last second, which is how the playback problem was
 * invisible: nothing looked wrong, it just cost a full re-render of every panel
 * ten times a second. And the frame rate the viewport is actually drawing at.
 *
 * Nothing here is imported unless the flag is on, and nothing is recorded
 * unless `lib/perf` has been switched on — an overlay that instrumented every
 * session would be its own performance problem.
 */

/** Commits of the shell in the last second, as a rolling window. */
const COMMITS = 'shell.commit';

export function PerfOverlay() {
  const [, tick] = useState(0);
  const [tasks, setTasks] = useState<{ count: number; worst: number }>({
    count: 0,
    worst: 0,
  });
  const longest = useRef(0);

  useEffect(() => watchPerf(() => tick((n) => n + 1)), []);

  // A second heartbeat, because the rolling rates decay with time rather than
  // with events: a shell that stops committing has to be seen to stop.
  useEffect(() => {
    const beat = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(beat);
  }, []);

  /**
   * Main-thread blocking, straight from the browser.
   *
   * `longtask` is every turn over 50 ms, which is the only measure of "froze"
   * that does not depend on somebody remembering to time the right function.
   */
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    let seen = 0;
    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          seen++;
          if (entry.duration > longest.current) longest.current = entry.duration;
        }
        setTasks({ count: seen, worst: Math.round(longest.current) });
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Firefox and Safari do not report long tasks. The rest still works.
      return;
    }
    return () => observer.disconnect();
  }, []);

  const rows: Row[] = table();
  const build = lastSpan('build.model');
  const fps = gaugeOf('fps');

  return (
    <aside className="perf" aria-label="Performance">
      <header>
        <strong>perf</strong>
        <button
          type="button"
          onClick={() => {
            longest.current = 0;
            setTasks({ count: 0, worst: 0 });
            resetPerf();
          }}
        >
          reset
        </button>
        <button type="button" onClick={() => logTable()}>
          log
        </button>
      </header>
      <dl>
        <dt>edit → frame</dt>
        <dd className="tabular">{build ? `${Math.round(build.ms)} ms` : '—'}</dd>
        <dt>long tasks</dt>
        <dd className="tabular">
          {tasks.count} · worst {tasks.worst} ms
        </dd>
        <dt>shell commits/s</dt>
        <dd className="tabular">{rate(COMMITS)}</dd>
        <dt>fps</dt>
        <dd className="tabular">{fps ?? '—'}</dd>
      </dl>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="tabular">{Math.round(row.last)}</td>
              <td className="tabular">{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}

/**
 * Switch recording on from the address bar, and count this component's own
 * commits while it is on.
 *
 * Returns whether the overlay should be drawn. Called from the shell, so the
 * count it keeps is the shell's — which is the number the playback work was
 * aiming at, and the one that would be meaningless measured anywhere else.
 */
export function usePerf(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(perfFromLocation(window.location.search));
  }, []);
  // No dependency list: this runs once per commit of the component that called
  // it, which is exactly the thing being counted. It records rather than sets
  // state, so it cannot cascade.
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => {
    if (perfOn()) tally(COMMITS);
  });
  return on;
}
