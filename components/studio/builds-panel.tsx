'use client';
/**
 * Every version of this asset, from both logs.
 *
 * A review tool needs an answer to "what did it look like before that build" —
 * without one, an agent that makes things worse has quietly destroyed the only
 * copy of the thing that was working. Each row this tab saw holds its whole
 * document, so clicking one puts it back on screen as a new history entry
 * rather than as a rewind: the builds after it are still in the log.
 *
 * The rows above those come from `.oddlings/builds.jsonl`, which the CLI
 * appends to on every build and audit. They are a record and not a copy —
 * there is no document behind a line in a file — so they are drawn quieter and
 * cannot be clicked. What they are for is the question the in-memory log cannot
 * answer: how many times has this been rebuilt, and has the triangle count been
 * climbing all afternoon.
 */
import { useEffect, useState } from 'react';
import { runCommand, type ActionContext } from './actions';
import { mergeBuilds, sparkPoints, trisOf, type BuildRow } from './builds';
import { RowSkeleton } from './loading';
import { ghostDoc } from './reducer';
import { useStudio } from './store';

export const BUILDS_ROUTE = '/__oddlings/builds';

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
};

/** The width and height the sparkline is drawn in, in its own viewBox units. */
const SPARK = { width: 88, height: 14 } as const;

export function BuildsPanel({ context }: { context: ActionContext }) {
  const { state, dispatch } = useStudio();
  const [disk, setDisk] = useState<BuildRow[]>([]);
  /** False until the log on disk has answered, which is a different thing from
      it answering with nothing. */
  const [read, setRead] = useState(false);
  const source = state.follow.source;
  const lastBuildAt = state.follow.lastBuildAt;

  // Re-read when the followed file changes and after every build, which is
  // exactly when a line has been appended. No poll: this panel is only mounted
  // while somebody is looking at it, and a build is already an event here.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const query = source
          ? `?path=${encodeURIComponent(source.replace(/^\//, ''))}&limit=50`
          : '?limit=50';
        const response = await fetch(`${BUILDS_ROUTE}${query}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw Error(String(response.status));
        const body = (await response.json()) as { builds?: BuildRow[] };
        if (live) {
          setDisk(Array.isArray(body.builds) ? body.builds : []);
          setRead(true);
        }
      } catch {
        // The log is the CLI's to write and the route is the dev server's to
        // serve; without either, this is the in-memory log it always was.
        if (live) {
          setDisk([]);
          setRead(true);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [source, lastBuildAt]);

  const rows = mergeBuilds(state.builds, disk);
  const ghost = ghostDoc(state);
  // Oldest on the left, and only from rows that have been measured — a row
  // whose count is still unknown would read as a drop to zero.
  const series = [...rows]
    .reverse()
    .map(trisOf)
    .filter((tris): tris is number => typeof tris === 'number' && tris > 0);
  const spark = sparkPoints(series, SPARK.width, SPARK.height);

  return (
    <div className="builds-panel">
      <div className="builds-bar">
        <button
          type="button"
          className="bar-button"
          aria-pressed={state.overlays.compare}
          disabled={!ghost}
          title={
            ghost
              ? 'Ghost the previous agent build behind this one (C)'
              : 'Nothing to compare against until a second build lands'
          }
          onClick={() => runCommand('view.compare', context)}
        >
          Compare
        </button>
        {spark && (
          <svg
            className="builds-spark"
            viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Triangle count over ${series.length} builds, ${series.at(0)?.toLocaleString()} to ${series.at(-1)?.toLocaleString()}`}
          >
            <polyline points={spark} />
          </svg>
        )}
        <span className="builds-summary help">
          {rows.length
            ? `${rows.length} build${rows.length === 1 ? '' : 's'}${
                disk.length ? ` · ${disk.length} from the log` : ''
              }`
            : ''}
        </span>
      </div>

      {!rows.length && !read ? (
        <RowSkeleton rows={4} />
      ) : !rows.length ? (
        <p className="panel-empty help">
          No builds yet. Run <code>oddlings build</code> or{' '}
          <code>oddlings audit</code> and each one is logged here, and in{' '}
          <code>.oddlings/builds.jsonl</code> between sessions.
        </p>
      ) : (
        <div className="builds" role="list">
          {rows.map((row) =>
            row.kind === 'live' ? (
              <button
                type="button"
                role="listitem"
                key={`live-${row.index}-${row.at}`}
                className="builds-row"
                data-current={row.entry.doc === state.doc ? 'true' : undefined}
                title="Put this version back on screen"
                onClick={() =>
                  dispatch({ type: 'restoreBuild', index: row.index })
                }
              >
                <time className="builds-time" dateTime={row.at}>
                  {time(row.at)}
                </time>
                <strong className="builds-name">{row.entry.name}</strong>
                <span className="builds-tris tabular">
                  {row.entry.tris ? `${row.entry.tris.toLocaleString()} tris` : ''}
                </span>
                <span
                  className="builds-check"
                  data-ok={
                    row.entry.ok === undefined ? undefined : String(row.entry.ok)
                  }
                >
                  {row.entry.ok === undefined ? '' : row.entry.ok ? 'pass' : 'fail'}
                </span>
                <span className="builds-origin">
                  {row.entry.origin === 'agent' ? 'agent' : 'you (saved)'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                role="listitem"
                key={`disk-${row.at}-${row.row.source}`}
                className="builds-row"
                data-disk="true"
                disabled
                title="From the build log. This studio never held this version, so there is nothing to restore."
              >
                <time className="builds-time" dateTime={row.at}>
                  {time(row.at)}
                </time>
                <strong className="builds-name">{row.row.name}</strong>
                <span className="builds-tris tabular">
                  {row.row.tris ? `${row.row.tris.toLocaleString()} tris` : ''}
                </span>
                <span className="builds-check" data-ok={String(row.row.ok)}>
                  {row.row.ok ? 'pass' : 'fail'}
                </span>
                <span className="builds-origin">logged</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
