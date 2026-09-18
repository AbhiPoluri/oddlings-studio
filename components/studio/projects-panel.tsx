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
import { Images, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type * as T from 'three';
import { auditModel } from '@/lib/asset-audit';
import { parseSpec, type AssetSpec } from '@/lib/asset-spec';
import { stats } from '@/lib/asset-build';
import { createBuildClient, type BuildClient } from '@/lib/build-client';
import { disposeScene } from '@/lib/three-world';
import { flatten, pathKey } from '@/lib/spec-edit';
import type { ActionContext } from './actions';
import { closeOffscreen, renderThumb } from './offscreen';
import {
  fillStats,
  fillThumbs,
  putStats,
  putThumb,
  shrink,
  statsOf,
  thumbKey,
  thumbOf,
  watchThumbs,
} from './thumbs';
import {
  arrange,
  KIND_TAG,
  measureKey,
  pathOfKey,
  relativeTime,
  RIG_LABEL,
  type SortKey,
  type SpecRow,
} from './projects';
import { useStudio } from './store';
import { RowSkeleton } from './loading';
import type { SpecStats } from './thumbs';

const SPEC_ROUTE = '/__oddlings/spec';
/** Relative times only ever change by the minute. */
const TICK_MS = 30_000;

/** What building one spec in the browser said about it. */
type Measured = SpecStats | { failed: string };

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

/** Read one spec off disk. */
async function readSpec(path: string): Promise<AssetSpec> {
  const response = await fetch(
    `${SPEC_ROUTE}?path=${encodeURIComponent(path)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw Error(`${response.status} reading ${path}`);
  return parseSpec(await response.json());
}

/**
 * Build one spec in the worker.
 *
 * A promise around a lane, one spec at a time. The measurement queue and the
 * thumbnail run take different lanes, because a lane only ever holds its
 * newest request — sharing one would mean each run cancelled the other's
 * build, and both are long enough for that to happen every time.
 */
function buildIn(
  client: BuildClient,
  lane: string,
  spec: AssetSpec,
): Promise<T.Object3D> {
  return new Promise((done, fail) => {
    client.build(lane, { spec }, {
      onModel: done,
      onFailed: (message) => fail(Error(message)),
    });
  });
}

/**
 * Measure one built model the way the shell measures the document on screen.
 *
 * The same two calls, which is the point: a triangle count in this list means
 * what the count in the view bar means, rather than an estimate from the
 * file's shape. The model is consumed.
 */
function measureModel(spec: AssetSpec, model: T.Object3D): SpecStats {
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
    return {
      tris: counted.triangles,
      ok: audit.ok,
      meshes: counted.meshes,
      bones: counted.bones,
    };
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

export function ProjectsPanel({
  context,
  trouble,
}: {
  context: ActionContext;
  /** What went wrong reading the listing, from the hook that polls it. */
  trouble?: string | null;
}) {
  const { state } = useStudio();
  const specs = state.specs;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('modified');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [now, setNow] = useState(() => Date.now());
  /** Bumped when a measurement lands, since the cache itself is not state. */
  const [, setMeasuredAt] = useState(0);
  /** Bumped when a thumbnail lands, for the same reason. */
  const [, setThumbAt] = useState(0);
  /** How far through a Render all run we are, or null when one is not running. */
  const [rendering, setRendering] = useState<{ done: number; total: number } | null>(
    null,
  );

  // The pictures are read once per page and kept in memory; the panel is told
  // when one lands, whether it came from this tab opening a spec or from the
  // Render all button below.
  useEffect(() => {
    void fillThumbs();
    return watchThumbs(() => setThumbAt((n) => n + 1));
  }, []);
  useEffect(() => () => closeOffscreen(), []);

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

  /**
   * The panel's own build worker.
   *
   * Building seventeen specs used to happen on the main thread, which is why
   * opening this tab froze the studio for as long as the folder was deep. The
   * viewport has a worker of its own, so a measurement run never competes with
   * the document being edited for the thread that draws it.
   */
  const builder = useRef<BuildClient | null>(null);
  useEffect(() => {
    builder.current = createBuildClient();
    return () => {
      builder.current?.dispose();
      builder.current = null;
    };
  }, []);

  // Whatever the last session measured. The rows that are still true come back
  // filled in rather than being rebuilt to say the same thing.
  const [readStore, setReadStore] = useState(false);
  const stored = useRef<Promise<void> | null>(null);
  useEffect(() => {
    stored.current = fillStats();
    void stored.current.then(() => alive.current && setReadStore(true));
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
        // A row measured in the milliseconds before the store answers would be
        // rebuilt for an answer that was already on disk.
        await stored.current;
        if (!alive.current) return;
        try {
          const path = pathOfKey(key);
          const remembered = statsOf(key);
          if (remembered) {
            MEASURED.set(key, remembered);
          } else {
            const client = builder.current;
            if (!client) return;
            const spec = await readSpec(path);
            const measured = measureModel(
              spec,
              await buildIn(client, 'measure', spec),
            );
            MEASURED.set(key, measured);
            void putStats(key, measured);
          }
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

  /**
   * Fill in every missing picture, one spec at a time.
   *
   * Cheap enough to offer because it reuses the builder and the lights the
   * viewport uses in a canvas nobody sees, and it yields between specs — a
   * folder of seventeen assets is seventeen builds, which is a second or two
   * of idle time rather than a frozen tab. Rows that already have a picture at
   * the version on disk are skipped, so pressing it twice costs nothing.
   */
  const renderAll = useCallback(async () => {
    const rows = (specs ?? []).filter(
      (row) => !row.broken && !thumbOf(thumbKey(row.path, row.modified)),
    );
    if (!rows.length) return;
    setRendering({ done: 0, total: rows.length });
    try {
      for (const [index, row] of rows.entries()) {
        if (!alive.current) return;
        await idle();
        try {
          const response = await fetch(
            `${SPEC_ROUTE}?path=${encodeURIComponent(row.path)}`,
            { cache: 'no-store' },
          );
          if (response.ok) {
            const client = builder.current;
            if (!client) return;
            const spec = parseSpec(await response.json());
            // Built in the worker, drawn here: the geometry can be made
            // anywhere, but only this thread holds a WebGL context.
            const shot = renderThumb(spec, await buildIn(client, 'thumbs', spec));
            if (shot) await putThumb(thumbKey(row.path, row.modified), await shrink(shot));
          }
        } catch {
          // One spec that will not build is one card without a picture.
        }
        if (alive.current) setRendering({ done: index + 1, total: rows.length });
      }
    } finally {
      closeOffscreen();
      if (alive.current) setRendering(null);
    }
  }, [specs]);

  const missing = (specs ?? []).filter(
    (row) => !row.broken && !thumbOf(thumbKey(row.path, row.modified)),
  ).length;

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
        <div className="segmented" role="group" aria-label="Project view">
          <button
            type="button"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
          >
            Grid
          </button>
        </div>
        <button
          type="button"
          className="bar-button projects-render"
          disabled={!missing || rendering !== null}
          title={
            missing
              ? `Draw a thumbnail for the ${missing} spec${missing === 1 ? '' : 's'} without one`
              : 'Every spec here already has a thumbnail'
          }
          onClick={() => void renderAll()}
        >
          <Images size={12} aria-hidden="true" />
          {rendering ? `${rendering.done}/${rendering.total}` : 'Render all'}
        </button>
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

      <div className="projects-list" ref={list} role="list" data-view={view}>
        {/* The listing has not arrived yet — a different thing from having
            arrived empty, which the line at the bottom says instead. */}
        {specs === null && <RowSkeleton rows={6} />}
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
              {thumbOf(thumbKey(row.path, row.modified)) ? (
                // No alt text: the name is right beside it in the same row, and
                // a screen reader reading "picture of Octopod Walker, Octopod
                // Walker" is worse than one that reads the name once.
                <img
                  className="project-thumb"
                  alt=""
                  src={thumbOf(thumbKey(row.path, row.modified))}
                  width={160}
                  height={100}
                />
              ) : (
                <i className="project-thumb project-thumb-blank" aria-hidden="true" />
              )}
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
                <Cell measured={MEASURED.get(key) ?? (readStore ? statsOf(key) : undefined)} />
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
