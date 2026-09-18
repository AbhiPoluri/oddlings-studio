'use client';
/**
 * Mirroring the file an agent is building, and writing a review back to it.
 *
 * With no URL parameter the studio follows `.oddlings/active.json`, which every
 * build and audit rewrites — so opening the studio shows whatever was made
 * last, and it keeps up as that changes. A `?spec=` parameter pins it to one
 * file instead.
 *
 * Following is one-way until someone saves: the moment anyone edits in here the
 * studio detaches rather than fighting the file for the same document, and Save
 * is what closes the loop — it writes the reviewed spec back and re-attaches,
 * so the agent's next iteration starts from the correction.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { POINTER_URL, savePath } from './reducer';
import { useStudio } from './store';
import { docFrom } from './use-document';

export const SAVE_ROUTE = '/__oddlings/save';

/** The same rule the save endpoint enforces: a relative JSON path, no escaping. */
const SPEC_PATH = /^[\w./-]+\.json$/;

type Target = { url: string; label: string; pinned: boolean };

/** What this page was pointed at when it loaded. */
function targetOf(): Target {
  const asked = new URLSearchParams(location.search).get('spec');
  const safe = asked && SPEC_PATH.test(asked) && !asked.includes('..');
  return safe
    ? { url: `/${asked.replace(/^\//, '')}`, label: asked, pinned: true }
    : { url: POINTER_URL, label: 'the latest build', pinned: false };
}

/**
 * A change marker for one payload.
 *
 * The dev server sends an ETag for every static file, so a poll that finds
 * nothing new costs a request with no body worth reading. When there is no
 * ETag — a different server, a proxy that strips it — the body itself stands
 * in, hashed, so "unchanged" still means unchanged rather than "reload this
 * once a second forever".
 */
function signature(etag: string | null, body: string): string {
  if (etag) return etag;
  let hash = 5381;
  for (let i = 0; i < body.length; i++) hash = (hash * 33) ^ body.charCodeAt(i);
  return `len:${body.length}:${(hash >>> 0).toString(36)}`;
}

export function useFollow() {
  const { dispatch, ref } = useStudio();
  /** Bumped by "Check again", which re-runs the attach effect. */
  const [recheck, setRecheck] = useState(0);
  const target = useRef<Target | null>(null);

  useEffect(() => {
    const want = targetOf();
    // Survives a detach, so the bar can offer to re-follow the right thing.
    target.current = want;
    dispatch({
      type: 'attach',
      url: want.url,
      source: want.pinned ? want.label : null,
      pinned: want.pinned,
    });

    let live = true;

    async function pull(first: boolean) {
      const status = ref.current.follow.status;
      if (!first && status !== 'live') return;
      let response: Response;
      try {
        response = await fetch(want.url, { cache: 'no-store' });
      } catch {
        return;
      }
      if (!live || !response.ok) return;
      const etag = response.headers.get('etag');
      // Cheap exit before the body is parsed. The reducer checks this again,
      // because it is the gate that makes "the same build twice" impossible.
      if (!first && etag && etag === ref.current.follow.etag) return;
      let body: string;
      try {
        body = await response.text();
      } catch {
        return;
      }
      if (!live) return;
      const sig = signature(etag, body);
      if (!first && sig === ref.current.follow.etag) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      // The pointer wraps the document; a `?spec=` file is the document.
      const pointer = parsed as { doc?: unknown; source?: string; at?: string };
      const payload =
        pointer && typeof pointer === 'object' && 'doc' in pointer
          ? pointer.doc
          : parsed;
      const source = want.pinned ? want.label : (pointer?.source ?? want.label);
      try {
        dispatch({
          type: 'build',
          doc: docFrom(payload, ref.current.doc.recipe, 'agent'),
          source,
          at: pointer?.at ?? new Date().toISOString(),
          etag: sig,
          first,
        });
      } catch (error) {
        dispatch({
          type: 'status',
          text: `${source} could not be read: ${error instanceof Error ? error.message : 'invalid spec'}`,
        });
      }
    }

    void pull(true);
    // A missing pointer is a 404, which the browser logs however carefully we
    // catch it. Retry slowly, and give up rather than filling the console.
    let tries = 0;
    const waiting = setInterval(() => {
      if (ref.current.follow.status !== 'waiting') return clearInterval(waiting);
      if (++tries > 48) {
        clearInterval(waiting);
        dispatch({ type: 'gaveUp' });
        return;
      }
      void pull(true);
    }, 2500);
    const timer = setInterval(() => void pull(false), 1000);
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(waiting);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck]);

  /** Re-follow whatever this page was pointed at when it loaded. */
  const reattach = useCallback(() => {
    if (ref.current.follow.status === 'gaveup') return setRecheck((n) => n + 1);
    if (target.current?.pinned) location.reload();
    else location.href = location.pathname;
  }, [ref]);

  /**
   * Follow one spec file, as though the page had been opened pinned to it.
   *
   * Written into the URL first, then the attach effect is re-run: `targetOf`
   * reads `location.search`, so rewriting the address is what re-points the
   * poll, and a reload of this page lands on the same file. `replaceState`
   * rather than `pushState` because Back should leave the studio rather than
   * walk a history of files, and a plain re-run rather than `location.reload`
   * because reloading would throw away the undo stack and every logged build.
   */
  const openSpec = useCallback(
    (path: string) => {
      const clean = path.replace(/^\//, '');
      if (!SPEC_PATH.test(clean) || clean.includes('..'))
        return dispatch({ type: 'status', text: `${path} is not a spec path.` });
      // Re-opening the file already on screen would re-run the attach and land
      // a second `first` payload: one more history entry and one more row in
      // the build log, for a click that changed nothing.
      const { follow } = ref.current;
      if (follow.status === 'live' && follow.source === clean)
        return dispatch({ type: 'status', text: `Already following ${clean}.` });
      const url = new URL(location.href);
      url.searchParams.set('spec', clean);
      history.replaceState(null, '', url);
      // The document may have been taken over by an edit, which a plain attach
      // would refuse; opening a file by hand is the one case that outranks it.
      dispatch({
        type: 'attach',
        url: `/${clean}`,
        source: clean,
        pinned: true,
        force: true,
      });
      setRecheck((n) => n + 1);
    },
    [dispatch, ref],
  );

  const save = useCallback(async () => {
    const state = ref.current;
    const path = savePath(state);
    const spec = state.doc.spec;
    if (!path || !spec) return;
    dispatch({ type: 'status', text: `Saving ${path}…` });
    let result: { ok?: boolean; path?: string; at?: string; error?: string };
    try {
      const response = await fetch(SAVE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, spec }),
      });
      result = (await response.json()) as typeof result;
      if (!response.ok || !result.ok)
        throw Error(result.error ?? `Save failed (${response.status}).`);
    } catch (error) {
      dispatch({
        type: 'status',
        text: `Save failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
      return;
    }
    // The endpoint also rewrites the build pointer, so the followed URL has a
    // new ETag now. Record it before following resumes, or the next poll would
    // read this studio's own save back as a fresh build from an agent.
    let etag: string | null = null;
    try {
      const echo = await fetch(ref.current.follow.url, { cache: 'no-store' });
      const body = await echo.text();
      etag = signature(echo.headers.get('etag'), body);
    } catch {
      // Without the marker the next poll reloads once. Harmless, and better
      // than leaving the studio detached from a file it just wrote.
    }
    dispatch({
      type: 'saved',
      at: result.at ?? new Date().toISOString(),
      path: result.path ?? path,
      etag,
    });
  }, [dispatch, ref]);

  return { save, reattach, openSpec };
}
