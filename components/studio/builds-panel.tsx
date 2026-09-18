'use client';
/**
 * Every version this studio has been handed, newest first.
 *
 * A review tool needs an answer to "what did it look like before that build" —
 * without one, an agent that makes things worse has quietly destroyed the only
 * copy of the thing that was working. Each row holds its whole document, so
 * clicking one puts it back on screen as a new history entry rather than as a
 * rewind: the builds after it are still in the log.
 */
import { useStudio } from './store';

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
};

export function BuildsPanel() {
  const { state, dispatch } = useStudio();
  if (!state.builds.length)
    return (
      <p className="panel-empty help">
        No builds yet. Run <code>oddlings build</code> or <code>oddlings audit</code>{' '}
        and each one is logged here.
      </p>
    );

  return (
    <div className="builds" role="list">
      {state.builds
        .map((entry, index) => ({ entry, index }))
        .reverse()
        .map(({ entry, index }) => (
          <button
            type="button"
            role="listitem"
            key={`${entry.at}-${index}`}
            className="builds-row"
            data-current={entry.doc === state.doc ? 'true' : undefined}
            onClick={() => dispatch({ type: 'restoreBuild', index })}
          >
            <time className="builds-time" dateTime={entry.at}>
              {time(entry.at)}
            </time>
            <strong className="builds-name">{entry.name}</strong>
            <span className="builds-tris">
              {entry.tris ? `${entry.tris.toLocaleString()} tris` : ''}
            </span>
            <span
              className="builds-check"
              data-ok={entry.ok === undefined ? undefined : String(entry.ok)}
            >
              {entry.ok === undefined ? '' : entry.ok ? 'pass' : 'fail'}
            </span>
            <span className="builds-origin">
              {entry.origin === 'agent' ? 'agent' : 'you (saved)'}
            </span>
          </button>
        ))}
    </div>
  );
}
