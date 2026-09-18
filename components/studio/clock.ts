'use client';
import { useSyncExternalStore } from 'react';

/**
 * The playhead, kept outside the store on purpose.
 *
 * While a clip runs, the viewport advances its own mixer and reports where it
 * has got to about ten times a second. That used to be a dispatch, which meant
 * the whole shell — top bar, outliner, property editor, findings, Projects —
 * re-rendered ten times a second to move one number in one readout. Nothing
 * else on screen depends on it.
 *
 * So it lives here instead. The Timeline subscribes because it draws the
 * playhead; nothing else does, and the shell commits zero times while a clip
 * plays with nothing else changing.
 *
 * The store still holds a `playback.time`, and it still means something
 * different: where a *seek* asked the viewport to go. That is set by scrubbing
 * and reset by a clip change, both of which are one event apiece, and the
 * viewport honours it only while paused. This is the live reading; that is the
 * instruction.
 */

let seconds = 0;
const listeners = new Set<() => void>();

export function clockAt(): number {
  return seconds;
}

/** Report where the clip has got to. A repeat of the same value is free. */
export function setClock(next: number): void {
  if (next === seconds) return;
  seconds = next;
  for (const listener of listeners) listener();
}

export function watchClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe a component to the playhead.
 *
 * The server snapshot is a constant zero: a clip has not started running
 * during a render on the server, and returning the live value there would make
 * the first client render disagree with the markup it is hydrating.
 */
export function useClock(): number {
  return useSyncExternalStore(watchClock, clockAt, () => 0);
}
