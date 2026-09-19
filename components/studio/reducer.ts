/**
 * The whole studio, as one pure function of (state, action).
 *
 * The old page kept a dozen `useState` hooks and a pile of refs, and the rules
 * that tied them together — an edit detaches the follow, a new build clears the
 * selection, a clip change rewinds the clock — lived inside event handlers
 * where nothing could check them. They are invariants, so they belong in one
 * place that can be unit-tested without a browser: everything below is plain
 * data in and plain data out, and the only impure parts of the studio are the
 * poll, the fetches and the three.js viewport.
 *
 * Deliberately not in `store.tsx`: this file imports no React, so the tests
 * exercise exactly the code the app runs rather than a rendered copy of it.
 */
import { initialRecipe, type Recipe } from '@/lib/asset-recipe';
import type { AssetSpec } from '@/lib/asset-spec';
import { clipsOf } from '@/lib/asset-joints';
import { diffSpecs, sameSelection, type Selection } from '@/lib/spec-edit';
import { BIND_POSE } from '@/components/timeline';
import type { SpecRow } from '@/node/studio-api';

/** Where the document on screen came from. Shown, and used to label builds. */
export type Origin = 'agent' | 'human' | 'library' | 'blueprint' | 'import';

/**
 * One undoable state: a generator recipe, optionally overlaid by the spec being
 * reviewed. Both travel together so undo walks across the boundary between the
 * generators and an authored spec without stranding either.
 */
export type Doc = { recipe: Recipe; spec: AssetSpec | null; origin: Origin };

/** One row in the Builds log. `doc` is held by reference, see `changedPaths`. */
export type BuildEntry = {
  at: string;
  name: string;
  /** Who wrote it: a CLI/MCP build, or a Save from this studio. */
  origin: 'agent' | 'human';
  tris?: number;
  ok?: boolean;
  doc: Doc;
};

/**
 * `waiting` is not `off`. A fresh clone has no pointer yet, and saying "not
 * following" there would describe a choice nobody made.
 */
export type FollowStatus = 'waiting' | 'live' | 'gaveup' | 'off';

export type Follow = {
  status: FollowStatus;
  /** The URL being polled — the pointer, or the pinned `?spec=` file. */
  url: string;
  /** What is actually being followed: the pinned path, or the pointer's `source`. */
  source: string | null;
  /** True when a `?spec=` parameter pinned this page to one file. */
  pinned: boolean;
  lastBuildAt: string | null;
  /** The ETag of the payload already on screen; a match is not a new build. */
  etag: string | null;
};

export type Layout = {
  left: number;
  right: number;
  dock: number;
  leftOpen: boolean;
  rightOpen: boolean;
  dockOpen: boolean;
};

export type Overlays = {
  wireframe: boolean;
  grid: boolean;
  skeleton: boolean;
  pixel: boolean;
  rotate: boolean;
  /** Draw the previous agent build behind this one, as a ghost. */
  compare: boolean;
};

/**
 * One line of passing news, bottom right.
 *
 * In the state rather than in a component because the things worth saying —
 * a build landed, a spec appeared, a save failed — are noticed by hooks and
 * effects scattered across the shell, and a ref-counted portal would be a
 * second place for them to disagree with the status line. The id is supplied
 * by the caller so the reducer stays a pure function of its arguments.
 */
export type Toast = {
  id: string;
  text: string;
  tone: 'info' | 'good' | 'bad';
  /** A spec path this offers to open, for news about a file you are not on. */
  open?: string;
};

export type Playback = {
  clip: string;
  playing: boolean;
  time: number;
  speed: number;
  clips: { name: string; duration: number }[];
};

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** A recipe kept in this browser's library, with a thumbnail if one was taken. */
export type Saved = { id: string; recipe: Recipe; thumbnail: string };

export type LeftTab = 'projects' | 'outliner' | 'library';
export type RightTab = 'properties' | 'checks' | 'notes' | 'asset' | 'json';
export type DockTab = 'timeline' | 'builds';
/** Which modal is up. One at a time, because they are all full-attention. */
export type Modal = 'blueprint' | 'url' | 'shortcuts' | null;

export type StudioState = {
  doc: Doc;
  history: Doc[];
  cursor: number;
  selection: Selection;
  hover: Selection;
  /**
   * What the viewport is showing alone, or null for the whole model.
   *
   * Separate from `selection` because they answer different questions — you
   * keep working on a part after isolating it, and clicking a second part
   * inside an isolated branch must not silently un-isolate the first.
   */
  isolate: Selection;
  /** A mirror of the viewport's own gizmo mode; see `actions.ts`. */
  gizmo: GizmoMode;
  overlays: Overlays;
  playback: Playback;
  follow: Follow;
  builds: BuildEntry[];
  /**
   * The `specs/` listing, polled once for the whole studio.
   *
   * Above the Projects panel because three other things read it: the empty
   * state offers the most recent files, the thumbnail cache keys on a file's
   * modification time, and the toast for a spec that has just appeared has to
   * be noticed whether or not anybody is looking at the list.
   */
  specs: SpecRow[] | null;
  toasts: Toast[];
  layout: Layout;
  library: Saved[];
  status: string;
  leftTab: LeftTab;
  /**
   * True while the left tab is still the shell's choice rather than the user's.
   *
   * An empty studio opens on Projects, because with nothing loaded the outliner
   * has nothing to list. The first document to arrive moves it to the outliner
   * once — and only once, so opening a second project from the Projects tab
   * leaves you there rather than throwing you out of the list you are browsing.
   */
  leftTabAuto: boolean;
  rightTab: RightTab;
  dockTab: DockTab;
  palette: boolean;
  modal: Modal;
  /** True while an export is packing, so the menu can say so. */
  busy: boolean;
  /** The WebAssembly decimator surface specs re-mesh through. */
  surfaceReady: boolean;
  loading: Loading;
  /**
   * How the document on screen last changed.
   *
   * The viewport reads it to decide whether to wait before building. A slider
   * being dragged produces an edit per frame and a surface spec takes a second
   * to build, so those coalesce; a committed edit, an undo or a freshly loaded
   * file is already one event and goes straight out.
   */
  lastEdit: EditKind;
};

export type EditKind = 'typed' | 'commit' | 'load';

/**
 * What the studio is waiting for, as data rather than as spinners.
 *
 * Two quite different waits, and conflating them is how a studio ends up
 * showing "loading" over a document it already has. `boot` is the one-time
 * start-up — the decimator, the worker, the pointer file, the first build —
 * and it is over for good once a model has been drawn. `build` is the ordinary
 * per-edit wait, during which the previous model is still on screen and still
 * usable.
 *
 * The elapsed clock is deliberately absent: a chip that counts milliseconds
 * keeps its own interval, because dispatching one of those ten times a second
 * is the problem `clock.ts` exists to avoid.
 */
export type Loading = {
  /** What start-up is doing, or null once the studio is usable. */
  boot: string | null;
  /** True once a model has been drawn; `bootStep` is ignored afterwards. */
  booted: boolean;
  /** The build in flight for the current document, if any. */
  build: { id: number; since: number } | null;
};

export const DEFAULT_LAYOUT: Layout = {
  left: 260,
  right: 320,
  dock: 160,
  leftOpen: true,
  rightOpen: true,
  dockOpen: true,
};

/** Below these a pane is unreadable, so a drag stops rather than shrinking on. */
export const MIN = { left: 180, right: 240, dock: 100 } as const;

export const POINTER_URL = '/.oddlings/active.json';

/** Nothing has changed, shared so `changedPaths` can return without allocating. */
const NO_CHANGES: ReadonlySet<string> = new Set();

const initialDoc: Doc = {
  recipe: initialRecipe,
  spec: null,
  origin: 'blueprint',
};

export const initialState: StudioState = {
  doc: initialDoc,
  history: [initialDoc],
  cursor: 0,
  selection: null,
  hover: null,
  isolate: null,
  gizmo: 'translate',
  overlays: {
    wireframe: false,
    grid: true,
    skeleton: false,
    pixel: false,
    rotate: false,
    compare: false,
  },
  playback: { clip: BIND_POSE, playing: false, time: 0, speed: 1, clips: [] },
  follow: {
    status: 'waiting',
    url: POINTER_URL,
    source: null,
    pinned: false,
    lastBuildAt: null,
    etag: null,
  },
  builds: [],
  specs: null,
  toasts: [],
  layout: DEFAULT_LAYOUT,
  library: [],
  status: 'Waiting for a build.',
  leftTab: 'projects',
  leftTabAuto: true,
  rightTab: 'properties',
  dockTab: 'timeline',
  palette: false,
  modal: null,
  busy: false,
  surfaceReady: false,
  loading: { boot: 'starting', booted: false, build: null },
  lastEdit: 'load',
};

export type StudioAction =
  /**
   * Point the studio at a file before the first payload arrives.
   *
   * `force` is the Projects panel opening a different file: a detached document
   * would otherwise refuse the new target, because a plain attach is only ever
   * allowed to widen what the studio knows about the one it already has.
   */
  | {
      type: 'attach';
      url: string;
      source: string | null;
      pinned: boolean;
      force?: boolean;
    }
  /** A payload from the poll. `first` is the load that attaches. */
  | {
      type: 'build';
      doc: Doc;
      source: string;
      at: string;
      etag: string | null;
      first: boolean;
    }
  /** The poll ran out of patience looking for a pointer that is not there. */
  | { type: 'gaveUp' }
  /** Triangle count and audit verdict, once the document on screen has built. */
  | { type: 'buildStats'; tris?: number; ok?: boolean }
  /** A Save landed: the followed file is ours now, and follow resumes on it. */
  | { type: 'saved'; at: string; path: string; etag: string | null }
  /** A human edit worth one undo step. */
  | { type: 'commit'; doc: Doc; status?: string }
  /** A live drag: the document moves, the history does not. */
  | { type: 'live'; doc: Doc }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Put a logged build back on screen as a new history entry. */
  | { type: 'restoreBuild'; index: number }
  | { type: 'detach'; status?: string }
  | { type: 'select'; selection: Selection }
  | { type: 'hover'; selection: Selection }
  /** Show one branch alone, or show everything again when it is already alone. */
  | { type: 'isolate'; selection: Selection }
  | { type: 'gizmo'; mode: GizmoMode }
  | { type: 'overlay'; key: keyof Overlays; value?: boolean }
  | { type: 'clip'; name: string }
  | { type: 'playing'; playing: boolean }
  | { type: 'time'; time: number }
  | { type: 'speed'; speed: number }
  | { type: 'clips'; clips: { name: string; duration: number }[] }
  | { type: 'layout'; patch: Partial<Layout> }
  | { type: 'library'; items: Saved[] }
  | { type: 'specs'; specs: SpecRow[] }
  /** Say one thing, briefly. The id is the caller's, so this stays pure. */
  | { type: 'toast'; toast: Toast }
  | { type: 'untoast'; id: string }
  | { type: 'status'; text: string }
  | { type: 'leftTab'; tab: LeftTab }
  | { type: 'rightTab'; tab: RightTab }
  | { type: 'dockTab'; tab: DockTab }
  | { type: 'palette'; open: boolean }
  | { type: 'modal'; modal: Modal }
  | { type: 'busy'; busy: boolean }
  | { type: 'surfaceReady' }
  /** Name the start-up step in progress. Ignored once the studio has booted. */
  | { type: 'bootStep'; step: string | null }
  /** A build was asked for, or the one in flight landed or was superseded. */
  | { type: 'building'; id: number; since: number }
  | { type: 'built'; id: number };

/** Undo depth. Long enough to walk back a session, short enough to hold. */
const HISTORY = 60;

const sameDoc = (a: Doc, b: Doc) =>
  a.recipe === b.recipe && a.spec === b.spec
    ? true
    : JSON.stringify({ recipe: a.recipe, spec: a.spec }) ===
      JSON.stringify({ recipe: b.recipe, spec: b.spec });

/**
 * Two writers on one document is a conflict nobody asked for, so the file
 * loses: any human edit stops the studio following.
 *
 * `waiting` detaches too — once this document has been touched, a build landing
 * later must not reach in and overwrite it.
 */
function detached(follow: Follow): Follow {
  return follow.status === 'off' ? follow : { ...follow, status: 'off' };
}

/** Push one document onto the history, truncating anything redo was holding. */
function push(state: StudioState, doc: Doc): Pick<StudioState, 'history' | 'cursor' | 'doc'> {
  const history = [...state.history.slice(0, state.cursor + 1), doc].slice(
    -HISTORY,
  );
  return { history, cursor: history.length - 1, doc };
}

/** The clip a freshly loaded document should open on. */
function openingClip(spec: AssetSpec | null): string {
  if (!spec) return BIND_POSE;
  return clipsOf(spec).at(0)?.name ?? BIND_POSE;
}

/** Everything a load resets, whichever door the document came through. */
function loaded(doc: Doc, state: StudioState) {
  return {
    lastEdit: 'load' as const,
    selection: null,
    hover: null,
    // An isolation names a path in the document that was on screen. Carrying it
    // onto a different asset would hide most of it and point at the wrong part.
    isolate: null,
    playback: {
      ...state.playback,
      clip: openingClip(doc.spec),
      time: 0,
      playing: false,
    },
  };
}

/**
 * Move the left column off Projects the first time there is a spec to list.
 *
 * Returns nothing once the tab has been settled — by this rule or by the user
 * picking one — so it can be spread into any case that loads a document.
 */
function autoTab(state: StudioState, doc: Doc) {
  if (!state.leftTabAuto || !doc.spec) return null;
  return { leftTab: 'outliner' as const, leftTabAuto: false };
}

export function reducer(
  state: StudioState,
  action: StudioAction,
): StudioState {
  switch (action.type) {
    case 'attach':
      // Only ever widens what the studio knows about its target; a document
      // already taken over by a human stays taken over, unless the human is the
      // one asking — opening a project is an explicit "follow this instead".
      if (state.follow.status === 'off' && !action.force) return state;
      return {
        ...state,
        follow: {
          ...state.follow,
          url: action.url,
          source: action.source,
          pinned: action.pinned,
          status: 'waiting',
          // A new target has nothing in common with the old one's markers, and
          // a stale ETag here would make the first payload look like a repeat.
          ...(action.force ? { etag: null, lastBuildAt: null } : null),
        },
      };

    case 'build': {
      // A user who edited while we were still waiting has taken the document.
      if (state.follow.status === 'off') return state;
      // The slow retry can race the first fetch and arrive after it landed.
      // Two "first" payloads are one build, not two rows and two undo steps.
      if (action.first && state.follow.status === 'live') return state;
      // Later payloads only land while the studio is actually following, and
      // only when the file really changed. The poll checks the ETag too, so it
      // can skip parsing; this is the gate that makes the rule true.
      if (!action.first && state.follow.status !== 'live') return state;
      if (!action.first && action.etag && action.etag === state.follow.etag)
        return state;
      const entry: BuildEntry = {
        at: action.at,
        name: action.doc.spec?.name ?? action.doc.recipe.name,
        origin: 'agent',
        doc: action.doc,
      };
      return {
        ...state,
        ...push(state, action.doc),
        ...loaded(action.doc, state),
        ...autoTab(state, action.doc),
        builds: [...state.builds, entry].slice(-80),
        follow: {
          ...state.follow,
          status: 'live',
          source: action.source,
          lastBuildAt: action.at,
          etag: action.etag,
        },
        status: action.first
          ? `Following ${action.source}. Any edit here stops following.`
          : `${action.source} rebuilt — reloaded ${entry.name}.`,
      };
    }

    case 'gaveUp':
      return state.follow.status === 'waiting'
        ? {
            ...state,
            follow: { ...state.follow, status: 'gaveup' },
            status: 'No build found. Run oddlings build or audit, then Follow.',
          }
        : state;

    case 'buildStats': {
      // Only ever annotates the row whose document is the one on screen: the
      // viewport reports what it drew, and what it drew is `state.doc`.
      const at = state.builds.findIndex((entry) => entry.doc === state.doc);
      if (at < 0) return state;
      const entry = state.builds[at];
      const tris = action.tris ?? entry.tris;
      const ok = action.ok ?? entry.ok;
      if (tris === entry.tris && ok === entry.ok) return state;
      const builds = [...state.builds];
      builds[at] = { ...entry, tris, ok };
      return { ...state, builds };
    }

    case 'saved': {
      // The document on screen is now what the file says, so following it
      // again costs nothing and the next agent build is picked up as usual.
      const entry: BuildEntry = {
        at: action.at,
        name: state.doc.spec?.name ?? state.doc.recipe.name,
        origin: 'human',
        doc: state.doc,
      };
      return {
        ...state,
        builds: [...state.builds, entry].slice(-80),
        follow: {
          ...state.follow,
          status: 'live',
          source: action.path,
          lastBuildAt: action.at,
          etag: action.etag,
        },
        status: `Saved to ${action.path}. Following it again.`,
      };
    }

    case 'commit': {
      if (sameDoc(state.history[state.cursor], action.doc))
        return action.status ? { ...state, status: action.status } : state;
      const moved = state.doc.spec !== action.doc.spec && !state.doc.spec;
      return {
        ...state,
        ...push(state, action.doc),
        // A new document (rather than an edit to this one) resets the view.
        ...(moved ? loaded(action.doc, state) : null),
        ...autoTab(state, action.doc),
        follow: detached(state.follow),
        status: action.status ?? state.status,
        lastEdit: 'commit',
      };
    }

    case 'live':
      return {
        ...state,
        doc: action.doc,
        follow: detached(state.follow),
        lastEdit: 'typed',
      };

    case 'undo':
    case 'redo': {
      const next = Math.max(
        0,
        Math.min(state.history.length - 1, state.cursor + (action.type === 'undo' ? -1 : 1)),
      );
      if (next === state.cursor) return state;
      return {
        ...state,
        cursor: next,
        doc: state.history[next],
        follow: detached(state.follow),
        status: action.type === 'undo' ? 'Previous edit restored.' : 'Edit restored.',
        lastEdit: 'commit',
      };
    }

    case 'restoreBuild': {
      const entry = state.builds[action.index];
      if (!entry) return state;
      return {
        ...state,
        ...push(state, entry.doc),
        ...loaded(entry.doc, state),
        ...autoTab(state, entry.doc),
        follow: detached(state.follow),
        status: `Restored the build from ${new Date(entry.at).toLocaleTimeString()}.`,
      };
    }

    case 'detach':
      return {
        ...state,
        follow: detached(state.follow),
        status: action.status ?? state.status,
      };

    case 'select':
      // Deselecting is also how you leave an isolation: Escape and a click on
      // empty space are the two things everyone already reaches for to get the
      // whole model back, and neither should need to be learned twice.
      return {
        ...state,
        selection: action.selection,
        isolate: action.selection ? state.isolate : null,
      };

    case 'hover':
      return { ...state, hover: action.selection };

    case 'isolate':
      return {
        ...state,
        isolate:
          !action.selection || sameSelection(action.selection, state.isolate)
            ? null
            : action.selection,
      };

    case 'gizmo':
      return { ...state, gizmo: action.mode };

    case 'overlay':
      return {
        ...state,
        overlays: {
          ...state.overlays,
          [action.key]: action.value ?? !state.overlays[action.key],
        },
      };

    case 'clip':
      // The clock belongs to the clip, so switching rewinds rather than
      // seeking a new clip to wherever the old one had got to.
      return {
        ...state,
        playback: {
          ...state.playback,
          clip: action.name,
          time: 0,
          playing: action.name === BIND_POSE ? false : state.playback.playing,
        },
      };

    case 'playing':
      return {
        ...state,
        playback: {
          ...state.playback,
          playing: state.playback.clip === BIND_POSE ? false : action.playing,
        },
      };

    case 'time':
      return { ...state, playback: { ...state.playback, time: action.time } };

    case 'speed':
      return { ...state, playback: { ...state.playback, speed: action.speed } };

    case 'clips': {
      const known =
        action.clips.some((clip) => clip.name === state.playback.clip) ||
        state.playback.clip === BIND_POSE;
      return {
        ...state,
        playback: {
          ...state.playback,
          clips: action.clips,
          clip: known ? state.playback.clip : (action.clips[0]?.name ?? BIND_POSE),
          time: known ? state.playback.time : 0,
        },
      };
    }

    case 'layout':
      return {
        ...state,
        layout: {
          ...state.layout,
          ...action.patch,
          ...(action.patch.left !== undefined
            ? { left: Math.max(MIN.left, action.patch.left) }
            : null),
          ...(action.patch.right !== undefined
            ? { right: Math.max(MIN.right, action.patch.right) }
            : null),
          ...(action.patch.dock !== undefined
            ? { dock: Math.max(MIN.dock, action.patch.dock) }
            : null),
        },
      };

    case 'library':
      return { ...state, library: action.items };

    case 'specs':
      return { ...state, specs: action.specs };

    case 'toast':
      // Four is as many as can be read before the first one goes; an agent
      // writing a folder full of specs should not bury the screen.
      return {
        ...state,
        toasts: [...state.toasts, action.toast].slice(-4),
      };

    case 'untoast':
      return state.toasts.some((toast) => toast.id === action.id)
        ? { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
        : state;

    case 'status':
      return { ...state, status: action.text };

    case 'leftTab':
      return {
        ...state,
        leftTab: action.tab,
        leftTabAuto: false,
        layout: { ...state.layout, leftOpen: true },
      };

    case 'rightTab':
      return { ...state, rightTab: action.tab, layout: { ...state.layout, rightOpen: true } };

    case 'dockTab':
      return { ...state, dockTab: action.tab, layout: { ...state.layout, dockOpen: true } };

    case 'palette':
      return { ...state, palette: action.open };

    case 'modal':
      return { ...state, modal: action.modal };

    case 'busy':
      return { ...state, busy: action.busy };

    case 'surfaceReady':
      return { ...state, surfaceReady: true };

    case 'bootStep':
      // Booting happens once. A later step — a second document, a reconnect —
      // is ordinary work, and covering the studio for it would be a regression
      // dressed as feedback.
      if (state.loading.booted || state.loading.boot === action.step) return state;
      return { ...state, loading: { ...state.loading, boot: action.step } };

    case 'building':
      return {
        ...state,
        loading: {
          ...state.loading,
          build: { id: action.id, since: action.since },
        },
      };

    case 'built': {
      // A build that is not the one in flight is a superseded one landing late;
      // it must not clear the chip belonging to the request that replaced it.
      const current = state.loading.build;
      if (current && current.id !== action.id) return state;
      return { ...state, loading: { boot: null, booted: true, build: null } };
    }
  }
}

/**
 * Which outliner rows differ from the build before this one.
 *
 * "The build before this one" is literal: when the document on screen *is* a
 * logged build, the comparison is against the entry before it, so the marks
 * say what the agent changed. Once the document has been edited away from that
 * build, the comparison is against the newest build instead, so the marks say
 * what the reviewer changed. Either way the answer is "what moved since the
 * last thing that was written down".
 */
export function changedPaths(state: StudioState): ReadonlySet<string> {
  const spec = state.doc.spec;
  if (!spec || !state.builds.length) return NO_CHANGES;
  const at = state.builds.findIndex((entry) => entry.doc === state.doc);
  const previous =
    at >= 0 ? state.builds[at - 1] : state.builds[state.builds.length - 1];
  if (!previous?.doc.spec) return NO_CHANGES;
  return diffSpecs(previous.doc.spec, spec).changed;
}

/**
 * The build the Compare ghost draws: the agent build before this one.
 *
 * The same reading of "before this one" that `changedPaths` uses, for the same
 * reason — when the document on screen is itself a logged build, the ghost is
 * the build it replaced; once it has been edited away from that, the ghost is
 * the newest build, so what you see behind your edit is what the agent wrote.
 * Human saves are skipped: comparing against your own last save would ghost
 * the thing you are looking at.
 */
export function ghostDoc(state: StudioState): Doc | null {
  const at = state.builds.findIndex((entry) => entry.doc === state.doc);
  const upto = at >= 0 ? at : state.builds.length;
  for (let i = upto - 1; i >= 0; i--) {
    const entry = state.builds[i];
    if (entry.origin !== 'agent' || !entry.doc.spec) continue;
    if (entry.doc === state.doc) continue;
    return entry.doc;
  }
  return null;
}

/**
 * Whether Save has anything to write.
 *
 * Three ways to have nothing: no spec (the endpoint only takes specs), no file
 * path to write to (a pointer with no `source`, which happens before the first
 * build lands), and a document identical to the newest thing written.
 */
export function savePath(state: StudioState): string | null {
  if (!state.doc.spec) return null;
  const source = state.follow.source;
  if (!source || !/^[\w./-]+\.json$/.test(source) || source.includes('..'))
    return null;
  return source;
}

/**
 * Whether the document differs from the last thing written down.
 *
 * Close to `canSave` but not the same question, and the difference is the
 * point: `canSave` also needs somewhere to write, so a spec imported from disk
 * with nothing to save back to is not saveable — while it very much is unsaved,
 * and closing the tab would lose it. This is what the dot and the unload
 * warning read, so neither claims a document is safe when it is only stranded.
 */
export function isDirty(state: StudioState): boolean {
  const spec = state.doc.spec;
  if (!spec) return false;
  const last = state.builds[state.builds.length - 1];
  // Nothing has ever been written, so only a document someone made here counts.
  if (!last?.doc.spec) return state.doc.origin === 'human';
  if (last.doc.spec === spec) return false;
  return JSON.stringify(last.doc.spec) !== JSON.stringify(spec);
}

export function canSave(state: StudioState): boolean {
  // Not while a build is in flight. The spec is already written down, so this
  // is not about correctness — it is that Save records the triangle count and
  // the verdict of what was built, and the build that produced those numbers
  // is the one being replaced.
  if (state.loading.build) return false;
  if (!savePath(state)) return false;
  const last = state.builds[state.builds.length - 1];
  if (!last?.doc.spec) return true;
  return JSON.stringify(last.doc.spec) !== JSON.stringify(state.doc.spec);
}

export function canUndo(state: StudioState) {
  return state.cursor > 0;
}

export function canRedo(state: StudioState) {
  return state.cursor < state.history.length - 1;
}
