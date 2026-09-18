import '../lib/node-shims';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotesPanel } from '../components/studio/notes-panel';
import {
  countOpen,
  newNote,
  openCounts,
  removeNote,
  setStatus,
  sortNotes,
  targetOf,
  type ReviewNote,
} from '../components/studio/notes';
import { describeHint, planHint } from '../components/studio/hints';
import { parseSpec, type AssetSpec, type Part } from '../lib/asset-spec';
import { partAt, updatePart } from '../lib/spec-edit';
import type { Notes } from '../components/studio/use-notes';

/**
 * The human half of the review loop.
 *
 * The rules — what a new note is attached to, what order they read in, which
 * rows carry a badge — are pure functions over a list, so they are asserted as
 * such. The panel is checked the way the others are, as markup: whether a
 * document with no file says so, and whether a resolved note carries the
 * agent's reply.
 */

const noop = () => {};

function fixture(file: string): AssetSpec {
  return parseSpec(JSON.parse(readFileSync(`specs/${file}`, 'utf8')));
}

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'n1',
  part: [0],
  partName: 'body',
  text: 'The barrel floats.',
  status: 'open',
  by: 'human',
  at: '2026-09-18T00:00:00.000Z',
  resolvedAt: null,
  reply: null,
  ...over,
});

/** The hook's shape, without the hook: the panel only reads and calls. */
function store(over: Partial<Notes> = {}): Notes {
  return {
    path: 'specs/sniper-rifle.spec.json',
    notes: [],
    state: 'saved',
    loaded: true,
    add: noop,
    replace: noop,
    ...over,
  };
}

describe('what a note is about', () => {
  test('a selected part, with the name it had when it was written', () => {
    const target = targetOf(
      { kind: 'part', path: [11, 0] },
      new Map([['11.0', 'leaf-core']]),
    );
    expect(target).toEqual({ part: [11, 0], partName: 'leaf-core' });
  });

  test('a bone has no path the agent could act on, so the note is asset-level', () => {
    expect(targetOf({ kind: 'bone', name: 'Head' })).toEqual({
      part: null,
      partName: null,
    });
    expect(targetOf(null)).toEqual({ part: null, partName: null });
  });

  test('a new note is open, human, and holds a copy of the path', () => {
    const path = [2, 1];
    const made = newNote({
      id: 'n9',
      part: path,
      partName: 'hat',
      text: '  too small  ',
      at: '2026-09-18T01:00:00.000Z',
    });
    expect(made.status).toBe('open');
    expect(made.by).toBe('human');
    expect(made.reply).toBeNull();
    expect(made.text).toBe('too small');
    // A copy, so editing the selection afterwards cannot rewrite the note.
    path.push(7);
    expect(made.part).toEqual([2, 1]);
  });
});

describe('ordering and counting', () => {
  const notes = [
    note({ id: 'old-open', at: '2026-09-18T00:00:01.000Z' }),
    note({ id: 'done', status: 'resolved', at: '2026-09-18T00:00:09.000Z' }),
    note({ id: 'new-open', at: '2026-09-18T00:00:05.000Z' }),
  ];

  test('open before resolved, newest first inside each', () => {
    expect(sortNotes(notes).map((row) => row.id)).toEqual([
      'new-open',
      'old-open',
      'done',
    ]);
    // Sorting never mutates the list the hook is about to write to a file.
    expect(notes.map((row) => row.id)).toEqual(['old-open', 'done', 'new-open']);
  });

  test('the badge counts open notes per part, and nothing else', () => {
    const counts = openCounts([
      note({ id: 'a', part: [11, 0] }),
      note({ id: 'b', part: [11, 0] }),
      note({ id: 'c', part: [9] }),
      note({ id: 'd', part: [9], status: 'resolved' }),
      note({ id: 'e', part: null }),
    ]);
    expect([...counts]).toEqual([
      ['11.0', 2],
      ['9', 1],
    ]);
    expect(countOpen(notes)).toBe(2);
  });
});

describe('resolving and reopening', () => {
  test('resolving stamps the time and leaves every other note alone', () => {
    const before = [note({ id: 'a' }), note({ id: 'b' })];
    const after = setStatus(before, 'a', 'resolved', '2026-09-18T02:00:00.000Z');
    expect(after[0].status).toBe('resolved');
    expect(after[0].resolvedAt).toBe('2026-09-18T02:00:00.000Z');
    expect(after[1]).toBe(before[1]);
  });

  test('reopening clears the stamp but keeps what the agent said', () => {
    const answered = [
      note({ id: 'a', status: 'resolved', resolvedAt: 'x', reply: 'Lowered it 3 cm.' }),
    ];
    const again = setStatus(answered, 'a', 'open', '2026-09-18T03:00:00.000Z');
    expect(again[0].status).toBe('open');
    expect(again[0].resolvedAt).toBeNull();
    // The reply is why it is being reopened; deleting it would lose the half
    // of the exchange that explains the other half.
    expect(again[0].reply).toBe('Lowered it 3 cm.');
  });

  test('deleting takes one note and no others', () => {
    expect(removeNote([note({ id: 'a' }), note({ id: 'b' })], 'a')).toHaveLength(1);
  });
});

describe('NotesPanel', () => {
  test('a document with no file explains why there is nowhere to put a note', () => {
    const html = renderToStaticMarkup(
      h(NotesPanel, { notes: store({ path: null }), selection: null }),
    );
    expect(html).toContain('review.json');
    expect(html).not.toContain('Add note');
  });

  test('draws open notes above resolved, with the reply under the question', () => {
    const html = renderToStaticMarkup(
      h(NotesPanel, {
        notes: store({
          notes: [
            note({
              id: 'done',
              text: 'The scope is crooked.',
              status: 'resolved',
              at: '2026-09-18T00:00:09.000Z',
              reply: 'Straightened it.',
            }),
            note({ id: 'open', text: 'The barrel floats.' }),
          ],
        }),
        selection: { kind: 'part', path: [0] },
        labels: new Map([['0', 'body']]),
      }),
    );
    expect(html.indexOf('The barrel floats.')).toBeLessThan(
      html.indexOf('The scope is crooked.'),
    );
    expect(html).toContain('data-status="resolved"');
    expect(html).toContain('Straightened it.');
    expect(html).toContain('1 open');
    // The compose box says what a new note would land on.
    expect(html).toContain('on body');
  });

  test('says when the file has not been written yet', () => {
    const html = renderToStaticMarkup(
      h(NotesPanel, {
        notes: store({ state: 'unsaved' }),
        selection: null,
      }),
    );
    expect(html).toContain('data-state="unsaved"');
  });
});

describe('fix hints', () => {
  const rifle = fixture('sniper-rifle.spec.json');
  /** Codes the audit really emits, because what `grow` means depends on one. */
  const FLOAT = 'detached-part';
  const SHELL = 'detached-shell';

  test('describes a move the way a person would say it', () => {
    expect(
      describeHint({ code: FLOAT, hint: { move: [0, -0.03, 0], toward: 'hull' } }),
    ).toBe('move [0, −0.03, 0] toward hull');
    expect(describeHint({ code: FLOAT, hint: {} })).toBe('');
    expect(describeHint({ code: FLOAT })).toBe('');
  });

  test('a blend hint is a setting to raise, not a size to scale', () => {
    // `detached-shell` is the only check that carries `grow`, and what it
    // carries is the `surface.blend` that would fuse the pieces. Reading it as
    // a multiplier would shrink the part to a twenty-fifth of its size.
    expect(describeHint({ code: SHELL, hint: { grow: 0.04, toward: 'body' } })).toBe(
      'raise blend to 0.04 toward body',
    );
    const plan = planHint(
      { code: SHELL, hint: { grow: 0.04 } },
      { shape: 'box', size: [1, 1, 1] },
    )!;
    expect(plan.blend).toBe(0.04);
    expect(plan.patch).toBeUndefined();
  });

  test('a grow on any other check is the multiplier the studio reads it as', () => {
    expect(describeHint({ code: 'thin-part', hint: { grow: 1.2 } })).toBe(
      'grow ×1.2',
    );
    expect(
      planHint({ code: 'thin-part', hint: { grow: 1.5 } }, {
        shape: 'box',
        size: [1, 2, 4],
      })!.patch,
    ).toEqual({ size: [1.5, 3, 6] });
    const limb: Part = {
      shape: 'limb',
      from: [0, 0, 0],
      to: [0, 1, 0],
      radius: 0.2,
    };
    expect(planHint({ code: 'thin-part', hint: { grow: 2 } }, limb)!.patch).toEqual({
      radius: 0.4,
    });
  });

  test('moves an ordinary part by its position, rounded to something readable', () => {
    const path = [0];
    const part = partAt(rifle, path)!;
    const patch = planHint(
      { code: FLOAT, hint: { move: [0, -0.033333333, 0] } },
      part,
    )!.patch!;
    expect(patch.position).toEqual([
      part.position?.[0] ?? 0,
      Math.round(((part.position?.[1] ?? 0) - 0.033333333) * 10_000) / 10_000,
      part.position?.[2] ?? 0,
    ]);
    // And it is a patch the real editor accepts, which is the claim that
    // matters: an Apply button that produces an unparsable spec is worse than
    // no button.
    expect(() => updatePart(rifle, path, patch)).not.toThrow();
  });

  test('moves a limb by both ends, because it has no position to move', () => {
    const limb: Part = {
      shape: 'limb',
      from: [0, 0, 0],
      to: [0, 1, 0],
      radius: 0.1,
    };
    const patch = planHint({ code: FLOAT, hint: { move: [0.5, 0, 0] } }, limb)!.patch!;
    expect(patch.from).toEqual([0.5, 0, 0]);
    expect(patch.to).toEqual([0.5, 1, 0]);
    expect(patch.position).toBeUndefined();
  });

  test('a hint that asks for nothing produces no edit', () => {
    const box: Part = { shape: 'box', size: [1, 1, 1] };
    expect(planHint({ code: FLOAT }, box)).toBeNull();
    expect(planHint({ code: FLOAT, hint: { move: [0, 0, 0] } }, box)).toBeNull();
    expect(planHint({ code: 'thin-part', hint: { grow: 1 } }, box)).toBeNull();
    expect(planHint({ code: FLOAT, hint: { move: [1, 0, 0] } }, undefined)).toBeNull();
  });
});
