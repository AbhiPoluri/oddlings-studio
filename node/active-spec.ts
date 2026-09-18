import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * The running log of every build, one JSON object per line.
 *
 * The pointer above says what is on screen NOW. This says what happened, which
 * is the other half of reviewing an agent's work: a triangle count that
 * doubled, an error that came back three builds after it was fixed, a spec
 * that has been rebuilt forty times without ever passing. The studio reads it
 * through its own API and draws the trend.
 *
 * JSON Lines, because the common operation is "append one build" and the
 * second most common is "read the tail". Rewriting a JSON array for every
 * build would make the cheapest thing the file does the most expensive.
 */
export const BUILD_LOG = '.oddlings/builds.jsonl';

/**
 * Lines kept. A long session runs to hundreds of builds; past a couple of
 * thousand the history is archaeology, and an unbounded log in a working
 * directory is a slow leak nobody notices until it is large.
 */
const BUILD_LOG_LINES = 2000;

/** What a build is worth recording. Shape is a contract with the studio API. */
export type BuildRecord = {
  tris: number;
  meshes: number;
  bones: number;
  ok: boolean;
  errors: number;
  warnings: number;
  /** The spec or recipe this was built from, as the caller named it. */
  source: string;
};

export async function markActive(
  name: string,
  doc: unknown,
  source: string,
  record?: BuildRecord,
): Promise<void> {
  // The test suite writes dozens of throwaway assets. Letting them steer the
  // studio would swap whatever the user is looking at for "Sprig 009" every
  // time someone runs `npm test` — and would fill the history with them.
  if (process.env.VITEST) return;
  const at = new Date().toISOString();
  try {
    const path = resolve(ACTIVE_POINTER);
    await mkdir(dirname(path), { recursive: true });
    const pointer: ActivePointer = {
      name,
      at,
      source: relative(process.cwd(), resolve(source)) || source,
      doc,
    };
    await writeFile(path, JSON.stringify(pointer));
  } catch {
    // No preview this time. Not worth interrupting the build over.
  }
  if (record) await appendBuild(name, at, record);
}

/** Key order here is the contract. Do not reorder. */
function buildLine(name: string, at: string, record: BuildRecord) {
  return JSON.stringify({
    at,
    name,
    source: relative(process.cwd(), resolve(record.source)) || record.source,
    tris: record.tris,
    meshes: record.meshes,
    bones: record.bones,
    ok: record.ok,
    errors: record.errors,
    warnings: record.warnings,
  });
}

async function appendBuild(name: string, at: string, record: BuildRecord) {
  try {
    const path = resolve(BUILD_LOG);
    await mkdir(dirname(path), { recursive: true });
    let lines: string[] = [];
    try {
      lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    } catch {
      // First build in this working directory.
    }
    lines.push(buildLine(name, at, record));
    // Rewritten rather than appended so the cap can bite. At 2,000 lines the
    // file is a few hundred kilobytes, which is cheaper to rewrite than a
    // build is to produce.
    await writeFile(path, `${lines.slice(-BUILD_LOG_LINES).join('\n')}\n`);
  } catch {
    // Same rule as the pointer: history is a convenience, not a build step.
  }
}
