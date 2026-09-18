'use client';
/**
 * Everything the agents have made, as a list you can open.
 *
 * The follow feature answers "what was built last", which is the right default
 * and a poor way to review a folder: an agent working through a brief leaves a
 * dozen specs and a drafts directory behind it, and until now the only way to
 * see one of them was to know its path and type it into the URL.
 *
 * Two things this panel deliberately does not do on the server. It does not
 * build: the dev server is single-threaded, and meshing a dozen specs to count
 * their triangles would stall every module request behind it. And it does not
 * watch: a three-second poll of one directory listing is cheaper than a file
 * watcher's worth of moving parts, and nobody is waiting on the difference.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { auditModel } from '@/lib/asset-audit';
import { buildSpec, parseSpec } from '@/lib/asset-spec';
import { stats } from '@/lib/asset-build';
import { readySurface } from '@/lib/asset-surface';
import { disposeScene } from '@/lib/three-world';
import { flatten, pathKey } from '@/lib/spec-edit';
import type { ActionContext } from './actions';
import {
  arrange,
  KIND_TAG,
  measureKey,
  pathOfKey,
  relativeTime,
  RIG_LABEL,
  signatureOf,
  type SortKey,
  type SpecRow,
} from './projects';
import { useStudio } from './store';

const SPECS_ROUTE = '/__oddlings/specs';
const SPEC_ROUTE = '/__oddlings/spec';
/** Often enough that a build feels immediate, rarely enough to be free. */
const POLL_MS = 3000;
/** Relative times only ever change by the minute. */
const TICK_MS = 30_000;

/** What building one spec in the browser said about it. */
type Measured = { tris: number; ok: boolean } | { failed: string };

/**
 * Measurements, kept for the life of the page.
 *
 * Keyed by path *and* modification time, so a rebuilt file is measured again
 * rather than showing the count it had two versions ago. Module scope because
 * a person switching tabs should not pay for the same builds twice.
 */
const MEASURED = new Map<string, Measured>();

/** Yield until the browser has nothing better to do. Safari has no idle callback. */
function idle(): Promise<void> {
  return new Promise((done) => {
    const request = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (request) request(() => done(), { timeout: 600 });
    else setTimeout(done, 16);
  });
}

/**
 * Build one spec, measure it, and throw the meshes away again.
 *
 * The same three calls the shell makes for the document on screen, which is the
 * point: a triangle count in this list means what the count in the view bar
 * means, rather than an estimate from the file's shape.
 */
async function measure(path: string): Promise<Measured> {
  const response = await fetch(
    `${SPEC_ROUTE}?path=${encodeURIComponent(path)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw Error(`${response.status} reading ${path}`);
  const spec = parseSpec(await response.json());
  // A surface spec re-meshes through a WebAssembly decimator, and building one
  // before it has loaded throws.
  if (spec.surface) await readySurface();
  const model = buildSpec(spec);
  try {
    const counted = stats(model);
    const audit = auditModel(model, {
      rigged: Boolean(spec.rig),
      scale: spec.scale,
      labels: new Map(
        flatten(spec).map((row) => [
          pathKey(row.path),
          row.part.name ?? row.part.shape,
        ]),
      ),
    });
    return { tris: counted.triangles, ok: audit.ok };
  } finally {
    disposeScene(model);
  }
}

function Cell({ measured }: { measured: Measured | undefined }): ReactNode {
  if (!measured) return <span className="project-pending">…</span>;
  if ('failed' in measured)
    return (
      <span className="project-fail" title={measured.failed}>
        ✗
      </span>
    );
  return (
    <>
      <span className="project-tris tabular">
        {measured.tris.toLocaleString()}
      </span>
      <span
        className="project-check"
        data-ok={measured.ok}
        title={measured.ok ? 'Passes its checks' : 'Has findings'}
      >
        {measured.ok ? '✓' : '!'}
      </span>
    </>
  );
}

export function ProjectsPanel({ context }: { context: ActionContext }) {
  const { state } = useStudio();
  const [specs, setSpecs] = useState<SpecRow[] | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('modified');
  const [now, setNow] = useState(() => Date.now());
  /** Bumped when a measurement lands, since the cache itself is not state. */
  const [, setMeasuredAt] = useState(0);

  const signature = useRef('');

  // ── The listing ────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    async function pull() {
      // A backgrounded tab is not reviewing anything.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        return;
      try {
        const response = await fetch(SPECS_ROUTE, { cache: 'no-store' });
        if (!response.ok) throw Error(`The studio API answered ${response.status}.`);
        const body = (await response.json()) as { specs: SpecRow[] };
        if (!live) return;
        setTrouble(null);
        // `at` changes on every poll, so the comparison is on the rows. Without
        // this the list would rebuild three times a second and every row's
        // measurement would be re-queued along with it.
        const next = signatureOf(body.specs);
        if (next === signature.current) return;
        signature.current = next;
        setSpecs(body.specs);
      } catch (error) {
        if (!live) return;
        setTrouble(
          error instanceof Error
            ? error.message
            : 'The specs folder could not be read.',
        );
      }
    }
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // Relative times are only true for a minute at a time.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // ── Measuring, one row at a time ───────────────────────────────────────
  const wanted = useRef(new Set<string>());
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (wanted.current.size && alive.current) {
        const key = wanted.current.values().next().value!;
        wanted.current.delete(key);
        if (MEASURED.has(key)) continue;
        // One at a time, off the critical path: a spec is thousands of
        // triangles of geometry, and a queue that ran them all at once would
        // drop frames in the viewport next door for a column of numbers.
        await idle();
        if (!alive.current) return;
        try {
          MEASURED.set(key, await measure(pathOfKey(key)));
        } catch (error) {
          MEASURED.set(key, {
            failed: error instanceof Error ? error.message : 'Could not build this spec.',
          });
        }
        if (alive.current) setMeasuredAt((n) => n + 1);
      }
    } finally {
      running.current = false;
    }
  }, []);

  /** Rows are measured when they scroll into view, and never before. */
  const observer = useRef<IntersectionObserver | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        let asked = false;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset.measure;
          if (!key || MEASURED.has(key)) continue;
          wanted.current.add(key);
          asked = true;
        }
        if (asked) void pump();
      },
      // A little ahead of the scroll, so a row is usually measured by the time
      // it is actually readable.
      { rootMargin: '150px' },
    );
    observer.current = io;
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [pump]);

  const shown = useMemo(
    () => arrange(specs ?? [], { query, sort }),
    [specs, query, sort],
  );

  // Re-observed after every change to what is on screen: filtering the list
  // replaces the row elements the observer was holding.
  useEffect(() => {
    const io = observer.current;
    if (!io || !list.current) return;
    for (const row of list.current.querySelectorAll<HTMLElement>('[data-measure]'))
      io.observe(row);
  }, [shown]);

  /** The file this page is following, spelled the way the listing spells it. */
  const followed = state.follow.source?.replace(/^\//, '') ?? null;

  return (
    <div className="projects">
      <div className="projects-controls">
        <Input
          className="h-7"
          type="search"
          spellCheck={false}
          aria-label="Search projects"
          placeholder="Search specs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="segmented" role="group" aria-label="Sort projects">
          <button
            type="button"
            aria-pressed={sort === 'modified'}
            onClick={() => setSort('modified')}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={sort === 'name'}
            onClick={() => setSort('name')}
          >
            Name
          </button>
        </div>
      </div>

      {trouble && (
        <p className="projects-empty help" role="status">
          {trouble} The listing is a dev-server route, so it is only there while{' '}
          <code>npm run dev</code> is.
        </p>
      )}

      {!trouble && specs === null && (
        <p className="projects-empty help">
          <RefreshCw size={12} aria-hidden="true" /> Reading the specs folder…
        </p>
      )}

      <div className="projects-list" ref={list} role="list">
        {shown.map((row) => {
          const key = measureKey(row);
          const open = followed === row.path;
          return (
            <button
              key={row.path}
              type="button"
              role="listitem"
              className="project-row"
              data-measure={row.broken ? undefined : key}
              data-broken={row.broken ? 'true' : undefined}
              data-current={open ? 'true' : undefined}
              disabled={row.broken}
              title={
                row.broken
                  ? `${row.path} did not parse. It may be half-written — the listing refreshes every few seconds.`
                  : `Open ${row.path}`
              }
              onClick={() => context.openSpec(row.path)}
            >
              <i className="project-dot" aria-hidden="true" />
              <span className="project-kind" title={row.kind}>
                {KIND_TAG[row.kind] ?? '···'}
              </span>
              <strong className="project-name">{row.name}</strong>
              {row.surface && (
                <span className="project-tag" title="One fused polygon mesh">
                  surf
                </span>
              )}
              <span className="project-tag" title={`Rig: ${RIG_LABEL[row.rig]}`}>
                {RIG_LABEL[row.rig]}
              </span>
              <span className="project-parts tabular" title="Authored parts">
                {row.parts}p
              </span>
              {row.broken ? (
                <span className="project-fail">unreadable</span>
              ) : (
                <Cell measured={MEASURED.get(key)} />
              )}
              <time className="project-time" dateTime={row.modified}>
                {relativeTime(row.modified, now)}
              </time>
            </button>
          );
        })}
      </div>

      {specs !== null && !shown.length && (
        <p className="projects-empty help">
          {query.trim()
            ? `No spec matches “${query.trim()}”.`
            : 'No spec files yet. An agent writes them to specs/.'}
        </p>
      )}
    </div>
  );
}
