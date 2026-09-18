import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Notes a human leaves on an asset, for the agent that authored it.
 *
 * Everything else in this project runs one way: an agent writes a spec, the
 * numbers come back, the agent iterates. The one thing that could not get in
 * was the reviewer — someone looking at the model in the studio could see the
 * hat was too small and had no way to say so. A note is that channel, and it
 * is a file rather than a message because both ends work on files: the studio
 * writes one when a reviewer pins a comment to a part, the agent reads it on
 * the next audit, fixes it and resolves it with a reply.
 *
 * The file lives beside the spec (`foo.spec.json` → `foo.review.json`) so it
 * travels with it, survives a rebuild, and needs no index anywhere.
 *
 * The format is a contract shared with the studio's API. Fields are added, not
 * repurposed, and a reader ignores what it does not know.
 */

export const noteSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** The part the note is about, as a spec path. `null` for the whole asset. */
    part: z.array(z.number().int().min(0)).nullable(),
    /** The part's name when the note was written, so the note still reads
     *  sensibly after the path moves underneath it. */
    partName: z.string().nullable(),
    text: z.string().min(1),
    status: z.enum(['open', 'resolved']),
    by: z.enum(['human', 'agent']),
    at: z.string(),
    resolvedAt: z.string().nullable(),
    /** What the agent did about it. The half that makes this a conversation. */
    reply: z.string().nullable(),
  })
  .strict();

export const reviewSchema = z
  .object({
    version: z.literal(1),
    /** The spec these notes are about, relative to the working directory. */
    spec: z.string(),
    notes: z.array(noteSchema),
  })
  .strict();

export type ReviewNote = z.infer<typeof noteSchema>;
export type ReviewNotes = z.infer<typeof reviewSchema>;

/**
 * Where a spec's notes live.
 *
 * Both `foo.spec.json` and `foo.json` land on `foo.review.json`, because the
 * two spellings are the same asset and splitting them would leave a reviewer's
 * note stranded the first time someone renamed a file.
 */
export function reviewPathFor(specPath: string) {
  const stem = specPath.replace(/(\.spec)?\.json$/i, '');
  return `${stem}.review.json`;
}

/** The spec path as it is stored in the file: relative to the working directory. */
function specKey(specPath: string) {
  return relative(process.cwd(), resolve(specPath)) || specPath;
}

export function emptyNotes(specPath: string): ReviewNotes {
  return { version: 1, spec: specKey(specPath), notes: [] };
}

/**
 * Read a spec's notes. No file means no notes, which is not an error — every
 * asset starts without a reviewer and most never get one.
 *
 * A file that exists and does not parse IS an error: silently returning an
 * empty list would tell an agent the reviewer had nothing to say.
 */
export async function loadNotes(specPath: string): Promise<ReviewNotes> {
  const path = resolve(reviewPathFor(specPath));
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return emptyNotes(specPath);
  }
  const parsed = reviewSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw Error(
      `${reviewPathFor(specPath)} is not a valid review file: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

export async function saveNotes(
  specPath: string,
  notes: ReviewNotes,
): Promise<string> {
  const path = resolve(reviewPathFor(specPath));
  await mkdir(dirname(path), { recursive: true });
  // Validated on the way out as well as in: this file is read by another
  // process, and half-written notes are worse than none.
  const checked = reviewSchema.parse({ ...notes, spec: specKey(specPath) });
  await writeFile(path, `${JSON.stringify(checked, null, 2)}\n`);
  return path;
}

/** Enough entropy that two notes written in the same millisecond differ. */
function newId() {
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export type NewNote = {
  text: string;
  part?: number[] | null;
  partName?: string | null;
  by?: 'human' | 'agent';
};

/** Append a note. Immutable: the input document is not touched. */
export function addNote(notes: ReviewNotes, note: NewNote): ReviewNotes {
  return {
    ...notes,
    notes: [
      ...notes.notes,
      noteSchema.parse({
        id: newId(),
        part: note.part ?? null,
        partName: note.partName ?? null,
        text: note.text,
        status: 'open',
        by: note.by ?? 'agent',
        at: new Date().toISOString(),
        resolvedAt: null,
        reply: null,
      }),
    ],
  };
}

/**
 * Close a note, with a reply.
 *
 * An unknown id throws rather than passing quietly, because the only way to
 * reach this with a wrong id is an agent guessing at one — and an agent that
 * believes it has answered a note it never saw is the failure this whole file
 * exists to prevent.
 */
export function resolveNote(
  notes: ReviewNotes,
  id: string,
  reply?: string,
): ReviewNotes {
  if (!notes.notes.some((note) => note.id === id))
    throw Error(
      `No review note has id "${id}". Open notes: ${
        notes.notes
          .filter((note) => note.status === 'open')
          .map((note) => note.id)
          .join(', ') || '(none)'
      }.`,
    );
  return {
    ...notes,
    notes: notes.notes.map((note) =>
      note.id === id
        ? {
            ...note,
            status: 'resolved' as const,
            resolvedAt: new Date().toISOString(),
            reply: reply ?? note.reply,
          }
        : note,
    ),
  };
}

export function openNotes(notes: ReviewNotes) {
  return notes.notes.filter((note) => note.status === 'open');
}
