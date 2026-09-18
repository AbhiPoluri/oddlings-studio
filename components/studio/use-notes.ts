'use client';
/**
 * The review notes for whichever file the studio is on.
 *
 * Deliberately outside the reducer and outside the undo history. A note is not
 * part of the asset: writing one must not detach the follow, must not show up
 * in the diff marks, and must not be undone by a ⌘Z aimed at a gizmo drag three
 * edits ago. The file it lives in is the agent's to read and to answer, so this
 * hook owns one job — keep the browser's copy and the file the same.
 *
 * Which means saving on every change rather than behind a button. A note that
 * was typed and lost because nobody pressed Save is worse than no note at all,
 * and there is nothing here worth confirming: the whole document is a list of
 * sentences, and every one of them can be deleted again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewNote } from './notes';
import { useStudio } from './store';

export const NOTES_ROUTE = '/__oddlings/notes';
/** Long enough to swallow a burst of typing, short enough to feel automatic. */
const DEBOUNCE_MS = 300;

/** The same rule the save endpoint enforces: a relative JSON path, no escaping. */
const SPEC_PATH = /^[\w./-]+\.json$/;

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed';

export type Notes = {
  /** The spec these notes are about, or null when the document has no file. */
  path: string | null;
  notes: ReviewNote[];
  state: SaveState;
  /** False until the first read has landed, so the panel can hold its tongue. */
  loaded: boolean;
  add: (note: ReviewNote) => void;
  replace: (notes: ReviewNote[]) => void;
};

export function useNotes(): Notes {
  const { state } = useStudio();
  const origin = state.doc.origin;
  const source = state.follow.source?.replace(/^\//, '') ?? null;
  /**
   * An imported document, a blueprint and a library recipe are not files in
   * this project, so there is nowhere to put a note about one — and the file
   * the studio happened to be following before it was opened is somebody
   * else's asset.
   */
  const path =
    (origin === 'agent' || origin === 'human') &&
    source &&
    SPEC_PATH.test(source) &&
    !source.includes('..')
      ? source
      : null;

  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  /** True while this browser holds a change the file has not been told about. */
  const dirty = useRef(false);
  /** The newest list, for the flush that runs when the followed file changes. */
  const latest = useRef<ReviewNote[]>(notes);
  latest.current = notes;

  const put = useCallback(async (target: string, body: ReviewNote[]) => {
    try {
      const response = await fetch(NOTES_ROUTE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target, notes: body }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      return Boolean(response.ok && result.ok);
    } catch {
      return false;
    }
  }, []);

  // ── Reading ────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    if (!path) {
      dirty.current = false;
      setNotes([]);
      setLoaded(false);
      setSaveState('saved');
      return;
    }
    void (async () => {
      try {
        const response = await fetch(
          `${NOTES_ROUTE}?path=${encodeURIComponent(path)}`,
          { cache: 'no-store' },
        );
        const body = (await response.json()) as { notes?: ReviewNote[] };
        if (!live) return;
        if (!response.ok) throw Error('The notes file could not be read.');
        dirty.current = false;
        setNotes(Array.isArray(body.notes) ? body.notes : []);
        setSaveState('saved');
        setLoaded(true);
      } catch {
        if (!live) return;
        setNotes([]);
        setLoaded(true);
        setSaveState('failed');
      }
    })();
    return () => {
      live = false;
    };
  }, [path, reload]);

  /**
   * Re-read when the agent has been at the file, and when the window comes back.
   *
   * The other half of this conversation happens outside the browser: the agent
   * resolves a note from its CLI and writes a reply into the same file. Without
   * these, a reply would never appear — and worse, the next autosave would
   * write this tab's stale copy over the top of it.
   */
  const lastBuildAt = state.follow.lastBuildAt;
  const known = useRef<string | null>(null);
  useEffect(() => {
    if (known.current === lastBuildAt) return;
    known.current = lastBuildAt;
    if (!dirty.current) setReload((n) => n + 1);
  }, [lastBuildAt]);
  useEffect(() => {
    const again = () => {
      if (!dirty.current) setReload((n) => n + 1);
    };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);

  // ── Writing ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!path || !dirty.current) return;
    let live = true;
    const timer = setTimeout(() => {
      const sent = latest.current;
      setSaveState('saving');
      void put(path, sent).then((ok) => {
        if (!live) return;
        if (!ok) return setSaveState('failed');
        // Something typed while the request was in flight is still unsaved,
        // and the effect this list re-ran has already queued the next write.
        if (latest.current !== sent) return;
        dirty.current = false;
        setSaveState('saved');
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [notes, path, put]);

  /**
   * Flush on the way out of a file.
   *
   * The cleanup closes over the path the notes belong to, not the one being
   * opened, and `latest` still holds that file's list — the read effect has not
   * replaced it yet. Without this, opening a second project within 300 ms of
   * typing would take the note with it.
   */
  useEffect(() => {
    return () => {
      if (path && dirty.current) void put(path, latest.current);
    };
  }, [path, put]);

  const replace = useCallback((next: ReviewNote[]) => {
    dirty.current = true;
    setSaveState('unsaved');
    setNotes(next);
  }, []);

  const add = useCallback(
    (note: ReviewNote) => replace([...latest.current, note]),
    [replace],
  );

  return { path, notes, state: saveState, loaded, add, replace };
}
