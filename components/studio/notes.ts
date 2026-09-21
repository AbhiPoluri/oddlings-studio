/**
 * Review notes, as pure functions over a list.
 *
 * A note is the half of the review loop that Save cannot carry. Save writes a
 * correction back, which says what the geometry should be; a note says what is
 * wrong and why, on a part, in words — "this arm reads as a wing", "the seam is
 * on the visible side" — and those are the corrections a reviewer cannot make
 * by dragging a gizmo. The agent reads them from `specs/foo.review.json`
 * through its own CLI, resolves them, and writes a reply back into the same
 * file.
 *
 * Split from the panel for the reason the reducer is split from the store: the
 * ordering rule, the badge counts and "what does adding a note to this
 * selection produce" are rules with right answers that no browser is needed to
 * check.
 */
import { pathKey, type Path, type Selection } from '@/lib/spec-edit';
import { describeMark, type DrawnMark, type Mark } from '@/lib/draw-marks';
import type { ReviewNote } from '@/node/studio-api';

export type { ReviewNote };

/**
 * A note's id.
 *
 * Only has to be unique inside one review file, and the CLI quotes it back
 * when it resolves one — so a readable stamp beats a UUID nobody can match up
 * against a line in a terminal. `randomUUID` is absent on insecure origins.
 */
let minted = 0;
export function noteId(): string {
  minted += 1;
  return `n${Date.now().toString(36)}${minted.toString(36)}`;
}

/** A note the studio is about to write. The id is the caller's, so this is pure. */
export function newNote(fields: {
  id: string;
  part: Path | null;
  partName: string | null;
  text: string;
  at: string;
  /** The stroke it was drawn as, for a note made with the Draw tool. */
  mark?: Mark;
}): ReviewNote {
  return {
    id: fields.id,
    part: fields.part ? [...fields.part] : null,
    partName: fields.partName,
    text: fields.text.trim(),
    status: 'open',
    by: 'human',
    at: fields.at,
    resolvedAt: null,
    reply: null,
    ...(fields.mark ? { mark: fields.mark } : null),
  };
}

/**
 * The note a finished stroke becomes.
 *
 * The label is optional because most marks do not need one — a ring round the
 * visor with "bigger" typed under it says as much as a paragraph would, and a
 * ring with nothing typed still says "look at this". An unlabelled mark takes
 * the shape's own description as its text, because `text` is the one field
 * every reader of a review file already knows how to show, and a note that
 * read as blank in the CLI would be a note nobody acted on.
 *
 * `part` is the first of the mark's parts so every existing reader — the
 * outliner badge, the panel's Select button, the agent's `note.part` — points
 * somewhere useful without being taught about marks.
 */
export function markNote(fields: {
  id: string;
  mark: Mark;
  text: string;
  at: string;
}): ReviewNote {
  const first = fields.mark.parts[0] ?? null;
  return newNote({
    id: fields.id,
    part: first?.path ?? null,
    partName: first?.name ?? null,
    text: fields.text.trim() || describeMark(fields.mark),
    at: fields.at,
    mark: fields.mark,
  });
}

/**
 * The marks the viewport should be drawing.
 *
 * Open notes only: resolving a note is the reviewer saying the matter is
 * closed, and a scribble that outlived its question is just something in the
 * way of the model.
 */
export function drawnMarks(notes: ReviewNote[]): DrawnMark[] {
  return notes
    .filter((note) => note.status === 'open' && note.mark)
    .map((note) => ({ ...note.mark!, id: note.id }));
}

/**
 * What a note written right now would be about.
 *
 * A bone is not an authored part and has no path the agent could act on, so a
 * note made with one selected is an asset-level note rather than a note on
 * something the spec cannot address.
 */
export function targetOf(
  selection: Selection,
  labels?: Map<string, string>,
): { part: Path | null; partName: string | null } {
  if (selection?.kind !== 'part') return { part: null, partName: null };
  return {
    part: selection.path,
    partName: labels?.get(pathKey(selection.path)) ?? null,
  };
}

const when = (note: ReviewNote) => Date.parse(note.at) || 0;

/**
 * Open notes first, newest first within each group.
 *
 * Open before resolved because an open note is work and a resolved one is
 * history — and a panel that sorted purely by time would bury the question you
 * asked a minute ago under the six the agent has just answered.
 */
export function sortNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return when(b) - when(a);
  });
}

/** How many open notes sit on each part path, for the outliner's badge. */
export function openCounts(notes: ReviewNote[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (note.status !== 'open' || !note.part?.length) continue;
    const key = pathKey(note.part);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function countOpen(notes: ReviewNote[]): number {
  return notes.filter((note) => note.status === 'open').length;
}

/** Mark one note answered, or put it back. Any other note is returned as it was. */
export function setStatus(
  notes: ReviewNote[],
  id: string,
  status: ReviewNote['status'],
  at: string,
): ReviewNote[] {
  return notes.map((note) =>
    note.id === id
      ? {
          ...note,
          status,
          // Reopening clears the stamp but keeps the reply: what the agent said
          // is why the note is being reopened, and deleting it would lose the
          // half of the exchange that explains the other half.
          resolvedAt: status === 'resolved' ? at : null,
        }
      : note,
  );
}

export function removeNote(notes: ReviewNote[], id: string): ReviewNote[] {
  return notes.filter((note) => note.id !== id);
}
