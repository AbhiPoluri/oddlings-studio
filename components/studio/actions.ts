/**
 * Every operation the studio can perform, written down once.
 *
 * The keymap, the menus, the toolbar buttons and the ⌘K palette are all reads
 * of this table rather than four separate lists that drift apart — the old page
 * had a shortcut the menu did not mention and a button with no shortcut, which
 * is what happens when the same operation is spelled out in four places.
 *
 * An entry is data: `enabled` is a pure predicate over the state, and `run`
 * only ever talks to the context it is handed, so the table itself can be
 * checked (ids unique, no two enabled actions claiming one key) without a DOM.
 */
import type { ViewHandle, ViewName } from '@/components/asset-viewport';
import { BIND_POSE } from '@/components/timeline';
import {
  canRedo,
  canSave,
  canUndo,
  type GizmoMode,
  type Overlays,
  type StudioAction,
  type StudioState,
} from './reducer';

export type ExportFormat = 'glb' | 'obj' | 'unity' | 'json';
export type NewKind = 'empty' | 'blueprint' | 'import' | 'url';

/** What an action is allowed to reach. Types only — nothing here touches the DOM. */
export type ActionContext = {
  state: StudioState;
  dispatch: (action: StudioAction) => void;
  /** The three.js viewport's imperative handle, or null before it mounts. */
  view: () => ViewHandle | null;
  /** The canvas, for the gizmo modes the viewport owns outright. */
  canvas: () => HTMLCanvasElement | null;
  save: () => void;
  exportAs: (format: ExportFormat) => void;
  create: (kind: NewKind) => void;
  /** Re-point the page at whatever it was following when it loaded. */
  reattach: () => void;
  /** Follow one spec file by project-relative path, pinning the page to it. */
  openSpec: (path: string) => void;
  /** Put the caret in the outliner's filter box. */
  focusFilter: () => void;
  removeSelected: () => void;
  duplicateSelected: () => void;
};

export type StudioCommand = {
  id: string;
  label: string;
  group: string;
  /** Canonical chords, e.g. `Mod+Shift+Z`. `Mod` is ⌘ on a Mac, Ctrl elsewhere. */
  keys?: string[];
  /**
   * True when `AssetViewport` answers this key itself on the focused canvas.
   *
   * The global handler stands back for those, so one press is one action; the
   * entry still exists so the palette and the menus can run it from anywhere.
   */
  canvasOwned?: boolean;
  enabled: (state: StudioState) => boolean;
  run: (context: ActionContext) => void;
};

const always = () => true;
const hasSpec = (state: StudioState) => Boolean(state.doc.spec);
const hasPart = (state: StudioState) => state.selection?.kind === 'part';

/**
 * Ask the viewport to change gizmo mode.
 *
 * `AssetViewport` keeps its mode in its own state with no prop to set it, and
 * that file is not ours to change — but it does listen for `g`/`r`/`s` on the
 * canvas, and it refuses rotate and scale while a bone is selected. Replaying
 * the key is therefore not a workaround for a missing prop so much as the only
 * way to drive it without duplicating the bone rule in two places.
 */
function gizmoKey(context: ActionContext, key: string, mode: GizmoMode) {
  const canvas = context.canvas();
  if (!canvas) return;
  canvas.focus();
  canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: false, cancelable: true }),
  );
  context.dispatch({ type: 'gizmo', mode });
}

function overlay(
  id: string,
  key: keyof Overlays,
  label: string,
  shortcut: string,
): StudioCommand {
  return {
    id,
    label,
    group: 'Overlays',
    keys: [shortcut],
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'overlay', key }),
  };
}

function cameraView(
  id: string,
  which: ViewName,
  label: string,
  key: string,
): StudioCommand {
  return {
    id,
    label,
    group: 'View',
    keys: [key],
    canvasOwned: true,
    enabled: always,
    run: (context) => context.view()?.view(which),
  };
}

export const COMMANDS: StudioCommand[] = [
  // — Selection ————————————————————————————————————————————————
  {
    id: 'select.none',
    label: 'Deselect',
    group: 'Selection',
    keys: ['Escape'],
    canvasOwned: true,
    // Also the way out of an isolation, which `select: null` clears.
    enabled: (state) => Boolean(state.selection || state.isolate),
    run: ({ dispatch }) => dispatch({ type: 'select', selection: null }),
  },
  {
    id: 'select.filter',
    label: 'Filter parts',
    group: 'Selection',
    keys: ['Mod+F'],
    enabled: hasSpec,
    run: (context) => {
      context.dispatch({ type: 'leftTab', tab: 'outliner' });
      context.focusFilter();
    },
  },

  // — Framing and camera ——————————————————————————————————————
  {
    id: 'view.frameSelected',
    label: 'Frame selected',
    group: 'View',
    keys: ['F'],
    canvasOwned: true,
    enabled: (state) => Boolean(state.selection),
    run: (context) => context.view()?.frame(context.state.selection),
  },
  {
    id: 'view.frameAll',
    label: 'Frame all',
    group: 'View',
    keys: ['Home'],
    canvasOwned: true,
    enabled: always,
    run: (context) => context.view()?.frame(null),
  },
  {
    id: 'view.isolate',
    label: 'Isolate selected',
    group: 'View',
    keys: ['/'],
    // The viewport answers this key itself and reports back through
    // `onIsolate`; without this the focused canvas and the window would both
    // flip the isolation on one press, which is no press at all.
    canvasOwned: true,
    enabled: (state) => Boolean(state.doc.spec && (state.selection || state.isolate)),
    run: ({ dispatch, state }) =>
      dispatch({ type: 'isolate', selection: state.selection ?? state.isolate }),
  },
  cameraView('view.persp', 'persp', 'Perspective view', '5'),
  cameraView('view.front', 'front', 'Front view', '1'),
  cameraView('view.back', 'back', 'Back view', 'Mod+1'),
  cameraView('view.right', 'right', 'Right view', '3'),
  cameraView('view.left', 'left', 'Left view', 'Mod+3'),
  cameraView('view.top', 'top', 'Top view', '7'),
  cameraView('view.bottom', 'bottom', 'Bottom view', 'Mod+7'),

  // — Gizmo ————————————————————————————————————————————————————
  {
    id: 'gizmo.move',
    label: 'Move tool',
    group: 'Gizmo',
    keys: ['G'],
    canvasOwned: true,
    enabled: hasSpec,
    run: (context) => gizmoKey(context, 'g', 'translate'),
  },
  {
    id: 'gizmo.rotate',
    label: 'Rotate tool',
    group: 'Gizmo',
    keys: ['R'],
    canvasOwned: true,
    enabled: hasSpec,
    run: (context) => gizmoKey(context, 'r', 'rotate'),
  },
  {
    id: 'gizmo.scale',
    label: 'Scale tool',
    group: 'Gizmo',
    keys: ['S'],
    canvasOwned: true,
    enabled: hasSpec,
    run: (context) => gizmoKey(context, 's', 'scale'),
  },

  // — Overlays ————————————————————————————————————————————————
  overlay('toggle.wireframe', 'wireframe', 'Wireframe', 'Z'),
  overlay('toggle.grid', 'grid', 'Grid', 'H'),
  overlay('toggle.skeleton', 'skeleton', 'Skeleton', 'B'),
  overlay('toggle.pixel', 'pixel', 'Pixel preview', 'P'),
  overlay('toggle.rotate', 'rotate', 'Turntable', 'T'),

  // — Editing ——————————————————————————————————————————————————
  {
    id: 'edit.delete',
    label: 'Delete selected',
    group: 'Edit',
    keys: ['Delete', 'Backspace'],
    canvasOwned: true,
    enabled: (state) => Boolean(state.doc.spec && state.selection),
    run: (context) => context.removeSelected(),
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate selected',
    group: 'Edit',
    keys: ['Mod+D'],
    canvasOwned: true,
    enabled: (state) => Boolean(state.doc.spec) && hasPart(state),
    run: (context) => context.duplicateSelected(),
  },
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'Edit',
    keys: ['Mod+Z'],
    enabled: canUndo,
    run: ({ dispatch }) => dispatch({ type: 'undo' }),
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'Edit',
    keys: ['Mod+Shift+Z'],
    enabled: canRedo,
    run: ({ dispatch }) => dispatch({ type: 'redo' }),
  },

  // — File ——————————————————————————————————————————————————————
  {
    id: 'file.save',
    label: 'Save to the followed file',
    group: 'File',
    keys: ['Mod+S'],
    enabled: canSave,
    run: (context) => context.save(),
  },
  {
    id: 'file.new.empty',
    label: 'New empty spec',
    group: 'File',
    enabled: always,
    run: (context) => context.create('empty'),
  },
  {
    id: 'file.new.blueprint',
    label: 'New from blueprint…',
    group: 'File',
    enabled: always,
    run: (context) => context.create('blueprint'),
  },
  {
    id: 'file.new.import',
    label: 'Import file…',
    group: 'File',
    enabled: always,
    run: (context) => context.create('import'),
  },
  {
    id: 'file.new.url',
    label: 'Open URL…',
    group: 'File',
    enabled: always,
    run: (context) => context.create('url'),
  },
  {
    id: 'file.export.glb',
    label: 'Export GLB',
    group: 'File',
    enabled: (state) => !state.busy,
    run: (context) => context.exportAs('glb'),
  },
  {
    id: 'file.export.obj',
    label: 'Export OBJ + MTL',
    group: 'File',
    enabled: (state) => !state.busy,
    run: (context) => context.exportAs('obj'),
  },
  {
    id: 'file.export.unity',
    label: 'Export Unity pack',
    group: 'File',
    enabled: (state) => !state.busy,
    run: (context) => context.exportAs('unity'),
  },
  {
    id: 'file.export.json',
    label: 'Export spec JSON',
    group: 'File',
    enabled: (state) => !state.busy,
    run: (context) => context.exportAs('json'),
  },

  // — Follow ————————————————————————————————————————————————————
  {
    id: 'follow.attach',
    label: 'Follow the latest build',
    group: 'Follow',
    enabled: (state) => state.follow.status !== 'live',
    run: (context) => context.reattach(),
  },
  {
    id: 'follow.detach',
    label: 'Stop following',
    group: 'Follow',
    enabled: (state) => state.follow.status === 'live',
    run: ({ dispatch }) =>
      dispatch({
        type: 'detach',
        status: 'Stopped following. This document is yours now.',
      }),
  },

  // — Playback ——————————————————————————————————————————————————
  {
    id: 'play.toggle',
    label: 'Play / pause',
    group: 'Playback',
    keys: [' '],
    canvasOwned: true,
    enabled: (state) => state.playback.clip !== BIND_POSE,
    run: ({ dispatch, state }) =>
      dispatch({ type: 'playing', playing: !state.playback.playing }),
  },
  {
    id: 'play.next',
    label: 'Next clip',
    group: 'Playback',
    keys: [']'],
    enabled: (state) => state.playback.clips.length > 0,
    run: ({ dispatch, state }) => dispatch({ type: 'clip', name: stepClip(state, 1) }),
  },
  {
    id: 'play.prev',
    label: 'Previous clip',
    group: 'Playback',
    keys: ['['],
    enabled: (state) => state.playback.clips.length > 0,
    run: ({ dispatch, state }) => dispatch({ type: 'clip', name: stepClip(state, -1) }),
  },

  // — Panels ————————————————————————————————————————————————————
  {
    id: 'panel.left',
    label: 'Toggle the left column',
    group: 'Panels',
    keys: ['Mod+B'],
    enabled: always,
    run: ({ dispatch, state }) =>
      dispatch({ type: 'layout', patch: { leftOpen: !state.layout.leftOpen } }),
  },
  {
    id: 'panel.right',
    label: 'Toggle the right column',
    group: 'Panels',
    keys: ['Mod+I'],
    enabled: always,
    run: ({ dispatch, state }) =>
      dispatch({ type: 'layout', patch: { rightOpen: !state.layout.rightOpen } }),
  },
  {
    id: 'panel.dock',
    label: 'Toggle the bottom dock',
    group: 'Panels',
    keys: ['Mod+J'],
    enabled: always,
    run: ({ dispatch, state }) =>
      dispatch({ type: 'layout', patch: { dockOpen: !state.layout.dockOpen } }),
  },
  {
    id: 'panel.projects',
    label: 'Show projects',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'leftTab', tab: 'projects' }),
  },
  {
    id: 'panel.outliner',
    label: 'Show the outliner',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'leftTab', tab: 'outliner' }),
  },
  {
    id: 'panel.library',
    label: 'Show the library',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'leftTab', tab: 'library' }),
  },
  {
    id: 'panel.properties',
    label: 'Show properties',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'rightTab', tab: 'properties' }),
  },
  {
    id: 'panel.checks',
    label: 'Show checks',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'rightTab', tab: 'checks' }),
  },
  {
    id: 'panel.asset',
    label: 'Show asset settings',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'rightTab', tab: 'asset' }),
  },
  {
    id: 'panel.json',
    label: 'Show the spec JSON',
    group: 'Panels',
    enabled: hasSpec,
    run: ({ dispatch }) => dispatch({ type: 'rightTab', tab: 'json' }),
  },
  {
    id: 'panel.timeline',
    label: 'Show the timeline',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'dockTab', tab: 'timeline' }),
  },
  {
    id: 'panel.builds',
    label: 'Show the build log',
    group: 'Panels',
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'dockTab', tab: 'builds' }),
  },
  {
    id: 'palette.open',
    label: 'Command palette',
    group: 'Panels',
    keys: ['Mod+K'],
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'palette', open: true }),
  },
  {
    id: 'help.shortcuts',
    label: 'Keyboard shortcuts',
    group: 'Help',
    // Both spellings: `chordOf` reports the modifier actually pressed, and
    // whether `?` needs Shift is a property of the keyboard layout rather than
    // of the key — so a layout where it does not must still open this.
    keys: ['Shift+?', '?'],
    enabled: always,
    run: ({ dispatch }) => dispatch({ type: 'modal', modal: 'shortcuts' }),
  },
];

/** The clip `by` places along from the current one, wrapping at both ends. */
function stepClip(state: StudioState, by: number): string {
  const names = [BIND_POSE, ...state.playback.clips.map((clip) => clip.name)];
  const at = names.indexOf(state.playback.clip);
  return names[(at + by + names.length) % names.length];
}

export const COMMAND_BY_ID = new Map(
  COMMANDS.map((command) => [command.id, command] as const),
);

export function runCommand(id: string, context: ActionContext) {
  const command = COMMAND_BY_ID.get(id);
  if (command?.enabled(context.state)) command.run(context);
}
