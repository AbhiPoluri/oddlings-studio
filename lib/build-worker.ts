/// <reference lib="webworker" />
import { buildSpec, type AssetSpec } from './asset-spec';
import { buildAsset } from './asset-build';
import { readySurface, type BuildPhase } from './asset-surface';
import { disposeScene } from './three-world';
import {
  serializeModel,
  transfersOf,
  type SerialModel,
} from './build-serial';
import type { Recipe } from './asset-recipe';

/**
 * The builder, off the main thread.
 *
 * `buildSpec` is synchronous and, on a detailed surface spec, holds its thread
 * for a second or more. On the main thread that is a second of no frames, no
 * gizmo, no typing — the single worst thing about this studio. Here it holds a
 * thread nobody is drawing with.
 *
 * Cancellation is honest only between builds: nothing can interrupt a running
 * `buildSpec`, so the queue below keeps at most one pending request per lane
 * and drops the older one when a newer arrives. The newest spec always wins,
 * and the worst case is one wasted build — the one already in flight.
 *
 * Two lanes today: `model` for what the viewport shows and `ghost` for the
 * comparison behind it. They are separate so that turning Compare on does not
 * make the next edit wait for a ghost nobody is looking at yet.
 */

export type BuildSource =
  | { spec: AssetSpec; recipe?: undefined }
  | { recipe: Recipe; spec?: undefined };

export type BuildAsk =
  | ({
      type: 'build';
      id: number;
      lane: string;
      /** Plan the texture atlas. Previews do not; exports do. */
      uv?: boolean;
    } & BuildSource)
  | { type: 'cancel'; lane: string };

export type BuildSay =
  | { type: 'ready' }
  | { type: 'phase'; id: number; lane: string; phase: BuildPhase }
  | { type: 'built'; id: number; lane: string; model: SerialModel }
  | { type: 'failed'; id: number; lane: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** At most one waiting request per lane; a newer one replaces it unbuilt. */
const waiting = new Map<string, Extract<BuildAsk, { type: 'build' }>>();
let ready = false;
let draining = false;

void readySurface().then(() => {
  ready = true;
  scope.postMessage({ type: 'ready' } satisfies BuildSay);
  schedule();
});

scope.addEventListener('message', (event: MessageEvent<BuildAsk>) => {
  const ask = event.data;
  if (ask.type === 'cancel') {
    waiting.delete(ask.lane);
    return;
  }
  waiting.set(ask.lane, ask);
  schedule();
});

function schedule() {
  if (draining || !ready || !waiting.size) return;
  draining = true;
  // A macrotask rather than a microtask: it gives any message already on the
  // wire a chance to land first, so a burst of edits collapses to its last one
  // instead of building every keystroke in order.
  setTimeout(drain, 0);
}

function drain() {
  draining = false;
  const next = waiting.entries().next();
  if (next.done) return;
  const [lane, ask] = next.value;
  waiting.delete(lane);
  try {
    const model = ask.spec
      ? buildSpec(ask.spec, {
          uv: ask.uv ?? false,
          onPhase: (phase) =>
            scope.postMessage({
              type: 'phase',
              id: ask.id,
              lane,
              phase,
            } satisfies BuildSay),
        })
      : buildAsset(ask.recipe);
    const serial = serializeModel(model);
    scope.postMessage(
      { type: 'built', id: ask.id, lane, model: serial } satisfies BuildSay,
      transfersOf(serial),
    );
    // The buffers are gone to the other side now, so this only releases what
    // three allocated around them.
    disposeScene(model);
  } catch (error) {
    scope.postMessage({
      type: 'failed',
      id: ask.id,
      lane,
      message: error instanceof Error ? error.message : String(error),
    } satisfies BuildSay);
  }
  schedule();
}
