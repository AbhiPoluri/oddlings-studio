'use client';
/**
 * What the reviewer has to say, and what the agent said back.
 *
 * Save writes a correction; this is for the corrections a person cannot make by
 * dragging a gizmo — "this arm reads as a wing", "the seam is on the side you
 * see first". Every note names a part, so the agent gets a path rather than a
 * description of where to look, and clicking one here puts that part on screen.
 *
 * Open notes sit above resolved ones because an open note is work and a
 * resolved one is history. Nothing here has a Save button: the file is written
 * a moment after every change, which is the only behaviour that does not lose
 * a sentence somebody typed and then clicked away from.
 */
import { useState } from 'react';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import { pathKey, type Path, type Selection } from '@/lib/spec-edit';
import {
  countOpen,
  newNote,
  noteId,
  setStatus,
  removeNote,
  sortNotes,
  targetOf,
} from './notes';
import type { Notes, SaveState } from './use-notes';
import { RowSkeleton } from './loading';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'saved',
  unsaved: 'unsaved',
  saving: 'saving…',
  failed: 'not saved',
};

const time = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export function NotesPanel({
  notes: store,
  selection,
  labels,
  onFrame,
}: {
  notes: Notes;
  /** What a new note would be attached to. */
  selection: Selection;
  /** Part path keys to readable names, the same map the findings panel takes. */
  labels?: Map<string, string>;
  /** Select a part and fit the camera to it, as the findings rows do. */
  onFrame?: (path: Path) => void;
}) {
  const [draft, setDraft] = useState('');

  if (!store.path)
    return (
      <p className="panel-empty help">
        Notes are written beside the spec file they are about, as{' '}
        <code>specs/…/name.review.json</code>. This document has no file — open
        a project from the left, or follow a build, and the notes for that file
        appear here.
      </p>
    );

  // The file has not answered yet — not the same as having answered with no
  // notes, which is the line below this panel's list.
  if (!store.loaded) return <RowSkeleton rows={3} />;

  const target = targetOf(selection, labels);
  const shown = sortNotes(store.notes);
  const open = countOpen(store.notes);

  function write() {
    const text = draft.trim();
    if (!text) return;
    store.add(
      newNote({
        id: noteId(),
        part: target.part,
        partName: target.partName,
        text,
        at: new Date().toISOString(),
      }),
    );
    setDraft('');
  }

  return (
    <div className="notes">
      <div className="notes-head">
        <span className="notes-count">
          {open ? `${open} open` : 'nothing open'}
          {store.notes.length > open ? ` · ${store.notes.length - open} resolved` : ''}
        </span>
        <span className="notes-save" data-state={store.state}>
          {SAVE_LABEL[store.state]}
        </span>
      </div>

      <div className="notes-compose">
        <textarea
          className="notes-input"
          rows={2}
          spellCheck={false}
          value={draft}
          placeholder={
            target.part
              ? `A note on ${target.partName ?? pathKey(target.part)}…`
              : 'A note on this asset…'
          }
          aria-label="Write a note"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // ⌘⏎ rather than plain Enter: a note is a sentence or two, and a
            // box that submits on Return cannot hold the second one.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              write();
            }
          }}
        />
        <div className="notes-compose-row">
          <span className="notes-target help">
            {target.part
              ? `on ${target.partName ?? 'part'} (${pathKey(target.part)})`
              : 'on the whole asset — select a part to pin it to one'}
          </span>
          <button
            type="button"
            className="bar-button primary"
            disabled={!draft.trim()}
            title="Add note (⌘⏎)"
            onClick={write}
          >
            Add note
          </button>
        </div>
      </div>

      {store.loaded && !shown.length && (
        <p className="panel-empty help">
          No notes on this spec yet. Select a part, write what is wrong with it,
          and the agent reads it from the review file next to the spec.
        </p>
      )}

      <div className="notes-list" role="list">
        {shown.map((note) => (
          <article
            key={note.id}
            role="listitem"
            className="note"
            data-status={note.status}
          >
            <p className="note-text">{note.text}</p>
            <div className="note-meta">
              {note.part ? (
                <button
                  type="button"
                  className="note-part"
                  title={`Select and frame ${pathKey(note.part)}`}
                  onClick={() => onFrame?.(note.part!)}
                >
                  {labels?.get(pathKey(note.part)) ??
                    note.partName ??
                    pathKey(note.part)}
                </button>
              ) : (
                <span className="note-part note-part-asset">whole asset</span>
              )}
              {/* A drawn note carries its own line in the viewport; saying
                  which gesture it was is what connects the two. */}
              {note.mark && (
                <span className="note-mark" title="Drawn in the viewport">
                  {note.mark.gesture}
                </span>
              )}
              <time className="note-time" dateTime={note.at}>
                {time(note.at)}
              </time>
              {note.by === 'agent' && <span className="note-by">agent</span>}
              <span className="note-actions">
                {note.status === 'open' ? (
                  <button
                    type="button"
                    className="icon-button"
                    title="Mark resolved"
                    aria-label="Mark resolved"
                    onClick={() =>
                      store.replace(
                        setStatus(
                          store.notes,
                          note.id,
                          'resolved',
                          new Date().toISOString(),
                        ),
                      )
                    }
                  >
                    <Check size={12} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    title="Reopen"
                    aria-label="Reopen"
                    onClick={() =>
                      store.replace(
                        setStatus(
                          store.notes,
                          note.id,
                          'open',
                          new Date().toISOString(),
                        ),
                      )
                    }
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  title="Delete this note"
                  aria-label="Delete this note"
                  onClick={() => store.replace(removeNote(store.notes, note.id))}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </span>
            </div>
            {note.reply && <p className="note-reply">{note.reply}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}
