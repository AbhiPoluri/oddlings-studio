'use client';
/**
 * Every command the studio has, and the key that runs it.
 *
 * Read off the action registry rather than written out, for the reason the
 * registry exists at all: a hand-kept list of shortcuts is a list that is wrong
 * within a week. Adding a command to `actions.ts` adds it here, with its real
 * chord, in its own group — and a command whose key is removed loses its key
 * here too, rather than advertising one that no longer works.
 */
import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { COMMANDS } from './actions';
import { chordLabel } from './keymap';
import { useStudio } from './store';

/** Mac draws ⌘; everything else spells the modifiers out. */
function onApple(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
}

export function ShortcutsDialog() {
  const { state, dispatch } = useStudio();

  // Grouped in the order the groups first appear in the registry, which is the
  // order the file is written in: selection and camera before panels.
  const groups = useMemo(() => {
    const apple = onApple();
    const by = new Map<string, { label: string; keys: string; canvas: boolean }[]>();
    for (const command of COMMANDS) {
      const rows = by.get(command.group) ?? [];
      rows.push({
        label: command.label,
        keys: (command.keys ?? [])
          .map((chord) => chordLabel(chord, apple))
          .join(' or '),
        canvas: Boolean(command.canvasOwned),
      });
      by.set(command.group, rows);
    }
    return [...by];
  }, []);

  return (
    <Dialog
      open={state.modal === 'shortcuts'}
      onOpenChange={(open) => !open && dispatch({ type: 'modal', modal: null })}
    >
      <DialogContent className="studio-dialog shortcuts-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <p className="help">
          Anything without a key is still one press away through the command
          palette (⌘K). A key marked <i>canvas</i> belongs to the viewport while
          the viewport has focus, and to the whole window otherwise.
        </p>
        <div className="shortcuts-grid">
          {groups.map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {rows.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.keys ? <kbd>{row.keys}</kbd> : <span>⌘K</span>}
                      {row.canvas && row.keys && <i title="Answered by the viewport while it has focus">canvas</i>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
