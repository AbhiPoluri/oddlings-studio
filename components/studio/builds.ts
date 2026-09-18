/**
 * Two build logs, read as one.
 *
 * The studio keeps its own log of everything it was handed while the tab was
 * open, and each row holds the whole document, so clicking one puts that
 * version back on screen. That log dies with the tab — which makes the answer
 * to "what has this spec been through" depend on when you happened to open the
 * studio, and the CLI writes the same facts to `.oddlings/builds.jsonl` from
 * the other end.
 *
 * So the panel shows both, and is honest about the difference: a row read from
 * disk is a record of a build, not a copy of it, and there is nothing to
 * restore. Split out of the panel because "which rows, in what order, without
 * showing the same build twice" is a rule with a right answer and no need of a
 * browser to check it.
 */
import type { BuildEntry } from './reducer';
import type { BuildRow } from '@/node/studio-api';

export type { BuildRow };

export type MergedBuild =
  /** A build this tab saw: restorable, because the document is still here. */
  | { kind: 'live'; at: string; index: number; entry: BuildEntry }
  /** A build from the log on disk: a record, with no document behind it. */
  | { kind: 'disk'; at: string; row: BuildRow };

/**
 * How far apart two records of one build may be timed and still be one build.
 *
 * The first payload the studio follows *is* the CLI's last write, and the two
 * sides stamp it independently — the CLI when it finished, the pointer when it
 * was written, the studio's fallback when it parsed. A couple of seconds of
 * slack is what stops that showing as two rows saying the same thing.
 */
const SAME_BUILD_MS = 2000;

const stamp = (at: string) => Date.parse(at);

/**
 * The rows the panel draws, newest first.
 *
 * Disk rows the live log already accounts for are dropped rather than the
 * other way round: the live row is the one you can click.
 */
export function mergeBuilds(
  live: BuildEntry[],
  disk: BuildRow[],
): MergedBuild[] {
  const seen = live
    .map((entry) => stamp(entry.at))
    .filter((at) => !Number.isNaN(at));
  const rows: MergedBuild[] = live.map((entry, index) => ({
    kind: 'live',
    at: entry.at,
    index,
    entry,
  }));
  for (const row of disk) {
    const at = stamp(row.at);
    if (
      !Number.isNaN(at) &&
      seen.some((mine) => Math.abs(mine - at) <= SAME_BUILD_MS)
    )
      continue;
    rows.push({ kind: 'disk', at: row.at, row });
  }
  // Newest first. An unparsable stamp sorts to the bottom rather than
  // scattering the list, because `NaN` compares false against everything.
  rows.sort((a, b) => (stamp(b.at) || 0) - (stamp(a.at) || 0));
  return rows;
}

/** The triangle count a row knows, or null while nothing has measured it. */
export function trisOf(row: MergedBuild): number | null {
  return row.kind === 'live' ? (row.entry.tris ?? null) : row.row.tris;
}

/**
 * A polyline through a series, oldest on the left, in an `svg` viewBox.
 *
 * Flat rather than fitted to the data's own range at the bottom: a series that
 * never changes should read as a flat line, not as noise stretched to fill the
 * box. Returns an empty string for anything too short to be a line.
 */
export function sparkPoints(
  values: number[],
  width: number,
  height: number,
): string {
  if (values.length < 2) return '';
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      // A flat series sits on the middle line, where a reader can see it is
      // flat rather than wonder whether it is pinned to an edge.
      const y = span
        ? height - ((value - low) / span) * height
        : height / 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
