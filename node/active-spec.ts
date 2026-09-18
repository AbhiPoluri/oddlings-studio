import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

/**
 * A pointer to whatever asset was built most recently.
 *
 * The studio reads this to show what an agent is working on right now, without
 * anyone having to import a file by hand. The asset itself is embedded rather
 * than referenced, so the pointer works whether or not the caller asked for a
 * `json` export, and the studio only ever has to watch one URL.
 *
 * Writing it is best effort. A read-only working directory is a reason to skip
 * the preview, never a reason to fail a build.
 */
export const ACTIVE_POINTER = '.oddlings/active.json';

export type ActivePointer = {
  name: string;
  /** ISO timestamp, so the studio can say how fresh this is. */
  at: string;
  /** Where it came from, for the studio to show. */
  source: string;
  /** A recipe or a spec — the studio tells them apart the same way an import does. */
  doc: unknown;
};

export async function markActive(
  name: string,
  doc: unknown,
  source: string,
): Promise<void> {
  // The test suite writes dozens of throwaway assets. Letting them steer the
  // studio would swap whatever the user is looking at for "Sprig 009" every
  // time someone runs `npm test`.
  if (process.env.VITEST) return;
  try {
    const path = resolve(ACTIVE_POINTER);
    await mkdir(dirname(path), { recursive: true });
    const pointer: ActivePointer = {
      name,
      at: new Date().toISOString(),
      source: relative(process.cwd(), resolve(source)) || source,
      doc,
    };
    await writeFile(path, JSON.stringify(pointer));
  } catch {
    // No preview this time. Not worth interrupting the build over.
  }
}
