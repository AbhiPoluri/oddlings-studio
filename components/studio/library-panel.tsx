'use client';
/**
 * Generator variations kept in this browser.
 *
 * Recipes only, as before: a recipe is a few dozen numbers, and a spec is the
 * file an agent owns — saving one here would make a second copy nobody is
 * following. The Save button in the top bar is what a spec gets instead.
 */
import { Box, Plus, Trash2, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { fileName } from '@/lib/asset-recipe';
import type { Saved } from './reducer';
import { persistLibrary, useStudio } from './store';
import { useDocument } from './use-document';

const LIMIT = 40;

export function LibraryPanel({ capture }: { capture: () => string }) {
  const { state, dispatch } = useStudio();
  const { editRecipe, status } = useDocument();
  const removed = useRef<Saved | null>(null);
  const [canRestore, setCanRestore] = useState(false);

  function write(items: Saved[]) {
    if (!persistLibrary(items)) {
      status('Device storage is full. Export a recipe to keep this asset.');
      return false;
    }
    dispatch({ type: 'library', items });
    return true;
  }

  /** The thumbnail is best effort: a variation with no picture is still a save. */
  function save() {
    if (state.doc.spec)
      return status(
        'The library keeps generator recipes. Save writes a spec back to its file.',
      );
    if (state.library.length >= LIMIT)
      return status('Library full. Remove a variation or export it instead.');
    const recipe = { ...state.doc.recipe };
    let shot = '';
    try {
      shot = capture();
    } catch {
      shot = '';
    }
    const add = (thumbnail: string) => {
      if (write([{ id: crypto.randomUUID(), recipe, thumbnail }, ...state.library]))
        status(`Saved “${recipe.name}” to this browser.`);
    };
    if (!shot) return add('');
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 90;
      canvas.getContext('2d')?.drawImage(image, 0, 0, 120, 90);
      add(canvas.toDataURL('image/png'));
    };
    image.onerror = () => add('');
    image.src = shot;
  }

  return (
    <div className="library-panel">
      <div className="panel-actions">
        <button className="row-button" onClick={save} disabled={Boolean(state.doc.spec)}>
          <Plus size={12} /> Save current
        </button>
        {canRestore && (
          <button
            className="row-button"
            onClick={() => {
              const back = removed.current;
              if (!back || state.library.length >= LIMIT) return;
              if (write([back, ...state.library.filter((s) => s.id !== back.id)])) {
                setCanRestore(false);
                status('Variation restored.');
              }
            }}
          >
            <Undo2 size={12} /> Undo remove
          </button>
        )}
        <span className="panel-count">{state.library.length}</span>
      </div>
      {state.library.length === 0 ? (
        <p className="panel-empty help">
          No saved variations. Generate a blueprint and save it to keep it here.
        </p>
      ) : (
        <div className="library-rows">
          {state.library.map((entry) => (
            <div className="library-row" key={entry.id}>
              <button
                className="library-open"
                onClick={() => {
                  editRecipe(entry.recipe);
                  status(`Loaded ${entry.recipe.name}.`);
                }}
              >
                {entry.thumbnail ? (
                  <img src={entry.thumbnail} alt="" />
                ) : (
                  <Box size={16} aria-hidden="true" />
                )}
                <strong>{entry.recipe.name}</strong>
                <span>{fileName(entry.recipe.kind)}</span>
              </button>
              <button
                className="library-remove"
                aria-label={`Remove ${entry.recipe.name}`}
                onClick={() => {
                  if (write(state.library.filter((s) => s.id !== entry.id))) {
                    removed.current = entry;
                    setCanRestore(true);
                    status('Variation removed. Undo remove brings it back.');
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
