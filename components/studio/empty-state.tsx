'use client';
/**
 * What the viewport says when it has nothing to show.
 *
 * The studio's default is to follow whatever the CLI built last, which is the
 * right default and leaves one case unexplained: a fresh clone, or a `?spec=`
 * pointed at a file that is not there. The old answer was an empty grey stage
 * and a status line nobody reads, which tells a first-time user that the tool
 * is broken rather than that it is waiting.
 *
 * So it says the three things that would start it — open a project, drop a
 * file, run the CLI — and then makes the first of them one click, because the
 * specs folder already knows what the three most recent files are.
 */
import { FileJson } from 'lucide-react';
import type { ActionContext } from './actions';
import { useStudio } from './store';

export function EmptyState({ context }: { context: ActionContext }) {
  const { state } = useStudio();
  // The listing arrives newest first, which is the order a person wants here.
  const recent = (state.specs ?? []).filter((row) => !row.broken).slice(0, 3);

  return (
    <div className="viewport-empty">
      <div className="viewport-empty-card">
        <h2>Nothing loaded</h2>
        <p>
          Open a project from the left, drop a spec here, or run{' '}
          <code>npx tsx cli/oddlings.ts audit specs/&lt;name&gt;.spec.json</code>{' '}
          — the studio follows whatever the CLI last built.
        </p>
        {recent.length > 0 && (
          <div className="viewport-empty-recent">
            {recent.map((row) => (
              <button
                key={row.path}
                type="button"
                className="bar-button"
                title={`Open ${row.path}`}
                onClick={() => context.openSpec(row.path)}
              >
                <FileJson size={12} aria-hidden="true" />
                {row.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
