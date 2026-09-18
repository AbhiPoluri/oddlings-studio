import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addNote,
  emptyNotes,
  loadNotes,
  openNotes,
  resolveNote,
  reviewPathFor,
  saveNotes,
} from '../lib/review-notes';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-notes-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('path mapping', () => {
  test('a spec file maps to a review file beside it', () => {
    expect(reviewPathFor('specs/wizard.spec.json')).toBe(
      'specs/wizard.review.json',
    );
  });

  test('the plain .json spelling maps to the same place', () => {
    // The two spellings are one asset. Splitting them would strand a
    // reviewer's note the first time someone renamed a file.
    expect(reviewPathFor('specs/wizard.json')).toBe('specs/wizard.review.json');
  });

  test('a path with directories and dots in it survives', () => {
    expect(reviewPathFor('/a/b.c/drafts/kaiju-v2.spec.json')).toBe(
      '/a/b.c/drafts/kaiju-v2.review.json',
    );
  });
});

describe('round trip', () => {
  test('notes written are read back unchanged', async () => {
    const spec = join(scratch, 'trip.spec.json');
    const written = addNote(
      addNote(emptyNotes(spec), {
        text: 'the hat is too small',
        part: [3, 1],
        partName: 'hat',
        by: 'human',
      }),
      { text: 'and the staff floats' },
    );
    const path = await saveNotes(spec, written);
    expect(path).toBe(reviewPathFor(spec));

    const read = await loadNotes(spec);
    expect(read.version).toBe(1);
    expect(read.notes).toHaveLength(2);
    expect(read.notes[0].text).toBe('the hat is too small');
    expect(read.notes[0].part).toEqual([3, 1]);
    expect(read.notes[0].partName).toBe('hat');
    expect(read.notes[0].by).toBe('human');
    expect(read.notes[0].status).toBe('open');
    expect(read.notes[0].resolvedAt).toBeNull();
    // A note the agent wrote itself defaults to `agent`.
    expect(read.notes[1].by).toBe('agent');
    expect(new Set(read.notes.map((note) => note.id)).size).toBe(2);
  });

  test('a spec with no review file has no notes, which is not an error', async () => {
    const read = await loadNotes(join(scratch, 'never-reviewed.spec.json'));
    expect(read.notes).toEqual([]);
    expect(read.version).toBe(1);
  });

  test('a review file that is not a review file is refused', async () => {
    const spec = join(scratch, 'broken.spec.json');
    await writeFile(reviewPathFor(spec), JSON.stringify({ notes: 'lots' }));
    // Reporting "no notes" here would tell an agent the reviewer had nothing
    // to say, which is the one wrong answer.
    await expect(loadNotes(spec)).rejects.toThrow(/not a valid review file/);
  });

  test('the file on disk is the documented shape', async () => {
    const spec = join(scratch, 'shape.spec.json');
    await saveNotes(spec, addNote(emptyNotes(spec), { text: 'fix the feet' }));
    const raw = JSON.parse(await readFile(reviewPathFor(spec), 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['notes', 'spec', 'version']);
    expect(Object.keys(raw.notes[0]).sort()).toEqual([
      'at',
      'by',
      'id',
      'part',
      'partName',
      'reply',
      'resolvedAt',
      'status',
      'text',
    ]);
  });
});

describe('resolving', () => {
  const withNote = () =>
    addNote(emptyNotes('x.spec.json'), { text: 'too grey', by: 'human' });

  test('resolving closes the note and records the reply', () => {
    const notes = withNote();
    const id = notes.notes[0].id;
    const after = resolveNote(notes, id, 'warmed the palette');
    expect(after.notes[0].status).toBe('resolved');
    expect(after.notes[0].reply).toBe('warmed the palette');
    expect(after.notes[0].resolvedAt).not.toBeNull();
    expect(openNotes(after)).toHaveLength(0);
    // Immutable: the caller's copy is untouched.
    expect(notes.notes[0].status).toBe('open');
  });

  test('a note may be closed without a reply, and keeps a null one', () => {
    const notes = withNote();
    const after = resolveNote(notes, notes.notes[0].id);
    expect(after.notes[0].status).toBe('resolved');
    expect(after.notes[0].reply).toBeNull();
  });

  test('an unknown id is refused, listing the ids that exist', () => {
    const notes = withNote();
    expect(() => resolveNote(notes, 'nope')).toThrow(
      new RegExp(`No review note has id "nope".*${notes.notes[0].id}`),
    );
  });

  test('resolving survives a save and a load', async () => {
    const spec = join(scratch, 'resolved.spec.json');
    const notes = addNote(emptyNotes(spec), { text: 'shorten the tail' });
    await saveNotes(spec, notes);
    const loaded = await loadNotes(spec);
    await saveNotes(spec, resolveNote(loaded, loaded.notes[0].id, 'done'));
    const again = await loadNotes(spec);
    expect(openNotes(again)).toHaveLength(0);
    expect(again.notes[0].reply).toBe('done');
  });
});
