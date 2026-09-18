'use client';
import type * as T from 'three';
import { buildSpec } from './asset-spec';
import { buildAsset } from './asset-build';
import { readySurface, type BuildPhase } from './asset-surface';
import { deserializeModel } from './build-serial';
import type { BuildAsk, BuildSay, BuildSource } from './build-worker';
import { mark, measure } from './perf';

/**
 * The main thread's half of the build worker.
 *
 * One worker for the whole studio, started lazily on the first request. Every
 * request belongs to a lane and carries an id; a lane holds only its newest
 * request, so an edit made while a build is running supersedes it and the
 * result of the superseded one is dropped on arrival rather than drawn.
 *
 * Falls back to building on the main thread wherever a module worker cannot
 * start — an old browser, a sandbox that blocks blob workers, a server render.
 * The fallback is the old behaviour exactly, so the studio is never worse off
 * than it was; it just stops being better.
 */

export type BuildHandlers = {
  onPhase?: (phase: BuildPhase) => void;
  onModel: (model: T.Object3D) => void;
  onFailed?: (message: string) => void;
};

export type BuildClient = {
  /** Queue a build. Returns the request id, which `cancel` does not need. */
  build(lane: string, source: BuildSource, handlers: BuildHandlers): number;
  /** Forget this lane's pending request; nothing more is delivered for it. */
  cancel(lane: string): void;
  /** False when the build runs on the main thread after all. */
  readonly worker: boolean;
  dispose(): void;
};

type Waiting = { id: number; handlers: BuildHandlers; started: number };

/**
 * Whether this page can run the builder somewhere else.
 *
 * Checked rather than assumed: `vinext` renders these components on the server
 * too, and a `new Worker` there throws rather than degrading.
 */
function workersWork(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}

/**
 * Where the dev server serves the worker's source from.
 *
 * Only ever used as a fallback. See `start` below for why it has to exist.
 */
const WORKER_PATH = '/lib/build-worker.ts';

/**
 * Start the worker.
 *
 * The first attempt is written in exactly the shape the bundler looks for —
 * `new Worker(new URL('./build-worker.ts', import.meta.url), { type: 'module' })`
 * — and it has to stay written that way, spelled out at the call, or the
 * production build stops compiling the worker into its own chunk and ships the
 * TypeScript source as a static asset instead. Nothing warns about that; the
 * page simply fails to start a worker it can no longer parse.
 *
 * The second attempt is for the dev server, which rewrites `import.meta.url`
 * to a sanitised `file:///ROOT/...`. A `file:` URL cannot be loaded as a worker
 * from an http origin, so the first attempt throws a `SecurityError` and this
 * one asks for the same module by the path the dev server serves this source
 * tree at.
 */
function start(): Worker | null {
  try {
    return new Worker(new URL('./build-worker.ts', import.meta.url), {
      type: 'module',
      name: 'oddlings-build',
    });
  } catch {
    // Fall through to the dev server's own path for this module.
  }
  if (typeof location === 'undefined') return null;
  try {
    return new Worker(new URL(WORKER_PATH, location.origin), {
      type: 'module',
      name: 'oddlings-build',
    });
  } catch {
    return null;
  }
}

export function createBuildClient(): BuildClient {
  const lanes = new Map<string, Waiting>();
  let worker: Worker | null = null;
  let next = 1;
  let broken = false;

  if (workersWork()) {
    worker = start();
    worker?.addEventListener('message', receive);
    worker?.addEventListener('error', () => {
      // A worker that fails to load at all — a bundling problem, a blocked
      // origin — must not take the studio with it. Fall back for good.
      broken = true;
      worker?.terminate();
      worker = null;
    });
  }

  function receive(event: MessageEvent<BuildSay>) {
    const say = event.data;
    if (say.type === 'ready') return;
    const waiting = lanes.get(say.lane);
    // Superseded, cancelled, or from a lane nobody is listening to any more.
    if (!waiting || waiting.id !== say.id) return;
    if (say.type === 'phase') {
      waiting.handlers.onPhase?.(say.phase);
      return;
    }
    lanes.delete(say.lane);
    if (say.type === 'failed') {
      waiting.handlers.onFailed?.(say.message);
      return;
    }
    measure(`build.${say.lane}`, waiting.started);
    waiting.handlers.onModel(deserializeModel(say.model));
  }

  /**
   * The main-thread path.
   *
   * Deferred by a task so the caller sees the same shape either way: a build
   * that lands in a later turn, after the "building…" chip has had a chance to
   * paint. The build itself still blocks, which is the whole point of the
   * worker existing.
   */
  function locally(lane: string, source: BuildSource, id: number) {
    const run = () => {
      const waiting = lanes.get(lane);
      if (!waiting || waiting.id !== id) return;
      const started = mark();
      try {
        const model = source.spec
          ? buildSpec(source.spec, {
              uv: false,
              onPhase: (phase) => waiting.handlers.onPhase?.(phase),
            })
          : buildAsset(source.recipe);
        lanes.delete(lane);
        measure(`build.${lane}`, started);
        waiting.handlers.onModel(model);
      } catch (error) {
        lanes.delete(lane);
        waiting.handlers.onFailed?.(
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    // A surface spec cannot build until its decimator is in memory. The worker
    // waits for its own copy before it drains; here it is the caller's turn to.
    if (source.spec?.surface) void readySurface().then(run);
    else setTimeout(run, 0);
  }

  return {
    build(lane, source, handlers) {
      const id = next++;
      // The displaced request is told so rather than dropped in silence. A
      // caller that wrapped its lane in a promise — the Projects queue does —
      // would otherwise wait for a result that is never coming, and take its
      // whole queue down with it.
      const displaced = lanes.get(lane);
      lanes.set(lane, { id, handlers, started: mark() });
      displaced?.handlers.onFailed?.('superseded');
      if (worker && !broken)
        worker.postMessage({
          type: 'build',
          id,
          lane,
          uv: false,
          ...source,
        } satisfies BuildAsk);
      else locally(lane, source, id);
      return id;
    },
    cancel(lane) {
      const waiting = lanes.get(lane);
      lanes.delete(lane);
      waiting?.handlers.onFailed?.('cancelled');
      worker?.postMessage({ type: 'cancel', lane } satisfies BuildAsk);
    },
    get worker() {
      return Boolean(worker) && !broken;
    },
    dispose() {
      for (const waiting of lanes.values())
        waiting.handlers.onFailed?.('the studio closed this viewport');
      lanes.clear();
      worker?.terminate();
      worker = null;
    },
  };
}
