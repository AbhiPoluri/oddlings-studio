import '../lib/node-shims';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseSpec, type AssetSpec } from '../lib/asset-spec';
import { updatePart } from '../lib/spec-edit';
import { initialRecipe } from '../lib/asset-recipe';
import { BIND_POSE } from '../components/timeline';
import {
  canRedo,
  canSave,
  canUndo,
  changedPaths,
  ghostDoc,
  initialState,
  isDirty,
  reducer,
  savePath,
  type BuildEntry,
  type Doc,
  type StudioAction,
  type StudioState,
} from '../components/studio/reducer';
import {
  mergeBuilds,
  sparkPoints,
  type BuildRow,
} from '../components/studio/builds';
import {
  COMMANDS,
  COMMAND_BY_ID,
  type ActionContext,
} from '../components/studio/actions';
import {
  chordOf,
  commandFor,
  keyConflicts,
} from '../components/studio/keymap';
import {
  DEFAULT_FILTERS,
  FILTER_KINDS,
  activeFilters,
  applyPreset,
  filterCount,
  filtersActive,
  matchingPreset,
  patchFilters,
  readFilters,
  type Filters,
} from '../components/studio/filters';

/**
 * The studio's rules, without a browser.
 *
 * Everything asserted here is a rule the old page enforced from inside event
 * handlers, where the only way to check it was to click: an edit detaches the
 * follow, a build that arrives after an edit is dropped, a clip change rewinds
 * the clock. They are the reason the reducer is a separate, React-free module.
 */

function fixture(file: string): AssetSpec {
  return parseSpec(JSON.parse(readFileSync(`specs/${file}`, 'utf8')));
}

const wizard = fixture('wizard.spec.json');
const rifle = fixture('sniper-rifle.spec.json');

const doc = (spec: AssetSpec | null, origin: Doc['origin'] = 'agent'): Doc => ({
  recipe: initialRecipe,
  spec,
  origin,
});

function run(state: StudioState, ...actions: StudioAction[]): StudioState {
  return actions.reduce(reducer, state);
}

/** A studio already following a file, with one agent build on screen. */
function following(spec = rifle, etag = 'w/"1"'): StudioState {
  return run(
    initialState,
    { type: 'attach', url: '/.oddlings/active.json', source: null, pinned: false },
    {
      type: 'build',
      doc: doc(spec),
      source: 'specs/sniper-rifle.spec.json',
      at: '2026-09-18T06:57:44.009Z',
      etag,
      first: true,
    },
  );
}

describe('history', () => {
  test('a commit pushes one entry and moves the cursor onto it', () => {
    const next = doc(wizard, 'human');
    const state = run(initialState, { type: 'commit', doc: next });
    expect(state.history.length).toBe(2);
    expect(state.cursor).toBe(1);
    expect(state.doc).toBe(next);
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);
  });

  test('a commit identical to the current document is not a step', () => {
    const state = run(initialState, { type: 'commit', doc: doc(null, 'human') });
    expect(state.history.length).toBe(1);
  });

  test('undo and redo walk the cursor without rewriting the history', () => {
    const one = doc(wizard, 'human');
    const two = doc(updatePart(wizard, [0], { name: 'boot-b' }), 'human');
    let state = run(
      initialState,
      { type: 'commit', doc: one },
      { type: 'commit', doc: two },
    );
    state = reducer(state, { type: 'undo' });
    expect(state.doc).toBe(one);
    expect(state.history.length).toBe(3);
    state = reducer(state, { type: 'redo' });
    expect(state.doc).toBe(two);
    expect(canRedo(state)).toBe(false);
  });

  test('a commit after an undo truncates what redo was holding', () => {
    const one = doc(wizard, 'human');
    const two = doc(updatePart(wizard, [0], { name: 'b' }), 'human');
    const three = doc(updatePart(wizard, [0], { name: 'c' }), 'human');
    let state = run(
      initialState,
      { type: 'commit', doc: one },
      { type: 'commit', doc: two },
      { type: 'undo' },
    );
    expect(canRedo(state)).toBe(true);
    state = reducer(state, { type: 'commit', doc: three });
    expect(canRedo(state)).toBe(false);
    expect(state.history).toEqual([initialState.doc, one, three]);
  });

  test('a live drag moves the document without touching the history', () => {
    const state = run(following(), { type: 'live', doc: doc(wizard, 'human') });
    expect(state.doc.spec).toBe(wizard);
    expect(state.history.length).toBe(2);
    expect(state.cursor).toBe(1);
  });
});

describe('follow', () => {
  test('the first payload attaches, records the ETag, and becomes current', () => {
    const state = following();
    expect(state.follow.status).toBe('live');
    expect(state.follow.source).toBe('specs/sniper-rifle.spec.json');
    expect(state.follow.etag).toBe('w/"1"');
    expect(state.doc.spec).toBe(rifle);
    expect(state.builds).toHaveLength(1);
    expect(state.builds[0].origin).toBe('agent');
  });

  test('a new agent build appends a row and becomes the document', () => {
    const state = reducer(following(), {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    expect(state.builds.map((entry) => entry.name)).toEqual([
      'Sniper Rifle',
      wizard.name,
    ]);
    expect(state.doc.spec).toBe(wizard);
    expect(state.history.length).toBe(3);
  });

  test('the same ETag is not a new build', () => {
    const before = following();
    const after = reducer(before, {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"1"',
      first: false,
    });
    expect(after).toBe(before);
  });

  test('every human edit detaches, and a later build is then dropped', () => {
    // Undo needs somewhere to walk back to, so this one follows two builds.
    const twice = reducer(following(), {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    for (const [start, action] of [
      [following(), { type: 'commit', doc: doc(wizard, 'human') }],
      [following(), { type: 'live', doc: doc(wizard, 'human') }],
      [twice, { type: 'undo' }],
    ] as [StudioState, StudioAction][]) {
      const edited = reducer(start, action);
      expect(edited.follow.status).toBe('off');
      const later = reducer(edited, {
        type: 'build',
        doc: doc(rifle),
        source: 'specs/sniper-rifle.spec.json',
        at: '2026-09-18T07:01:00.000Z',
        etag: 'w/"9"',
        first: false,
      });
      expect(later).toBe(edited);
    }
  });

  test('an edit while still waiting keeps a first payload from landing', () => {
    const edited = reducer(initialState, {
      type: 'commit',
      doc: doc(wizard, 'human'),
    });
    expect(edited.follow.status).toBe('off');
    const later = reducer(edited, {
      type: 'build',
      doc: doc(rifle),
      source: 'specs/sniper-rifle.spec.json',
      at: '2026-09-18T07:01:00.000Z',
      etag: 'w/"1"',
      first: true,
    });
    expect(later.doc.spec).toBe(wizard);
  });

  test('a second first payload is the same build, not another row', () => {
    // The slow retry can still be in flight when the first fetch lands.
    const once = following();
    const twice = reducer(once, {
      type: 'build',
      doc: doc(rifle),
      source: 'specs/sniper-rifle.spec.json',
      at: '2026-09-18T06:57:44.009Z',
      etag: 'w/"1"',
      first: true,
    });
    expect(twice).toBe(once);
    expect(twice.builds).toHaveLength(1);
  });

  test('giving up only applies while still waiting', () => {
    expect(reducer(initialState, { type: 'gaveUp' }).follow.status).toBe('gaveup');
    expect(reducer(following(), { type: 'gaveUp' }).follow.status).toBe('live');
  });
});

describe('save', () => {
  const edited = reducer(following(), {
    type: 'commit',
    doc: doc(updatePart(rifle, [0], { name: 'body' }), 'human'),
  });

  test('offers the followed file as the path to write', () => {
    expect(savePath(edited)).toBe('specs/sniper-rifle.spec.json');
    expect(canSave(edited)).toBe(true);
  });

  test('refuses without a spec, without a source, or with nothing changed', () => {
    expect(canSave(following())).toBe(false);
    expect(
      savePath({ ...edited, doc: { ...edited.doc, spec: null } }),
    ).toBeNull();
    expect(
      savePath({ ...edited, follow: { ...edited.follow, source: '../secrets.json' } }),
    ).toBeNull();
    expect(
      savePath({ ...edited, follow: { ...edited.follow, source: null } }),
    ).toBeNull();
  });

  test('a save appends a human row and resumes following', () => {
    const saved = reducer(edited, {
      type: 'saved',
      at: '2026-09-18T07:05:00.000Z',
      path: 'specs/sniper-rifle.spec.json',
      etag: 'w/"3"',
    });
    expect(saved.builds.map((entry) => entry.origin)).toEqual(['agent', 'human']);
    expect(saved.follow.status).toBe('live');
    expect(saved.follow.etag).toBe('w/"3"');
    expect(canSave(saved)).toBe(false);
  });
});

describe('changed rows', () => {
  test('nothing to compare against without a previous build', () => {
    expect(changedPaths(following()).size).toBe(0);
  });

  test('a second build is compared against the one before it', () => {
    const moved = updatePart(rifle, [0], { name: 'receiver-b' });
    const state = reducer(following(), {
      type: 'build',
      doc: doc(moved),
      source: 'specs/sniper-rifle.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    expect([...changedPaths(state)]).toEqual(['0']);
  });

  test('a human edit is compared against the newest build', () => {
    const state = reducer(following(), {
      type: 'commit',
      doc: doc(updatePart(rifle, [1], { name: 'rail-b' }), 'human'),
    });
    expect([...changedPaths(state)]).toEqual(['1']);
  });

  test('restoring a logged build puts it back as a new history entry', () => {
    const two = reducer(following(), {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    const back = reducer(two, { type: 'restoreBuild', index: 0 });
    expect(back.doc.spec).toBe(rifle);
    expect(back.history.length).toBe(4);
    expect(back.follow.status).toBe('off');
  });
});

describe('playback', () => {
  test('a load opens on the first clip the spec exports', () => {
    // The rifle's Bolt joint exports one clip, so following it selects it.
    expect(following().playback.clip).not.toBe(BIND_POSE);
    expect(following(wizard).playback.clip).toBeTruthy();
  });

  test('changing clip rewinds the clock', () => {
    const state = run(
      following(),
      { type: 'time', time: 1.4 },
      { type: 'clip', name: 'Bolt' },
    );
    expect(state.playback.time).toBe(0);
  });

  test('the bind pose cannot play', () => {
    const state = run(
      following(),
      { type: 'clip', name: BIND_POSE },
      { type: 'playing', playing: true },
    );
    expect(state.playback.playing).toBe(false);
  });

  test('a clip list that no longer holds the current clip falls to the first', () => {
    const state = run(
      following(),
      { type: 'clip', name: 'Ghost' },
      { type: 'clips', clips: [{ name: 'Walk', duration: 1 }] },
    );
    expect(state.playback.clip).toBe('Walk');
    const kept = reducer(state, {
      type: 'clips',
      clips: [{ name: 'Walk', duration: 1 }, { name: 'Idle', duration: 2 }],
    });
    expect(kept.playback.clip).toBe('Walk');
  });
});

describe('unsaved work', () => {
  test('a followed build is not unsaved: it is what the file already says', () => {
    expect(isDirty(following())).toBe(false);
    expect(isDirty(initialState)).toBe(false);
  });

  test('an edit is unsaved until it is written back', () => {
    const edited = reducer(following(), {
      type: 'commit',
      doc: doc(updatePart(rifle, [0], { name: 'body' }), 'human'),
    });
    expect(isDirty(edited)).toBe(true);
    const saved = reducer(edited, {
      type: 'saved',
      at: '2026-09-18T07:05:00.000Z',
      path: 'specs/sniper-rifle.spec.json',
      etag: 'w/"3"',
    });
    expect(isDirty(saved)).toBe(false);
  });

  test('a document with nowhere to save is still unsaved', () => {
    // An imported spec has no followed file, so `canSave` is false — which is
    // exactly when losing the tab would lose the work.
    const imported = reducer(initialState, {
      type: 'commit',
      doc: doc(wizard, 'human'),
    });
    expect(canSave(imported)).toBe(false);
    expect(isDirty(imported)).toBe(true);
  });
});

describe('isolation', () => {
  const picked = { kind: 'part' as const, path: [0] };

  test('isolating twice on the same thing shows everything again', () => {
    const on = reducer(following(), { type: 'isolate', selection: picked });
    expect(on.isolate).toEqual(picked);
    expect(reducer(on, { type: 'isolate', selection: picked }).isolate).toBeNull();
  });

  test('isolating something else moves the isolation rather than clearing it', () => {
    const on = reducer(following(), { type: 'isolate', selection: picked });
    const moved = reducer(on, {
      type: 'isolate',
      selection: { kind: 'part', path: [1] },
    });
    expect(moved.isolate).toEqual({ kind: 'part', path: [1] });
  });

  test('deselecting leaves the isolation, selecting something else keeps it', () => {
    const on = run(
      following(),
      { type: 'select', selection: picked },
      { type: 'isolate', selection: picked },
    );
    expect(
      reducer(on, { type: 'select', selection: { kind: 'part', path: [1] } }).isolate,
    ).toEqual(picked);
    expect(reducer(on, { type: 'select', selection: null }).isolate).toBeNull();
  });

  test('a new build clears it: those paths named the old document', () => {
    const on = reducer(following(), { type: 'isolate', selection: picked });
    const next = reducer(on, {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    expect(next.isolate).toBeNull();
  });
});

describe('the left tab', () => {
  test('an empty studio opens on Projects, since there is nothing to outline', () => {
    expect(initialState.leftTab).toBe('projects');
  });

  test('the first document moves it to the outliner, exactly once', () => {
    const first = following();
    expect(first.leftTab).toBe('outliner');
    // Back to Projects to open something else; a second build leaves it there.
    const browsing = reducer(first, { type: 'leftTab', tab: 'projects' });
    const second = reducer(browsing, {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:00:00.000Z',
      etag: 'w/"2"',
      first: false,
    });
    expect(second.leftTab).toBe('projects');
  });

  test('a tab the user picked is never moved by a load', () => {
    const picked = reducer(initialState, { type: 'leftTab', tab: 'library' });
    expect(picked.leftTabAuto).toBe(false);
    const loaded = reducer(picked, { type: 'commit', doc: doc(wizard, 'human') });
    expect(loaded.leftTab).toBe('library');
  });
});

describe('opening another file', () => {
  const edited = reducer(following(), {
    type: 'commit',
    doc: doc(updatePart(rifle, [0], { name: 'body' }), 'human'),
  });

  test('a plain attach leaves a document someone has taken over alone', () => {
    expect(edited.follow.status).toBe('off');
    const ignored = reducer(edited, {
      type: 'attach',
      url: '/specs/wizard.spec.json',
      source: 'specs/wizard.spec.json',
      pinned: true,
    });
    expect(ignored).toBe(edited);
  });

  test('a forced attach re-points it and clears the old file markers', () => {
    const moved = reducer(edited, {
      type: 'attach',
      url: '/specs/wizard.spec.json',
      source: 'specs/wizard.spec.json',
      pinned: true,
      force: true,
    });
    expect(moved.follow).toMatchObject({
      status: 'waiting',
      url: '/specs/wizard.spec.json',
      source: 'specs/wizard.spec.json',
      pinned: true,
      etag: null,
      lastBuildAt: null,
    });
    // And the payload that follows lands, rather than being read as a repeat.
    const landed = reducer(moved, {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T07:10:00.000Z',
      etag: 'w/"1"',
      first: true,
    });
    expect(landed.doc.spec).toBe(wizard);
    expect(landed.follow.status).toBe('live');
  });
});

describe('layout', () => {
  test('a splitter cannot drag a column below its minimum', () => {
    const state = reducer(initialState, {
      type: 'layout',
      patch: { left: 20, right: 10, dock: 5 },
    });
    expect(state.layout).toMatchObject({ left: 180, right: 240, dock: 100 });
  });

  test('picking a tab opens the column it lives in', () => {
    const shut = reducer(initialState, {
      type: 'layout',
      patch: { leftOpen: false, rightOpen: false, dockOpen: false },
    });
    expect(reducer(shut, { type: 'leftTab', tab: 'library' }).layout.leftOpen).toBe(true);
    expect(reducer(shut, { type: 'rightTab', tab: 'checks' }).layout.rightOpen).toBe(true);
    expect(reducer(shut, { type: 'dockTab', tab: 'builds' }).layout.dockOpen).toBe(true);
  });
});

describe('the action registry', () => {
  test('every id is unique', () => {
    expect(COMMAND_BY_ID.size).toBe(COMMANDS.length);
  });

  test('every command has a label, a group, and a runnable body', () => {
    for (const command of COMMANDS) {
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.group.length).toBeGreaterThan(0);
      expect(typeof command.run).toBe('function');
      expect(typeof command.enabled).toBe('function');
    }
  });

  test('every declared chord is one this keymap can produce', () => {
    for (const command of COMMANDS)
      for (const chord of command.keys ?? []) {
        const parts = chord.split('+');
        const key = parts.pop()!;
        expect(
          chordOf({
            key,
            metaKey: parts.includes('Mod'),
            altKey: parts.includes('Alt'),
            shiftKey: parts.includes('Shift'),
          }),
        ).toBe(chord);
      }
  });

  test('no two enabled commands claim one chord in the same context', () => {
    // Checked against several states, because `enabled` is what decides
    // whether two claims can ever collide.
    const edited = reducer(following(), {
      type: 'commit',
      doc: doc(updatePart(rifle, [0], { name: 'body' }), 'human'),
    });
    for (const state of [
      initialState,
      following(),
      edited,
      { ...edited, selection: { kind: 'part', path: [0] } } as StudioState,
      { ...edited, selection: { kind: 'bone', name: 'Bolt' } } as StudioState,
      {
        ...edited,
        selection: { kind: 'part', path: [0] },
        isolate: { kind: 'part', path: [0] },
      } as StudioState,
    ])
      expect(keyConflicts(state)).toEqual([]);
  });

  test('every panel and help command the shell offers is registered', () => {
    for (const id of [
      'panel.projects',
      'panel.json',
      'panel.notes',
      'view.isolate',
      'view.compare',
      'help.shortcuts',
    ])
      expect(COMMAND_BY_ID.get(id)).toBeDefined();
  });

  test('the shortcuts sheet is reachable from the key that opens it', () => {
    expect(commandFor('Shift+?', initialState)?.id).toBe('help.shortcuts');
  });

  test('isolate needs a spec and something to isolate', () => {
    expect(commandFor('/', initialState)).toBeNull();
    const chosen = {
      ...following(),
      selection: { kind: 'part', path: [0] },
    } as StudioState;
    expect(commandFor('/', chosen)?.id).toBe('view.isolate');
    // The viewport answers this key itself and reports back, so the window
    // handler has to stand down while the canvas has focus — otherwise one
    // press flips the isolation twice and nothing appears to happen.
    expect(commandFor('/', chosen, { canvasFocused: true })).toBeNull();
  });

  test('the canvas keeps the keys it answers itself while it has focus', () => {
    const state = { ...following(), selection: { kind: 'part', path: [0] } } as StudioState;
    expect(commandFor('F', state)?.id).toBe('view.frameSelected');
    expect(commandFor('F', state, { canvasFocused: true })).toBeNull();
    // ⌘Z is not the canvas's, so it works wherever the focus is.
    const edited = reducer(state, { type: 'commit', doc: doc(wizard, 'human') });
    expect(commandFor('Mod+Z', edited, { canvasFocused: true })?.id).toBe('edit.undo');
  });

  test('a command nothing can act on is not offered', () => {
    expect(commandFor('Mod+Z', initialState)).toBeNull();
    expect(commandFor('Escape', initialState)).toBeNull();
    expect(commandFor('Mod+S', initialState)).toBeNull();
  });
});

/**
 * Comparing against the previous build.
 *
 * The rule has the same shape as `changedPaths` and for the same reason: what
 * you want behind your edit is the thing the agent wrote, whether you are
 * looking at that build or at a correction of it.
 */
describe('the compare ghost', () => {
  test('nothing to compare against until a second build lands', () => {
    expect(ghostDoc(initialState)).toBeNull();
    expect(ghostDoc(following())).toBeNull();
  });

  test('is the build before the one on screen', () => {
    const first = following();
    const second = run(first, {
      type: 'build',
      doc: doc(wizard),
      source: 'specs/wizard.spec.json',
      at: '2026-09-18T00:00:02.000Z',
      etag: 'w/"2"',
      first: false,
    });
    expect(ghostDoc(second)?.spec).toBe(rifle);
    // Walking back to the earlier build makes the ghost the one before *it*,
    // which is nothing — rather than the newer build it was replaced by.
    expect(ghostDoc(run(second, { type: 'restoreBuild', index: 0 }))).toBeNull();
  });

  test('is the newest build once the document has been edited away from it', () => {
    const edited = run(following(), {
      type: 'commit',
      doc: doc(wizard, 'human'),
    });
    expect(ghostDoc(edited)?.spec).toBe(rifle);
  });

  test('skips this studio’s own saves, which are not a second opinion', () => {
    const saved = run(following(), {
      type: 'saved',
      at: '2026-09-18T00:00:05.000Z',
      path: 'specs/sniper-rifle.spec.json',
      etag: 'w/"3"',
    });
    // One agent build and one save of it: there is still only one author.
    expect(ghostDoc(saved)).toBeNull();
  });
});

describe('the build log, live and on disk', () => {
  const entry = (at: string, over: Partial<BuildEntry> = {}): BuildEntry => ({
    at,
    name: 'Octopod Walker',
    origin: 'agent',
    doc: doc(rifle),
    ...over,
  });
  const disk = (at: string, over: Partial<BuildRow> = {}): BuildRow => ({
    at,
    name: 'Octopod Walker',
    source: 'specs/octopod-walker.spec.json',
    tris: 9000,
    meshes: 40,
    bones: 0,
    ok: true,
    errors: 0,
    warnings: 0,
    ...over,
  });

  test('shows both logs as one, newest first', () => {
    const rows = mergeBuilds(
      [entry('2026-09-18T00:00:10.000Z')],
      [disk('2026-09-18T00:00:05.000Z'), disk('2026-09-18T00:00:01.000Z')],
    );
    expect(rows.map((row) => row.kind)).toEqual(['live', 'disk', 'disk']);
    expect(rows.map((row) => row.at)).toEqual([
      '2026-09-18T00:00:10.000Z',
      '2026-09-18T00:00:05.000Z',
      '2026-09-18T00:00:01.000Z',
    ]);
  });

  test('one build is one row, even when the two sides timed it differently', () => {
    // The first payload the studio followed *is* the CLI's last write.
    const rows = mergeBuilds(
      [entry('2026-09-18T00:00:10.000Z')],
      [disk('2026-09-18T00:00:09.300Z'), disk('2026-09-18T00:00:01.000Z')],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('live');
  });

  test('a live row keeps the index the restore action needs', () => {
    const rows = mergeBuilds(
      [entry('2026-09-18T00:00:01.000Z'), entry('2026-09-18T00:00:09.000Z')],
      [],
    );
    expect(rows.map((row) => (row.kind === 'live' ? row.index : -1))).toEqual([1, 0]);
  });

  test('a flat series is drawn flat rather than stretched to the box', () => {
    expect(sparkPoints([9000, 9000, 9000], 60, 12)).toBe('0.0,6.0 30.0,6.0 60.0,6.0');
    expect(sparkPoints([0, 10], 10, 10)).toBe('0.0,10.0 10.0,0.0');
    expect(sparkPoints([9000], 60, 12)).toBe('');
  });
});

describe('toasts', () => {
  const say = (id: string): StudioAction => ({
    type: 'toast',
    toast: { id, text: id, tone: 'info' },
  });

  test('stack, and the oldest falls off the end', () => {
    const state = run(initialState, say('a'), say('b'), say('c'), say('d'), say('e'));
    expect(state.toasts.map((toast) => toast.id)).toEqual(['b', 'c', 'd', 'e']);
  });

  test('dismissing one that is already gone changes nothing at all', () => {
    const state = run(initialState, say('a'));
    expect(reducer(state, { type: 'untoast', id: 'a' }).toasts).toEqual([]);
    expect(reducer(state, { type: 'untoast', id: 'zz' })).toBe(state);
  });
});

/**
 * Loading is state, not a spinner.
 *
 * The chrome has to stay usable while the studio boots, the chip has to
 * disappear when the build it belongs to lands and not when some other one
 * does, and the boot screen must never come back once the studio has drawn
 * something. All three are rules about the store, so all three are testable
 * without a browser — which is the point of keeping them here.
 */
describe('loading', () => {
  test('starts booting and names the step', () => {
    expect(initialState.loading.boot).toBeTruthy();
    expect(initialState.loading.booted).toBe(false);
    const state = run(initialState, { type: 'bootStep', step: 'loading the decimator…' });
    expect(state.loading.boot).toBe('loading the decimator…');
  });

  test('the first model ends the boot for good', () => {
    const state = run(
      initialState,
      { type: 'building', id: 1, since: 0 },
      { type: 'built', id: 1 },
    );
    expect(state.loading.boot).toBe(null);
    expect(state.loading.booted).toBe(true);
    expect(state.loading.build).toBe(null);
    // A later step is ordinary work; covering the studio again would be a
    // regression dressed up as feedback.
    const after = run(state, { type: 'bootStep', step: 'loading the decimator…' });
    expect(after.loading.boot).toBe(null);
  });

  test('a build in flight is remembered while the old model stays on screen', () => {
    const state = run(initialState, { type: 'building', id: 7, since: 1234 });
    expect(state.loading.build).toStrictEqual({ id: 7, since: 1234 });
  });

  test('a superseded build leaves no trace when it finally lands', () => {
    const state = run(
      initialState,
      { type: 'building', id: 1, since: 0 },
      { type: 'building', id: 2, since: 5 },
      // The first one finishing must not clear the chip belonging to the
      // second, which is the one still running.
      { type: 'built', id: 1 },
    );
    expect(state.loading.build).toStrictEqual({ id: 2, since: 5 });
    expect(run(state, { type: 'built', id: 2 }).loading.build).toBe(null);
  });
});

/**
 * How the last edit arrived, which is what tells the viewport whether to wait
 * before asking the worker for a build.
 */
describe('edit pace', () => {
  const spec = wizard;
  const edited = (state: StudioState): StudioState =>
    reducer(state, {
      type: 'live',
      doc: { ...doc(spec), origin: 'human' },
    });

  test('a live edit is a typed one and waits', () => {
    expect(edited(following()).lastEdit).toBe('typed');
  });

  test('a committed edit does not', () => {
    const state = run(following(), {
      type: 'commit',
      doc: { ...doc(updatePart(spec, [0], { position: [0, 1, 0] })), origin: 'human' },
    });
    expect(state.lastEdit).toBe('commit');
  });

  test('and neither does a freshly loaded document', () => {
    expect(following(rifle).lastEdit).toBe('load');
  });
});

/**
 * The viewport's filter stack.
 *
 * Every rule worth having here is one that can only otherwise be checked by
 * looking at a rendered canvas: that a preset is the same look whatever was on
 * screen before it, that the master switch does not forget the stack it was
 * switched off over, and that a stored blob from an older build — or from the
 * console — cannot put a shader uniform out of range.
 */
describe('viewport filters', () => {
  const filters = (state: StudioState): Filters => state.filters;

  test('the stack starts off, and off means no work for the viewport', () => {
    expect(filtersActive(initialState.filters)).toBe(false);
    expect(filterCount(initialState.filters)).toBe(0);
  });

  test('a preset replaces the stack rather than inheriting from it', () => {
    const fiddled = run(
      initialState,
      { type: 'filters', patch: { on: true, vignette: { on: true, mix: 0.9 } } },
      { type: 'filterPreset', preset: 'pixel-art' },
    );
    expect(activeFilters(filters(fiddled))).toStrictEqual([
      'pixelate',
      'posterize',
      'dither',
    ]);
    // The vignette someone had switched on is not carried into the preset.
    expect(filters(fiddled).vignette.on).toBe(false);
    expect(filters(fiddled)).toStrictEqual(applyPreset('pixel-art'));
  });

  test('Pixel art is pixelate 4, posterize 8 and a 4×4 Bayer matrix', () => {
    const preset = applyPreset('pixel-art');
    expect(preset.pixelate.size).toBe(4);
    expect(preset.posterize.levels).toBe(8);
    expect(preset.dither.matrix).toBe(4);
  });

  test('the presets are the only looks that report as a preset', () => {
    expect(matchingPreset(applyPreset('retro-crt'))).toBe('retro-crt');
    expect(matchingPreset(DEFAULT_FILTERS)).toBe('off');
    const nudged = patchFilters(applyPreset('retro-crt'), {
      scanlines: { spacing: 9 },
    });
    expect(matchingPreset(nudged)).toBe(null);
  });

  test('the master switch keeps the stack it was switched off over', () => {
    const on = run(initialState, { type: 'filterPreset', preset: 'ink-outline' });
    const off = run(on, { type: 'filters', patch: { on: false } });
    expect(filtersActive(filters(off))).toBe(false);
    // Still configured, just not drawing — which is the whole reason the
    // master switch is separate from the seven per-filter ones.
    expect(filters(off).outline.on).toBe(true);
    const again = run(off, { type: 'filters', patch: { on: true } });
    expect(filters(again)).toStrictEqual(filters(on));
  });

  test('every parameter is clamped to what the shader can take', () => {
    const wild = patchFilters(DEFAULT_FILTERS, {
      on: true,
      outline: { thickness: 99, threshold: -4, color: 'rgb(1,2,3)' },
      pixelate: { size: 0, mix: 12 },
      posterize: { levels: 500 },
      scanlines: { spacing: -1 },
    });
    expect(wild.outline.thickness).toBe(3);
    expect(wild.outline.threshold).toBe(0.05);
    // Not a `#rrggbb`, so it is not a colour: the default stands rather than
    // `THREE.Color` being handed something it will warn about and ignore.
    expect(wild.outline.color).toBe(DEFAULT_FILTERS.outline.color);
    expect(wild.pixelate.size).toBe(1);
    expect(wild.pixelate.mix).toBe(1);
    expect(wild.posterize.levels).toBe(32);
    expect(wild.scanlines.spacing).toBe(2);
  });

  test('a patch that changes nothing changes nothing', () => {
    const state = run(initialState, { type: 'filterPreset', preset: 'pixel-art' });
    // Identity, not equality: the store persists on a new object and the
    // viewport pushes uniforms on one, so a slider dropped back where it
    // started must not produce either.
    const again = run(state, {
      type: 'filters',
      patch: { pixelate: { size: state.filters.pixelate.size } },
    });
    expect(again.filters).toBe(state.filters);
    expect(again).toBe(state);
  });

  test('a restored blob is read field by field, never trusted whole', () => {
    expect(readFilters(null)).toBe(null);
    expect(readFilters('{')).toBe(null);
    expect(readFilters('[]')).toBe(null);
    const stored = JSON.stringify({
      on: true,
      posterize: { on: true, levels: 4 },
      // A filter this build does not have, a field of the wrong type, and a
      // level that would divide by zero in the quantiser.
      bloom: { on: true },
      dither: { matrix: 'huge', mix: 0.5 },
      pixelate: { size: 1e9 },
    });
    const read = readFilters(stored);
    expect(read).not.toBe(null);
    expect(read!.posterize.levels).toBe(4);
    expect(read!.dither.matrix).toBe(DEFAULT_FILTERS.dither.matrix);
    expect(read!.pixelate.size).toBe(16);
    expect(activeFilters(read!)).toStrictEqual(['posterize']);
  });

  test('every filter has a command, and P still toggles the stack', () => {
    for (const kind of FILTER_KINDS)
      expect(COMMAND_BY_ID.has(`filter.${kind}`)).toBe(true);
    const toggle = COMMAND_BY_ID.get('toggle.filters');
    expect(toggle?.keys).toStrictEqual(['P']);
  });

  test('turning one filter on from the palette brings the stack with it', () => {
    const command = COMMAND_BY_ID.get('filter.scanlines')!;
    let state = initialState;
    // Only the two fields this command touches; the rest of the context is
    // the shell's and none of it is reachable from here.
    const context = {
      get state() {
        return state;
      },
      dispatch: (action: StudioAction) => {
        state = reducer(state, action);
      },
    } as ActionContext;
    command.run(context);
    expect(state.filters.on).toBe(true);
    expect(activeFilters(state.filters)).toStrictEqual(['scanlines']);
    // Switching one off is not a reason to switch the stack on. Only the
    // "on" direction carries the master with it — otherwise turning a filter
    // off from the palette would light up a stack nobody asked for.
    state = run(state, { type: 'filters', patch: { on: false } });
    command.run(context);
    expect(state.filters.scanlines.on).toBe(false);
    expect(state.filters.on).toBe(false);
  });

  test('a stored blob with nothing usable in it is not a stored stack', () => {
    expect(readFilters('{}')).toBe(null);
    expect(readFilters('{"bloom":{"on":true}}')).toBe(null);
  });
});
