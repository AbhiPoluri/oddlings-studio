'use client';
/**
 * The `specs/` listing, polled once for the whole studio.
 *
 * This used to live inside the Projects panel, which was the right place for it
 * right up until three other things needed the same answer: the empty state
 * offers the most recently written files as buttons, the thumbnail cache is
 * keyed on a file's modification time, and a spec appearing in the folder is
 * worth saying out loud whether or not the list happens to be the tab on
 * screen. A poll that stops when you switch tabs cannot do the last of those.
 *
 * Still a poll rather than a watcher, for the reason it always was: one
 * directory listing every three seconds is cheaper than a file watcher's worth
 * of moving parts, and nothing is waiting on the difference.
 */
import { useEffect, useRef, useState } from 'react';
import { signatureOf, type SpecRow } from './projects';
import { useStudio } from './store';
import { useToaster } from './toasts';

export const SPECS_ROUTE = '/__oddlings/specs';
/** Often enough that a build feels immediate, rarely enough to be free. */
const POLL_MS = 3000;

export function useProjects(): { trouble: string | null } {
  const { dispatch } = useStudio();
  const [trouble, setTrouble] = useState<string | null>(null);
  const say = useToaster();
  const signature = useRef('');
  /**
   * The paths this session has already seen.
   *
   * Null until the first listing lands, because the first listing is not news:
   * announcing the seventeen files that were already there would be a wall of
   * toasts for opening the page.
   */
  const seen = useRef<Set<string> | null>(null);
  // The toaster closes over `dispatch`, which never changes, but writing it
  // into a ref keeps the effect below honestly dependency-free.
  const announce = useRef(say);
  announce.current = say;

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
        dispatch({ type: 'specs', specs: body.specs });

        const paths = body.specs.map((row) => row.path);
        if (!seen.current) {
          seen.current = new Set(paths);
          return;
        }
        const fresh = body.specs.filter((row) => !seen.current!.has(row.path));
        for (const row of paths) seen.current.add(row);
        // A half-written file appears in the listing as `broken` a poll before
        // it is readable; announcing it then would offer an Open that fails.
        const worth = fresh.filter((row) => !row.broken);
        if (worth.length > 2)
          announce.current(`${worth.length} new specs appeared in specs/.`);
        else
          for (const row of worth)
            announce.current(`New spec appeared: ${row.name}`, { open: row.path });
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
  }, [dispatch]);

  return { trouble };
}
