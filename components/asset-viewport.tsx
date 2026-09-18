'use client';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Move3d, Rotate3d, Scale3d } from 'lucide-react';
import { stats } from '@/lib/asset-export';
import type { AssetSpec } from '@/lib/asset-spec';
import type { BuildPhase } from '@/lib/asset-surface';
import { gauge } from '@/lib/perf';
import { createBuildClient, type BuildClient } from '@/lib/build-client';
import {
  frameIsExact,
  frameOf,
  partAt,
  samePath,
  sameSelection,
  selectedPath,
  transformPatch,
  type Path,
  type PartPatch,
  type Selection,
  type TransformDelta,
  type Vec3,
} from '@/lib/spec-edit';
import { disposeScene, lighting } from '@/lib/three-world';
import { skeletonOf } from '@/lib/asset-rig';
import { boneLayout, clipsOf } from '@/lib/asset-joints';
import type { Recipe } from '@/lib/asset-recipe';
/** The canned camera angles, named the way an author asks for them. */
export type ViewName =
  | 'front'
  | 'back'
  | 'right'
  | 'left'
  | 'top'
  | 'bottom'
  | 'persp';
export type ViewHandle = {
  capture: () => string;
  home: () => void;
  front: () => void;
  /** Fit the camera to one selection, or to the whole model with `null`. */
  frame: (selection: Selection) => void;
  /** Turn the camera to an axis, or back to the three-quarter view. */
  view: (which: ViewName) => void;
};
export type AssetStats = ReturnType<typeof stats> & {
  /** Frames drawn in the last second; absent until a second has passed. */
  fps?: number;
};
type Mode = 'translate' | 'rotate' | 'scale';
type Props = {
  recipe: Recipe;
  /** When set, the viewport previews this agent-authored spec instead. */
  spec?: AssetSpec | null;
  /** The part to outline or the bone to handle, shared with the editor panel. */
  selected?: Selection;
  /** Clicking a part, a bone handle, or empty space picks what the panel edits. */
  onSelect?: (selection: Selection) => void;
  /** One finished gizmo drag, as a single patch to the authored part. */
  onTransform?: (path: Path, patch: PartPatch) => void;
  /** One finished bone drag, as an absolute unscaled model-space position. */
  onMoveBone?: (name: string, at: Vec3) => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  pixel: boolean;
  wireframe: boolean;
  grid: boolean;
  rotate: boolean;
  animation: string;
  skeleton: boolean;
  speed: number;
  /**
   * Whether the clip runs itself. Left out it does, which is what the viewport
   * has always done; false hands the clock to `time` so a scrubber can drive it.
   */
  playing?: boolean;
  /** Seconds into the current clip, honoured only while `playing` is false. */
  time?: number;
  /** Where the running clip has got to, ~10 times a second, never while paused. */
  onTime?: (seconds: number) => void;
  /** The clips the built asset exports, reported after every model build. */
  onClips?: (clips: { name: string; duration: number }[]) => void;
  /** A second, dimmer outline: what the pointer or the outliner is over. */
  hover?: Selection;
  /** What the pointer is over, so the outliner can highlight in reverse. */
  onHover?: (selection: Selection) => void;
  /** Space asks for playback to flip; the owner of `playing` decides. */
  onPlayToggle?: () => void;
  /**
   * Draw one part or bone alone: everything else is hidden, or dimmed to a
   * ghost where it shares a mesh with what is isolated.
   *
   * Left out entirely, the viewport keeps this itself, so `/` works on a page
   * that has not wired it up — the controlled-input pattern, where supplying
   * the prop takes ownership of the state.
   */
  isolate?: Selection | null;
  /** `/` asks for isolation to flip; the owner of `isolate` decides. */
  onIsolate?: (selection: Selection) => void;
  /**
   * A second asset drawn behind this one, transparent and unpickable.
   *
   * What it is for is comparison: the build the agent made before the one on
   * screen, so a part that moved reads as a part that moved rather than as a
   * part you have to remember. Deliberately a whole spec rather than a diff —
   * the studio already knows how to build one of these, and a ghost assembled
   * out of the parts that changed would be a second, subtly different builder.
   *
   * Pass a stable reference. This is rebuilt whenever the value changes, and a
   * fresh object every render would rebuild every frame.
   */
  ghost?: AssetSpec | Recipe | null;
  /** Draw the ghost as wireframe, for reading a silhouette through a solid. */
  ghostWire?: boolean;
  onStats: (s: AssetStats) => void;
  /**
   * The model this viewport just built, handed over for anyone else to read.
   *
   * The shell used to build a second copy of every spec to run the audit on,
   * which doubled the cost of every edit for a result identical to the one
   * already standing in the scene. Auditing is a read-only traversal, so the
   * viewport lends its model instead. Null while a build is in flight and the
   * spec on screen is the previous one.
   */
  onModel?: (model: T.Object3D | null) => void;
  /** A build was asked for, or the one in flight finished. */
  onBuild?: (
    event: { id: number; since: number } | { id: number; done: true },
  ) => void;
  /**
   * How the current document last changed, which decides whether to wait.
   *
   * Typing in a number field produces an edit per keystroke, and a surface
   * spec takes a second to build; without a pause the worker spends the whole
   * sentence building prefixes of it. A gizmo drag or a file load is already
   * one edit, and waiting on those would only add lag.
   */
  lastEdit?: 'typed' | 'commit' | 'load';
};

/**
 * The two snap grids, coarse for Shift and fine for ⌘ or Ctrl.
 *
 * `move` is in metres of authored space rather than of world space: a spec is
 * drawn at `spec.scale`, so the gizmo is given `move × scale` and the number
 * that lands in the spec is the round one. `turn` is in degrees and `grow` is
 * a ratio, and both of those the gizmo already measures from where the drag
 * began — so they need no correction.
 */
const SNAP = {
  coarse: { move: 0.01, turn: 5, grow: 0.05, label: ['1 cm', '5°', '0.05×'] },
  fine: { move: 0.001, turn: 1, grow: 0.01, label: ['1 mm', '1°', '0.01×'] },
} as const;
type SnapKind = keyof typeof SNAP;
const SNAP_COLUMN: Record<Mode, 0 | 1 | 2> = {
  translate: 0,
  rotate: 1,
  scale: 2,
};
/**
 * What one live gizmo drag is moving.
 *
 * `updatePart` reparses the spec and the viewport rebuilds every mesh from it,
 * so writing the spec per frame would rebuild a thousand meshes a frame and
 * bury the undo history under one entry per pointer move. Nothing here touches
 * the spec: the proxy and the meshes already on screen move instead, and the
 * whole drag commits once on release.
 */
type Drag = {
  /** The part being dragged; null when the gizmo is on a bone handle. */
  path: Path | null;
  /** The bone being dragged; null when the gizmo is on a part. */
  bone: string | null;
  pivot: T.Vector3;
  startInverse: T.Matrix4;
  position: T.Vector3;
  quaternion: T.Quaternion;
  scale: T.Vector3;
  moved: { object: T.Object3D; base: T.Matrix4; parentInverse: T.Matrix4 }[];
  /** The parent frame as built, for the paths the spec cannot describe. */
  measured: T.Matrix4 | null;
};
type Runtime = {
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  camera: T.PerspectiveCamera;
  controls: OrbitControls;
  transform: TransformControls;
  /**
   * What the gizmo is actually attached to.
   *
   * One authored part can be many meshes, and in surface mode it is a slice of
   * one fused mesh with no object of its own — so the gizmo never grabs a mesh.
   * It grabs an empty placed at the union centre of every copy, and the drag is
   * read back off that.
   */
  proxy: T.Object3D;
  outline: T.Box3Helper;
  /** The dimmer outline round whatever is hovered, drawn in world space. */
  hoverBox: T.Box3Helper;
  /**
   * The authored skeleton, drawn over the model.
   *
   * Deliberately not the `SkeletonHelper` behind "Show skeleton": that one
   * draws the bones of the *built* model, which are posed by whatever clip is
   * playing. These sit at the positions the spec asks for, which is the thing
   * an author is editing and the only place a handle can honestly be dragged.
   */
  handles: T.Group;
  /** A box round the geometry the selected bone carries. */
  bound: T.Box3Helper;
  /** Handle radius in world units, sized off the model so scale 40 works too. */
  handleSize: number;
  model: T.Group | null;
  mixer: T.AnimationMixer | null;
  /** The action the chosen clip is running on, or null in the bind pose. */
  action: T.AnimationAction | null;
  /** The last measured build, kept so the frame rate can ride along with it. */
  metrics: AssetStats | null;
  helper: T.SkeletonHelper | null;
  /**
   * The previous build, drawn through. Never inside `model`, which is what
   * keeps it out of the picker, the framing and the statistics for free.
   */
  ghost: T.Group | null;
  grid: T.GridHelper;
  floor: T.Mesh;
  fit: () => void;
  resize: () => void;
  /**
   * Ask the render loop for a few more frames.
   *
   * The loop idles when nothing is moving, so anything that changes what the
   * scene looks like without moving the camera or the clock has to say so.
   */
  wake: () => void;
  place: (selection: Selection) => void;
  /** Fit the camera to one selection, or to the whole model with `null`. */
  frame: (selection: Selection) => void;
  /** Turn the camera to an axis view without changing how far out it sits. */
  view: (which: ViewName) => void;
  /** What isolation has done to the built model, or null when it is off. */
  isolation: Isolation | null;
  /** Draw one selection alone, or everything again with `null`. */
  isolate: (selection: Selection) => void;
  /** Put every mesh isolation touched back exactly as it was. */
  unisolate: () => void;
  /** Redraw the bone handles from the current spec. */
  rig: () => void;
  /** Redraw the hover outline from the `hover` prop. */
  hint: () => void;
  /** Bind pose while a bone is selected; the chosen clip otherwise. */
  pose: () => void;
};

/**
 * The ghost's ink.
 *
 * Cool and cold on purpose: `--primary` is the studio's lime, reserved for
 * what is selected and what is live, and a ghost in that colour would read as
 * a selection. This one reads as "not the thing you are editing".
 */
const GHOST_TINT = '#7fb0d8';

/** How far the orbit may tip before it would look up from under the floor. */
const ORBIT_CEILING = Math.PI * 0.49;

/**
 * Where the camera sits for each axis view, as a direction from the target.
 *
 * `front` looks back down −Z, because +Z is the front of every authored asset.
 * Straight up and straight down leave the orbit's azimuth undefined, so both
 * poles are nudged a thousandth off true — invisible, and stable to orbit from.
 */
const VIEW_AXIS: Record<Exclude<ViewName, 'persp'>, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0.001],
  bottom: [0, -1, 0.001],
};

/** The view keys, as [plain, with ⌘ or Ctrl]. `5` has no opposite face. */
const VIEW_KEY: Record<string, [ViewName, ViewName]> = {
  '1': ['front', 'back'],
  '3': ['right', 'left'],
  '7': ['top', 'bottom'],
  '5': ['persp', 'persp'],
};

const CORNER: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/**
 * Which authored part each vertex of a fused surface mesh came from.
 *
 * `paint` in `asset-surface` writes it, and the rigger, the audit, the picker
 * and isolation all read it: in surface mode it is the only thing that still
 * knows a part exists, because the parts themselves have been blended away.
 */
type SurfaceOwners = { index: Uint16Array; paths: (Path | undefined)[] };

/** A skinning attribute, however the geometry happens to store it. */
type Slot = T.BufferAttribute | T.InterleavedBufferAttribute;

/** True when `path` is, or sits under, `root` — what isolating a part keeps. */
function underPath(path: Path | undefined, root: Path) {
  if (!path || path.length < root.length) return false;
  for (let i = 0; i < root.length; i++) if (path[i] !== root[i]) return false;
  return true;
}

/**
 * Whether one vertex is carried by `bone`.
 *
 * A body rig blends two bones per vertex (`rigCreature` writes `a, b` with
 * weights `1-t, t`), so "carries" means the bone holding more than half the
 * weight — slot x alone would miss half of every blended limb. Shared by the
 * bone's bounding box and by isolation, so framing a bone and isolating it can
 * never disagree about what it holds.
 */
function boneHolds(index: Slot, weight: Slot | undefined, i: number, bone: number) {
  return (
    (index.getX(i) === bone && (!weight || weight.getX(i) >= 0.5)) ||
    (index.getY(i) === bone && Boolean(weight) && weight!.getY(i) > 0.5)
  );
}

/** The world box of every mesh an authored part became. */
/**
 * Which vertices of a fused surface mesh belong to which authored part.
 *
 * Read once per model instead of once per hover. The owner table is a parallel
 * array over every vertex, so answering "where is this part" by scanning it
 * meant walking twelve thousand vertices every time the pointer crossed a
 * different part — thirty times a second while the pointer is moving, for an
 * outline. Grouping is the same walk done once; the box is then measured from
 * the part's own vertices, so it still follows the model as a clip poses it.
 *
 * Weak, so a model thrown away by a rebuild takes its table with it.
 */
const owned = new WeakMap<T.BufferGeometry, Map<string, number[]>>();

function ownedVertices(geometry: T.BufferGeometry, owners: SurfaceOwners) {
  let table = owned.get(geometry);
  if (table) return table;
  table = new Map<string, number[]>();
  for (let i = 0; i < owners.index.length; i++) {
    const path = owners.paths[owners.index[i]];
    if (!path) continue;
    const key = path.join('.');
    const list = table.get(key);
    if (list) list.push(i);
    else table.set(key, [i]);
  }
  owned.set(geometry, table);
  return table;
}

function worldBounds(model: T.Object3D, path: Path) {
  const box = new T.Box3();
  const key = path.join('.');
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (samePath((object.userData.specPath as Path | undefined) ?? null, path)) {
      box.expandByObject(object);
      return;
    }
    // Surface mode leaves one fused mesh, so the part is a set of vertices
    // rather than an object: the owner table is the only way back to it.
    const owners = object.geometry.userData.surfaceOwners as
      | SurfaceOwners
      | undefined;
    if (!owners) return;
    const mine = ownedVertices(object.geometry, owners).get(key);
    if (!mine) return;
    const position = object.geometry.attributes.position;
    const point = new T.Vector3();
    object.updateMatrixWorld();
    for (const i of mine)
      box.expandByPoint(
        point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld),
      );
  });
  return box;
}

/**
 * The world box of the geometry one bone carries, in the bind pose.
 *
 * Read off the geometry through the model's own matrix rather than off the
 * posed vertices, so it answers the same whatever clip happens to be playing.
 * A body rig blends two bones per vertex (`rigCreature` writes `a, b` with
 * weights `1-t, t`), so "carries" means the bone holding more than half the
 * weight — slot x alone would miss half of every blended limb.
 */
function boneBounds(model: T.Object3D, bone: number) {
  const box = new T.Box3();
  const point = new T.Vector3();
  model.traverse((object) => {
    if (!(object instanceof T.SkinnedMesh)) return;
    const index = object.geometry.attributes.skinIndex;
    const weight = object.geometry.attributes.skinWeight;
    const position = object.geometry.attributes.position;
    if (!index || !position) return;
    object.updateMatrixWorld();
    for (let i = 0; i < position.count; i++) {
      if (boneHolds(index, weight, i, bone))
        box.expandByPoint(
          point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld),
        );
    }
  });
  return box;
}

/**
 * The triangles of one mesh an isolate selection keeps: all of them, none of
 * them, or an index listing the ones it owns.
 *
 * A faceted build answers with the whole mesh, because a part there *is* a
 * mesh. A fused surface mesh and a skinned mesh answer per vertex, because
 * there the part or the bone is a set of vertices inside something larger — so
 * the caller is handed an index it can draw on its own.
 *
 * A triangle is kept on a majority of its corners rather than on all three:
 * neighbouring parts of a fused shell share their boundary vertices, and
 * demanding three would shave a ring of triangles off every edge of the thing
 * being isolated.
 */
function ownedTriangles(
  mesh: T.Mesh,
  selection: NonNullable<Selection>,
  bone: number,
): 'all' | 'none' | number[] {
  const position = mesh.geometry.attributes.position;
  if (!position) return 'none';
  const flags = new Uint8Array(position.count);
  let owned = 0;
  if (selection.kind === 'part') {
    const direct = mesh.userData.specPath as Path | undefined;
    if (direct) return underPath(direct, selection.path) ? 'all' : 'none';
    const owners = mesh.geometry.userData.surfaceOwners as
      | SurfaceOwners
      | undefined;
    if (!owners) return 'none';
    for (let i = 0; i < position.count; i++)
      if (underPath(owners.paths[owners.index[i]], selection.path)) {
        flags[i] = 1;
        owned++;
      }
  } else {
    if (!(mesh instanceof T.SkinnedMesh)) return 'none';
    const index = mesh.geometry.attributes.skinIndex;
    if (!index) return 'none';
    const weight = mesh.geometry.attributes.skinWeight;
    for (let i = 0; i < position.count; i++)
      if (boneHolds(index, weight, i, bone)) {
        flags[i] = 1;
        owned++;
      }
  }
  if (!owned) return 'none';
  if (owned === position.count) return 'all';
  const index = mesh.geometry.getIndex();
  const corners = index ? index.count : position.count;
  const kept: number[] = [];
  for (let t = 0; t + 2 < corners; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    if (flags[a] + flags[b] + flags[c] >= 2) kept.push(a, b, c);
  }
  return kept;
}

/**
 * A second mesh over an existing one, drawing only the triangles in `kept`.
 *
 * The vertex attributes are shared by reference rather than copied: a fused
 * surface mesh is tens of thousands of vertices, and the only thing this mesh
 * needs of its own is the index. `unisolate` drops the borrowed attributes
 * before disposing, so freeing this mesh never frees buffers the model is
 * still drawing from. The `userData` of both the object and the geometry is
 * shared too, so a click on the slice resolves to the same authored part as a
 * click on the mesh it was cut from.
 */
function sliceOf(source: T.Mesh, kept: number[]) {
  const geometry = new T.BufferGeometry();
  for (const name of Object.keys(source.geometry.attributes))
    geometry.setAttribute(name, source.geometry.attributes[name]);
  geometry.setIndex(kept);
  geometry.userData = source.geometry.userData;
  const slice =
    source instanceof T.SkinnedMesh
      ? new T.SkinnedMesh(geometry, source.material)
      : new T.Mesh(geometry, source.material);
  slice.name = `${source.name}-isolated`;
  slice.userData = source.userData;
  slice.position.copy(source.position);
  slice.quaternion.copy(source.quaternion);
  slice.scale.copy(source.scale);
  slice.castShadow = source.castShadow;
  slice.receiveShadow = source.receiveShadow;
  slice.renderOrder = source.renderOrder;
  if (slice instanceof T.SkinnedMesh && source instanceof T.SkinnedMesh) {
    slice.bindMode = source.bindMode;
    slice.bind(source.skeleton, source.bindMatrix);
  }
  return slice;
}

/** The ghost a part-owning mesh is drawn as while something else is isolated. */
function ghostOf(material: T.Material) {
  const ghost = material.clone();
  ghost.transparent = true;
  ghost.opacity = 0.08;
  // Without this the ghost would occlude the isolated part hanging inside it.
  ghost.depthWrite = false;
  return ghost;
}

/**
 * Everything isolation changed about the built model, so it can be put back.
 *
 * Kept as a record rather than recomputed on the way out, because "what it was
 * before" is not derivable from the scene once the materials have been swapped
 * — and a rebuild disposes the meshes, so the originals have to be handed back
 * before that happens or the ghost is disposed and the real material leaks.
 */
type Isolation = {
  hidden: T.Mesh[];
  dimmed: { mesh: T.Mesh; material: T.Material | T.Material[]; shadow: boolean }[];
  /** The meshes drawing the owned triangles, added beside what they came from. */
  slices: T.Mesh[];
  /** The ghost materials, ours to dispose. */
  made: T.Material[];
};

/**
 * How far back the camera has to sit for a box to fill the frame.
 *
 * The same arithmetic `fit` does on the whole model, written out here because
 * `frame` has to do it to a single part's box as well.
 */
function framingDistance(box: T.Box3) {
  const radius = Math.max(1e-4, box.getSize(new T.Vector3()).length() * 0.5);
  return (radius / Math.sin(T.MathUtils.degToRad(18))) * 1.2;
}

/**
 * The world box a selection occupies.
 *
 * A part is every copy of its path, surface slices included. A bone is its
 * handle together with the geometry it carries, so framing a wrist shows the
 * hand rather than an empty point in the middle of one.
 */
function selectionBounds(
  model: T.Object3D,
  spec: AssetSpec | null | undefined,
  selection: Selection,
  handleSize: number,
) {
  if (!selection) return null;
  if (selection.kind === 'part') {
    const box = worldBounds(model, selection.path);
    return box.isEmpty() ? null : box;
  }
  if (!spec) return null;
  const layout = boneLayout(spec);
  const index = layout.findIndex((bone) => bone.name === selection.name);
  if (index < 0) return null;
  const at = new T.Vector3(
    layout[index].at[0] * spec.scale,
    layout[index].at[1] * spec.scale,
    layout[index].at[2] * spec.scale,
  );
  const reach = handleSize * 1.9;
  const box = new T.Box3(
    at.clone().subScalar(reach),
    at.clone().addScalar(reach),
  );
  const carried = boneBounds(model, index);
  if (!carried.isEmpty()) box.union(carried);
  return box;
}

/** Whether a key event is someone typing, and so none of the canvas's business. */
function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * How long a typed edit waits before the worker is asked to build it.
 *
 * Long enough that a two-digit number is one build rather than two, short
 * enough that it reads as immediate. Only typing waits; a committed gizmo drag
 * and a file load go straight out.
 */
const TYPING_PAUSE = 150;

/**
 * The quiet "still working" chip in the viewport's corner.
 *
 * Two rules it exists to keep. It does not appear for a build that finishes
 * quickly, because a label that flashes on every keystroke is worse than no
 * label. And the elapsed clock ticks in here, on a local interval, rather than
 * in the store: a studio that dispatched ten times a second to animate a
 * counter would re-render every panel to do it, which is the exact cost this
 * whole change is about removing.
 */
function BuildingChip({
  since,
  phase,
}: {
  since: number;
  phase?: BuildPhase;
}) {
  const [elapsed, setElapsed] = useState(() => performance.now() - since);
  useEffect(() => {
    const tick = setInterval(() => setElapsed(performance.now() - since), 100);
    return () => clearInterval(tick);
  }, [since]);
  if (elapsed < CHIP_DELAY) return null;
  return (
    <p className="viewport-building" role="status">
      <span className="viewport-building-dot" aria-hidden />
      {phase ? PHASE_LABEL[phase] : 'building'}
      {elapsed >= 300 ? <span className="tabular">{Math.round(elapsed)} ms</span> : null}
    </p>
  );
}

/** What each build stage is called in the chip. */
const PHASE_LABEL: Record<BuildPhase, string> = {
  parts: 'placing parts',
  sampling: 'sampling',
  meshing: 'meshing',
  decimating: 'decimating',
  painting: 'painting',
  skinning: 'skinning',
};

/** Below this, a build is fast enough that saying so would only flicker. */
const CHIP_DELAY = 120;

/** A clip time folded back into [0, duration). */
function wrapTime(at: number, duration: number) {
  if (!(duration > 0)) return 0;
  return ((at % duration) + duration) % duration;
}

export const AssetViewport = forwardRef<ViewHandle, Props>(
  function AssetViewport(props, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    // The cell the layout hands the viewport. The canvas is stretched to it, so
    // this is the box the renderer is sized from and the one worth observing.
    const wrap = useRef<HTMLDivElement>(null);
    const live = useRef(props);
    live.current = props;
    const runtime = useRef<Runtime | null>(null);
    const drag = useRef<Drag | null>(null);
    // Any render of this component may have changed what the scene looks like —
    // isolation, wireframe, the selection outline, a freshly applied model. The
    // render loop idles when nothing moves, so one catch-all beats hunting down
    // every setter and is impossible to forget from a new one.
    useEffect(() => {
      runtime.current?.wake();
    });
    const [error, setError] = useState('');
    /**
     * Bumped every time a build lands.
     *
     * The effects that dress the model — isolation, the gizmo, the bone
     * handles — used to watch the spec, because the spec changing and the model
     * changing were the same React pass. They are not any more: a build arrives
     * a beat later, from the worker. This is the "the model changed" signal
     * those effects watch instead.
     */
    const [built, setBuilt] = useState(0);
    const [mode, setMode] = useState<Mode>('translate');
    // Isolation is a controlled value with a fallback: `isolate` wins when the
    // page supplies it, and this stands in when it does not, so `/` is never a
    // key that does nothing. Held in a ref as well, because the canvas key
    // handler is installed once and cannot see a later render's state.
    const [ownIsolate, setOwnIsolate] = useState<Selection>(null);
    const isolated = props.isolate !== undefined ? props.isolate : ownIsolate;
    const isolating = useRef<Selection>(null);
    isolating.current = isolated;
    /** The last selection the camera was moved for, so a rebuild does not. */
    const framed = useRef<Selection>(null);
    /** Which snap grid the held modifiers ask for, for the hint line. */
    const [snap, setSnap] = useState<SnapKind | null>(null);
    /** How far the gizmo has moved this drag, for the hint line. */
    const [readout, setReadout] = useState('');
    useImperativeHandle(
      ref,
      () => ({
        capture() {
          const v = runtime.current;
          if (!v) throw Error('The 3D viewport is unavailable.');
          const bg = v.scene.background;
          const g = v.grid.visible,
            f = v.floor.visible,
            p = v.proxy.visible,
            h = v.handles.visible,
            b = v.bound.visible,
            o = v.hoverBox.visible,
            // A comparison is a thing you are doing, not a property of the
            // asset — a thumbnail with last build's silhouette baked into it
            // would be wrong in the list for as long as it was cached.
            w = v.ghost?.visible ?? false,
            t = v.transform.getHelper().visible;
          v.scene.background = null;
          v.grid.visible = false;
          v.floor.visible = false;
          // The gizmo, the outlines and the bone handles are editing
          // furniture, not the asset.
          v.proxy.visible = false;
          v.handles.visible = false;
          v.bound.visible = false;
          v.hoverBox.visible = false;
          if (v.ghost) v.ghost.visible = false;
          v.transform.getHelper().visible = false;
          v.renderer.render(v.scene, v.camera);
          const output = v.renderer.domElement.toDataURL('image/png');
          v.scene.background = bg;
          v.grid.visible = g;
          v.floor.visible = f;
          v.proxy.visible = p;
          v.handles.visible = h;
          v.bound.visible = b;
          v.hoverBox.visible = o;
          if (v.ghost) v.ghost.visible = w;
          v.transform.getHelper().visible = t;
          v.renderer.render(v.scene, v.camera);
          return output;
        },
        home() {
          runtime.current?.frame(null);
        },
        frame(selection) {
          runtime.current?.frame(selection);
        },
        view(which) {
          runtime.current?.view(which);
        },
        front() {
          const v = runtime.current;
          if (!v?.model) return;
          const box = new T.Box3().setFromObject(v.model),
            center = box.getCenter(new T.Vector3()),
            size = box.getSize(new T.Vector3());
          const distance = Math.max(size.y, size.x / v.camera.aspect) * 1.65;
          v.camera.position.set(center.x, center.y, center.z + distance);
          v.controls.target.copy(center);
          v.controls.update();
        },
      }),
      [],
    );
    useEffect(() => {
      if (!canvas.current) return;
      let renderer: T.WebGLRenderer;
      try {
        renderer = new T.WebGLRenderer({
          canvas: canvas.current,
          antialias: false,
          alpha: true,
          preserveDrawingBuffer: true,
        });
      } catch {
        setError(
          'WebGL is unavailable. Enable hardware acceleration or try another browser.',
        );
        return;
      }
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFShadowMap;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const scene = new T.Scene();
      scene.background = new T.Color('#161b1c');
      lighting(scene);
      const camera = new T.PerspectiveCamera(36, 1, 0.01, 300);
      const controls = new OrbitControls(camera, canvas.current);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = ORBIT_CEILING;
      controls.autoRotateSpeed = 0.8;
      const grid = new T.GridHelper(40, 40, '#4e5754', '#303937');
      scene.add(grid);
      const floor = new T.Mesh(
        new T.PlaneGeometry(200, 200),
        new T.ShadowMaterial({ opacity: 0.2 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      floor.position.y = -0.015;
      scene.add(floor);
      // The proxy outlives every model rebuild, so it lives in the scene and
      // never in the model — which is disposed and replaced on each commit.
      const proxy = new T.Object3D();
      proxy.visible = false;
      scene.add(proxy);
      const outline = new T.Box3Helper(new T.Box3(), new T.Color('#d3e89b'));
      (outline.material as T.LineBasicMaterial).depthTest = false;
      (outline.material as T.LineBasicMaterial).transparent = true;
      outline.renderOrder = 120;
      // A child of the proxy, so it tracks the drag for free instead of being
      // recomputed from a thousand meshes on every pointer move.
      proxy.add(outline);
      // The hover outline is the same drawing in a dimmer ink, and a scene
      // child rather than a proxy child: nothing drags what is merely hovered,
      // and it has to be able to mark a bone the proxy is nowhere near.
      const hoverBox = new T.Box3Helper(new T.Box3(), new T.Color('#d3e89b'));
      const hoverInk = hoverBox.material as T.LineBasicMaterial;
      hoverInk.depthTest = false;
      hoverInk.transparent = true;
      hoverInk.opacity = 0.42;
      hoverBox.renderOrder = 118;
      hoverBox.visible = false;
      scene.add(hoverBox);
      // Every handle shares one sphere and one of two materials: a rig is 14
      // meshes at most, and rebuilding them on each spec change should not
      // mean allocating geometry each time.
      const handleGeometry = new T.SphereGeometry(1, 12, 8);
      const handleIdle = new T.MeshBasicMaterial({
        color: '#7fd2c8',
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.92,
      });
      const handleChosen = new T.MeshBasicMaterial({
        color: '#e8d18a',
        depthTest: false,
        depthWrite: false,
      });
      const boneLines = new T.LineSegments(
        new T.BufferGeometry(),
        new T.LineBasicMaterial({
          color: '#7fd2c8',
          depthTest: false,
          transparent: true,
          opacity: 0.5,
        }),
      );
      boneLines.renderOrder = 121;
      const handles = new T.Group();
      handles.visible = false;
      scene.add(handles);
      const bound = new T.Box3Helper(new T.Box3(), new T.Color('#e8d18a'));
      (bound.material as T.LineBasicMaterial).depthTest = false;
      (bound.material as T.LineBasicMaterial).transparent = true;
      bound.renderOrder = 119;
      bound.visible = false;
      // A scene child rather than a proxy child: it marks what the bone carries
      // now, and should stay put while the bone is dragged off it.
      scene.add(bound);

      const transform = new TransformControls(camera, canvas.current);
      transform.size = 0.95;
      transform.space = 'world';
      transform.detach();
      scene.add(transform.getHelper());

      const v: Runtime = {
        renderer,
        scene,
        camera,
        controls,
        transform,
        proxy,
        outline,
        hoverBox,
        handles,
        bound,
        handleSize: 0.02,
        // Replaced by the render loop below, which is the only thing that can
        // actually grant frames; until then a wake is a no-op, and the loop
        // starts owing a few anyway.
        wake: () => {},
        model: null,
        mixer: null,
        action: null,
        metrics: null,
        helper: null,
        ghost: null,
        grid,
        floor,
        fit() {
          if (!v.model) return;
          // A bottom view lifts the orbit ceiling; a refit is a fresh start and
          // puts the camera back above the floor where orbiting belongs.
          controls.maxPolarAngle = ORBIT_CEILING;
          const box = new T.Box3().setFromObject(v.model),
            center = box.getCenter(new T.Vector3()),
            size = box.getSize(new T.Vector3());
          const radius = size.length() * 0.5;
          const distance = (radius / Math.sin(T.MathUtils.degToRad(18))) * 1.2;
          controls.target.copy(center);
          const environment =
            (live.current.spec ?? live.current.recipe).kind === 'environment';
          camera.position
            .copy(center)
            .add(
              new T.Vector3(
                environment ? 0.42 : 0.25,
                environment ? 0.65 : 0.17,
                1,
              )
                .normalize()
                .multiplyScalar(distance),
            );
          camera.near = Math.max(0.01, distance / 100);
          camera.far = distance * 20;
          camera.updateProjectionMatrix();
          controls.minDistance = radius * 0.65;
          controls.maxDistance = distance * 4;
          grid.position.y = box.min.y - 0.015;
          floor.position.y = box.min.y - 0.02;
          controls.update();
        },
        resize() {
          // Measured off the wrapper, not the canvas: the canvas is absolutely
          // stretched to it, so the wrapper is the cell the layout actually
          // gave the viewport and the only box that means anything here.
          const el = wrap.current ?? canvas.current;
          if (!el) return;
          const width = Math.max(1, el.clientWidth);
          const height = Math.max(1, el.clientHeight);
          const ratio = live.current.pixel
            ? 0.45
            : Math.min(devicePixelRatio, 1.5);
          renderer.setSize(
            Math.max(1, Math.round(width * ratio)),
            Math.max(1, Math.round(height * ratio)),
            false,
          );
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        },
        /**
         * Put the proxy on a part: union centre of every copy, turned to the
         * part's own axes so the gizmo's local scale handles are its axes.
         * On a bone it goes to the authored pivot instead, where the only
         * meaningful gesture is a translate.
         */
        place(selection) {
          transform.detach();
          proxy.visible = false;
          bound.visible = false;
          const spec = live.current.spec;
          if (!selection || !spec) return;
          if (selection.kind === 'bone') {
            const layout = boneLayout(spec);
            const index = layout.findIndex((b) => b.name === selection.name);
            if (index < 0) return;
            const bone = layout[index];
            proxy.position.set(
              bone.at[0] * spec.scale,
              bone.at[1] * spec.scale,
              bone.at[2] * spec.scale,
            );
            proxy.quaternion.identity();
            proxy.scale.set(1, 1, 1);
            proxy.visible = true;
            proxy.updateMatrixWorld(true);
            const reach = v.handleSize * 1.9;
            outline.box.set(
              new T.Vector3(-reach, -reach, -reach),
              new T.Vector3(reach, reach, reach),
            );
            if (v.model) {
              const carried = boneBounds(v.model, index);
              if (!carried.isEmpty()) {
                bound.box.copy(carried);
                bound.visible = true;
              }
            }
            // A joints rig hangs off a static root at the origin, so there is
            // nothing to move. The body rig's Root is a rest-pose offset and
            // moving it shifts the whole skeleton, which is a real edit.
            if (!(spec.joints?.length && bone.name === 'Root'))
              transform.attach(proxy);
            return;
          }
          const path = selection.path;
          if (!v.model) return;
          const part = partAt(spec, path);
          if (!part) return;
          const box = worldBounds(v.model, path);
          if (box.isEmpty()) return;
          const turn = new T.Quaternion();
          frameOf(spec, path).holder.decompose(
            new T.Vector3(),
            turn,
            new T.Vector3(),
          );
          proxy.position.copy(box.getCenter(new T.Vector3()));
          proxy.quaternion.copy(turn);
          proxy.scale.set(1, 1, 1);
          proxy.visible = true;
          proxy.updateMatrixWorld(true);
          const inverse = proxy.matrixWorld.clone().invert();
          const size = box.getSize(new T.Vector3());
          outline.box.makeEmpty();
          for (const corner of CORNER)
            outline.box.expandByPoint(
              new T.Vector3(
                box.min.x + size.x * corner[0],
                box.min.y + size.y * corner[1],
                box.min.z + size.z * corner[2],
              ).applyMatrix4(inverse),
            );
          // A surface-scattered part has no `position` the builder reads, so a
          // translate gizmo on it would commit a number nothing honours.
          if (part.repeat?.mode === 'surface' && transform.mode === 'translate')
            return;
          transform.attach(proxy);
        },
        /**
         * Fit the camera to what is selected, from wherever it is looking now.
         *
         * The orbit direction is kept so a frame reads as a zoom rather than a
         * jump to another side of the model. With nothing selected — or a
         * selection nothing was built for — this is `fit`, which is what Home
         * has always done. The orbit limits were sized for the whole model, so
         * they are widened here or a fingernail could never be reached.
         */
        frame(selection) {
          if (!v.model) return;
          const box = selectionBounds(
            v.model,
            live.current.spec,
            selection,
            v.handleSize,
          );
          if (!box) {
            v.fit();
            return;
          }
          const centre = box.getCenter(new T.Vector3());
          const distance = framingDistance(box);
          const direction = camera.position.clone().sub(controls.target);
          if (direction.lengthSq() < 1e-12) direction.set(0.25, 0.17, 1);
          direction.normalize().multiplyScalar(distance);
          controls.target.copy(centre);
          camera.position.copy(centre).add(direction);
          camera.near = Math.max(0.01, distance / 100);
          // Far enough to still contain the rest of the model: framing a
          // fingertip should not clip the body standing behind it away.
          const span = new T.Box3()
            .setFromObject(v.model)
            .getSize(new T.Vector3())
            .length();
          camera.far = Math.max(distance * 20, distance + span * 2);
          camera.updateProjectionMatrix();
          controls.minDistance = Math.min(controls.minDistance, distance * 0.5);
          controls.maxDistance = Math.max(controls.maxDistance, distance * 4);
          controls.update();
        },
        /**
         * Turn the camera onto an axis, keeping the target and the distance.
         *
         * Deliberately not a refit: framing a part and then asking for the
         * front of it must not zoom back out to the whole model. The camera
         * stays perspective — swapping in an orthographic one would mean
         * re-pointing the gizmo, the raycaster and the capture path at a second
         * camera, which is a great deal of risk for a little parallax.
         */
        view(which) {
          if (!v.model) return;
          const distance = Math.max(
            1e-3,
            camera.position.distanceTo(controls.target),
          );
          // The orbit is normally kept above the floor. Asking for the
          // underside is asking for that ceiling to be lifted, so it is — until
          // the next view or refit puts it back.
          controls.maxPolarAngle =
            which === 'bottom' ? Math.PI : ORBIT_CEILING;
          const environment =
            (live.current.spec ?? live.current.recipe).kind === 'environment';
          const axis: Vec3 =
            which === 'persp'
              ? environment
                ? [0.42, 0.65, 1]
                : [0.25, 0.17, 1]
              : VIEW_AXIS[which];
          camera.position
            .copy(controls.target)
            .add(
              new T.Vector3(axis[0], axis[1], axis[2])
                .normalize()
                .multiplyScalar(distance),
            );
          controls.update();
        },
        /**
         * Redraw the hover outline: the box the selection outline would draw,
         * in a dimmer ink and with no gizmo, so the outliner and the viewport
         * agree about what the pointer is over.
         */
        hint() {
          hoverBox.visible = false;
          const wanted = live.current.hover ?? null;
          const spec = live.current.spec;
          if (!wanted || !spec || !v.model) return;
          // Two outlines on one part would only read as a brighter outline.
          if (sameSelection(wanted, live.current.selected ?? null)) return;
          if (wanted.kind === 'bone') {
            const bone = boneLayout(spec).find((b) => b.name === wanted.name);
            if (!bone) return;
            // A ring round the handle rather than a box round everything the
            // bone carries: hovering a wrist should point at the wrist.
            const reach = v.handleSize * 2.2;
            const at = new T.Vector3(
              bone.at[0] * spec.scale,
              bone.at[1] * spec.scale,
              bone.at[2] * spec.scale,
            );
            hoverBox.box.set(
              at.clone().subScalar(reach),
              at.clone().addScalar(reach),
            );
            hoverBox.visible = true;
            return;
          }
          const box = worldBounds(v.model, wanted.path);
          if (box.isEmpty()) return;
          hoverBox.box.copy(box);
          hoverBox.visible = true;
        },
        isolation: null,
        /**
         * Draw one part or bone alone.
         *
         * Two backends, because the two builds keep a part in two different
         * places. A faceted build gives each part its own meshes, so anything
         * that is not the isolated branch is simply hidden. A fused surface
         * mesh — and a skinned mesh under a bone — holds the isolated thing as
         * a set of vertices inside something larger, and there is nothing to
         * hide: that mesh is dimmed to a ghost instead, and the triangles it
         * does own are drawn over it by a second mesh sharing its vertices.
         */
        isolate(selection) {
          // Always from a clean slate: the record is the only description of
          // what was changed, and applying over a live one would file the
          // ghost material away as the original.
          v.unisolate();
          const model = v.model;
          if (!selection || !model) return;
          let bone = -1;
          if (selection.kind === 'bone') {
            const spec = live.current.spec;
            if (!spec) return;
            bone = boneLayout(spec).findIndex((b) => b.name === selection.name);
            if (bone < 0) return;
          }
          // Collected first: the slices are added to the model as we go, and
          // traversing a tree being added to is a good way to isolate a slice.
          const meshes: T.Mesh[] = [];
          model.traverse((object) => {
            if (object instanceof T.Mesh) meshes.push(object);
          });
          const record: Isolation = {
            hidden: [],
            dimmed: [],
            slices: [],
            made: [],
          };
          for (const mesh of meshes) {
            const owned = ownedTriangles(mesh, selection, bone);
            if (owned === 'all') continue;
            if (owned === 'none') {
              if (!mesh.visible) continue;
              mesh.visible = false;
              record.hidden.push(mesh);
              continue;
            }
            record.dimmed.push({
              mesh,
              material: mesh.material,
              shadow: mesh.castShadow,
            });
            const ghost = Array.isArray(mesh.material)
              ? mesh.material.map(ghostOf)
              : ghostOf(mesh.material);
            record.made.push(...(Array.isArray(ghost) ? ghost : [ghost]));
            mesh.material = ghost;
            // Cut before the shadow is taken away, so the slice inherits it:
            // what is isolated keeps its shadow on the floor, and the ghost
            // loses the one that would otherwise draw the whole model there.
            const slice = sliceOf(mesh, owned);
            mesh.castShadow = false;
            (mesh.parent ?? model).add(slice);
            record.slices.push(slice);
          }
          v.isolation = record;
        },
        unisolate() {
          const record = v.isolation;
          if (!record) return;
          v.isolation = null;
          for (const mesh of record.hidden) mesh.visible = true;
          for (const entry of record.dimmed) {
            entry.mesh.material = entry.material;
            entry.mesh.castShadow = entry.shadow;
          }
          for (const slice of record.slices) {
            slice.removeFromParent();
            // The borrowed attributes are let go of before disposing: they
            // belong to a mesh that is still on screen, and disposing them
            // here would make it re-upload every vertex it already had.
            for (const name of Object.keys(slice.geometry.attributes))
              slice.geometry.deleteAttribute(name);
            slice.geometry.dispose();
          }
          for (const material of record.made) material.dispose();
        },
        /**
         * Redraw the authored skeleton: one handle per bone, a line to each
         * parent, everything drawn over the model so a pivot buried inside a
         * body is still reachable.
         */
        rig() {
          handles.clear();
          const spec = live.current.spec;
          const layout = spec ? boneLayout(spec) : [];
          // The authored rig is an editing overlay like the gizmo: it follows
          // the Bones toggle, except that a bone you have picked stays visible
          // so it can be dragged — nobody wants to hunt for the toggle to
          // finish an edit they already started.
          handles.visible =
            layout.length > 0 &&
            (live.current.skeleton || live.current.selected?.kind === 'bone');
          if (!spec || !layout.length) return;
          const chosen =
            live.current.selected?.kind === 'bone'
              ? live.current.selected.name
              : null;
          const at = new Map<string, T.Vector3>();
          for (const bone of layout)
            at.set(
              bone.name,
              new T.Vector3(
                bone.at[0] * spec.scale,
                bone.at[1] * spec.scale,
                bone.at[2] * spec.scale,
              ),
            );
          for (const bone of layout) {
            const mesh = new T.Mesh(
              handleGeometry,
              bone.name === chosen ? handleChosen : handleIdle,
            );
            mesh.position.copy(at.get(bone.name)!);
            mesh.scale.setScalar(
              v.handleSize * (bone.name === chosen ? 1.5 : 1),
            );
            mesh.renderOrder = 122;
            mesh.userData.bone = bone.name;
            handles.add(mesh);
          }
          // Two passes, because a joint may name a parent authored after it.
          const points: number[] = [];
          for (const bone of layout) {
            const parent = bone.parent ? at.get(bone.parent) : undefined;
            if (!parent) continue;
            const here = at.get(bone.name)!;
            points.push(parent.x, parent.y, parent.z, here.x, here.y, here.z);
          }
          boneLines.geometry.dispose();
          boneLines.geometry = new T.BufferGeometry().setAttribute(
            'position',
            new T.Float32BufferAttribute(points, 3),
          );
          handles.add(boneLines);
        },
        /**
         * A bone can only be placed against the pose it was authored in, so
         * selecting one stops the clip and resets the skeleton; clearing the
         * selection puts the chosen clip back. Every caller that touches the
         * mixer goes through here, including the rebuild after a bone moves —
         * which would otherwise start the clip again under the handles.
         */
        pose() {
          if (!v.mixer || !v.model) return;
          v.mixer.stopAllAction();
          // Held so the render loop can put the clip at an exact time while
          // playback is paused, and read back where it has got to while it is
          // not. Cleared first: every path out of here that leaves the model in
          // its bind pose has no action to speak of.
          v.action = null;
          skeletonOf(v.model)?.pose();
          // `Root` carries a clip's whole-body motion — Jump lifts it — so it
          // goes back where the spec puts it rather than to the origin: a body
          // rig may override `Root`, and zeroing it would shift every bone
          // under it away from the handles they are being dragged by.
          const root = v.model.getObjectByName('Root');
          if (root) {
            const spec = live.current.spec;
            const at = (spec ? boneLayout(spec)[0]?.at : undefined) ?? [0, 0, 0];
            root.position.set(at[0], at[1], at[2]);
          }
          if (live.current.selected?.kind === 'bone') return;
          const clip = clipsOf(live.current.spec, live.current.recipe).find(
            (c) => c.name === live.current.animation,
          );
          // `reset()` puts it back to zero, which is what switching clips means.
          if (clip) v.action = v.mixer.clipAction(clip).reset().play();
        },
      };
      runtime.current = v;

      /**
       * Which snap grid the modifiers are asking for, and the gizmo set to it.
       *
       * Held rather than read from an event because the gizmo's own pointer
       * handling never passes the event on: the modifiers are picked up on
       * pointerdown and then kept in step by the window's key events, so
       * pressing Shift halfway through a drag snaps the rest of it.
       */
      let snapKind: SnapKind | null = null;
      function askSnap(shift: boolean, fine: boolean) {
        const wanted: SnapKind | null = fine ? 'fine' : shift ? 'coarse' : null;
        if (wanted === snapKind) return;
        snapKind = wanted;
        setSnap(wanted);
        const grid = wanted ? SNAP[wanted] : null;
        // The gizmo works in world units and the spec is drawn scaled up, so a
        // centimetre of authored space is `scale` centimetres on screen.
        transform.translationSnap = grid
          ? grid.move * (live.current.spec?.scale ?? 1)
          : null;
        transform.rotationSnap = grid ? T.MathUtils.degToRad(grid.turn) : null;
        transform.scaleSnap = grid ? grid.grow : null;
      }
      function modifiers(event: KeyboardEvent) {
        // Shift held to type a capital in a panel is not a reach for the
        // gizmo, and should not put a snap hint under the model.
        if (typing(event.target)) return;
        askSnap(event.shiftKey, event.metaKey || event.ctrlKey);
      }
      // On the window rather than the canvas: a drag holds the pointer, but
      // key events still go to whatever has focus, which a click on the gizmo
      // does not necessarily move to the canvas.
      addEventListener('keydown', modifiers);
      addEventListener('keyup', modifiers);
      // A modifier released while another window has focus is never seen, and
      // a gizmo left snapping after that would be a mystery.
      const forget = () => askSnap(false, false);
      addEventListener('blur', forget);

      function restore(d: Drag) {
        for (const item of d.moved) {
          item.object.matrix.copy(item.parentInverse).multiply(item.base);
          item.object.matrix.decompose(
            item.object.position,
            item.object.quaternion,
            item.object.scale,
          );
          item.object.updateMatrixWorld(true);
        }
      }

      transform.addEventListener('dragging-changed', (event) => {
        const dragging = Boolean(event.value);
        controls.enabled = !dragging;
        if (dragging) dragged = true;
        if (!dragging) {
          // The snap grid stays as the modifiers left it — it belongs to the
          // keyboard, not to the drag — but the delta was this drag's.
          setReadout('');
          commitDrag();
          return;
        }
        const selection = live.current.selected;
        const spec = live.current.spec;
        if (!selection || !spec || !v.model) return;
        proxy.updateMatrixWorld(true);
        if (selection.kind === 'bone') {
          // Nothing on screen is moved live for a bone: the handle follows the
          // proxy in `objectChange`, and the model only re-poses once the new
          // pivot is in the spec.
          drag.current = {
            path: null,
            bone: selection.name,
            pivot: proxy.position.clone(),
            startInverse: proxy.matrixWorld.clone().invert(),
            position: proxy.position.clone(),
            quaternion: proxy.quaternion.clone(),
            scale: proxy.scale.clone(),
            moved: [],
            measured: null,
          };
          return;
        }
        const path = selection.path;
        const moved: Drag['moved'] = [];
        let measured: T.Matrix4 | null = null;
        v.model.traverse((object) => {
          if (!(object instanceof T.Mesh)) return;
          if (!samePath((object.userData.specPath as Path | undefined) ?? null, path))
            return;
          // A jointed or rigged build bakes the holders away and leaves flat
          // skinned meshes, so move whichever of the two actually exists.
          const holder =
            object.parent && object.parent !== v.model ? object.parent : object;
          if (moved.some((m) => m.object === holder)) return;
          if (holder !== object && holder.parent && !measured)
            measured = holder.parent.matrixWorld.clone();
          moved.push({
            object: holder,
            base: holder.matrixWorld.clone(),
            parentInverse: holder.parent
              ? holder.parent.matrixWorld.clone().invert()
              : new T.Matrix4(),
          });
        });
        drag.current = {
          path,
          bone: null,
          pivot: proxy.position.clone(),
          startInverse: proxy.matrixWorld.clone().invert(),
          position: proxy.position.clone(),
          quaternion: proxy.quaternion.clone(),
          scale: proxy.scale.clone(),
          moved,
          measured,
        };
      });

      /**
       * The live drag, as the number a person would have typed.
       *
       * Throttled to twenty a second like the hover report: this is read, not
       * animated, and React does not need to hear about every pointer move.
       */
      let said = 0;
      function report(d: Drag, now: number) {
        if (now - said < 50) return;
        said = now;
        if (transform.mode === 'rotate')
          setReadout(
            `Δ ${T.MathUtils.radToDeg(proxy.quaternion.angleTo(d.quaternion)).toFixed(1)}°`,
          );
        else if (transform.mode === 'scale') {
          // The axis that moved most: a uniform drag has three of these and a
          // one-axis drag has one, and either way this is the one being dialled.
          const grow = [
            proxy.scale.x / d.scale.x,
            proxy.scale.y / d.scale.y,
            proxy.scale.z / d.scale.z,
          ].sort((a, b) => Math.abs(Math.log(b)) - Math.abs(Math.log(a)))[0];
          setReadout(`× ${grow.toFixed(2)}`);
        } else
          setReadout(`Δ ${proxy.position.distanceTo(d.position).toFixed(3)} m`);
      }

      transform.addEventListener('objectChange', () => {
        const d = drag.current;
        if (!d) return;
        // The gizmo snaps a translation to a grid pinned to the world origin,
        // which is the right answer for a bone — its pivot is committed whole,
        // so a world position on the grid is an authored position on it too.
        // A part commits the *difference*, and the proxy starts wherever the
        // part's bounding box happens to be centred, so the grid is shifted
        // here to start at the drag instead. Every snapped position moves by
        // the same fraction of a step, so nothing jitters.
        if (snapKind && !d.bone && transform.mode === 'translate') {
          const step = SNAP[snapKind].move * (live.current.spec?.scale ?? 1);
          const onGrid = (at: number, from: number) =>
            from + Math.round((at - from) / step) * step;
          proxy.position.set(
            onGrid(proxy.position.x, d.position.x),
            onGrid(proxy.position.y, d.position.y),
            onGrid(proxy.position.z, d.position.z),
          );
        }
        report(d, performance.now());
        proxy.updateMatrixWorld(true);
        if (d.bone) {
          const handle = handles.children.find(
            (child) => child.userData.bone === d.bone,
          );
          handle?.position.copy(proxy.position);
          return;
        }
        const step = proxy.matrixWorld.clone().multiply(d.startInverse);
        for (const item of d.moved) {
          item.object.matrix
            .copy(item.parentInverse)
            .multiply(step)
            .multiply(item.base);
          item.object.matrix.decompose(
            item.object.position,
            item.object.quaternion,
            item.object.scale,
          );
          item.object.updateMatrixWorld(true);
        }
      });

      /** Read the finished drag back into one patch, then let go of it. */
      function commitDrag() {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const spec = live.current.spec;
        if (d.bone) {
          const move = proxy.position.clone().sub(d.position);
          // `rig()` either way: a refused edit leaves the handle sitting where
          // the pointer left it, and the spec is what says where a bone is.
          if (spec && move.lengthSq() > 1e-12)
            live.current.onMoveBone?.(d.bone, [
              proxy.position.x / spec.scale,
              proxy.position.y / spec.scale,
              proxy.position.z / spec.scale,
            ]);
          v.rig();
          return;
        }
        if (!d.path) return;
        // Put the live-dragged meshes back: the rebuild that follows a commit
        // replaces them anyway, and a commit that changes nothing must not
        // leave them sitting somewhere the spec never said.
        restore(d);
        const delta: TransformDelta = {
          pivot: [d.pivot.x, d.pivot.y, d.pivot.z],
        };
        if (transform.mode === 'translate') {
          const move = proxy.position.clone().sub(d.position);
          if (move.lengthSq() > 1e-12) delta.move = [move.x, move.y, move.z];
        } else if (transform.mode === 'rotate') {
          const turn = proxy.quaternion
            .clone()
            .multiply(d.quaternion.clone().invert())
            .normalize();
          if (turn.angleTo(new T.Quaternion()) > 1e-5)
            delta.turn = [turn.x, turn.y, turn.z, turn.w];
        } else {
          const grow: Vec3 = [
            proxy.scale.x / d.scale.x,
            proxy.scale.y / d.scale.y,
            proxy.scale.z / d.scale.z,
          ];
          if (grow.some((n) => Math.abs(n - 1) > 1e-6)) delta.grow = grow;
        }
        v.place(live.current.selected ?? null);
        if (!spec || (!delta.move && !delta.turn && !delta.grow)) return;
        if (!frameIsExact(spec, d.path) && d.measured)
          delta.parentWorld = d.measured;
        const patch = transformPatch(spec, d.path, delta);
        if (Object.keys(patch).length) live.current.onTransform?.(d.path, patch);
      }

      /**
       * Pick a part on release rather than on press, and only when the pointer
       * stayed still — otherwise every orbit would end by reselecting whatever
       * happened to be under the cursor.
       */
      const raycaster = new T.Raycaster();
      let downX = 0,
        downY = 0,
        onGizmo = false,
        /**
         * Set for the whole of a gizmo drag and read once on release.
         *
         * `transform.dragging` is already false by then — the controls own the
         * earlier pointerup listener on this canvas and clear it there — and a
         * grab that starts a pixel off a handle never sets `onGizmo` either. A
         * drag that ends near where it began would otherwise fall through to
         * the picker and deselect the part that was just moved.
         */
        dragged = false;
      const el = canvas.current;
      function pointerDown(event: PointerEvent) {
        downX = event.clientX;
        downY = event.clientY;
        // Authoritative: a modifier held down before the canvas had focus was
        // never seen by the key listeners, and this is the moment it matters.
        askSnap(event.shiftKey, event.metaKey || event.ctrlKey);
        // A click on a gizmo handle never moves the pointer, so without this it
        // would fall through the gizmo and deselect the part being dragged.
        onGizmo = transform.axis !== null;
        el.focus({ preventScroll: true });
      }
      /**
       * What is under the pointer, by the rules a click selects with.
       *
       * Shared with the hover report, so the outline that follows the pointer
       * and the thing a click lands on can never disagree.
       */
      function pickAt(clientX: number, clientY: number): Selection {
        if (!live.current.spec || !v.model) return null;
        const rect = el.getBoundingClientRect();
        raycaster.setFromCamera(
          new T.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
          ),
          camera,
        );
        // Handles first: they are drawn over the model precisely so a pivot
        // inside a body can be grabbed, and picking the body instead would
        // make that drawing a lie.
        if (handles.visible) {
          // The lines between bones are in this group too, and a line hit can
          // sort ahead of the sphere it runs into — so take the first hit that
          // is actually a handle rather than the first hit.
          const onBone = raycaster
            .intersectObjects(handles.children, false)
            .find((hit) => hit.object.userData.bone);
          if (onBone)
            return {
              kind: 'bone',
              name: onBone.object.userData.bone as string,
            };
        }
        // Visible hits only: three's raycaster ignores `visible`, so without
        // this a click would still land on a part isolation has hidden.
        const hit = raycaster
          .intersectObject(v.model, true)
          .find((found) => found.object.visible);
        if (!hit) return null;
        const mesh = hit.object as T.Mesh;
        const direct = mesh.userData.specPath as Path | undefined;
        if (direct) return { kind: 'part', path: [...direct] };
        const owners = mesh.geometry?.userData.surfaceOwners as
          | { index: Uint16Array; paths: (Path | undefined)[] }
          | undefined;
        if (owners && hit.face) {
          for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
            const path = owners.paths[owners.index[vertex]];
            if (path) return { kind: 'part', path: [...path] };
          }
        }
        return null;
      }
      function pointerUp(event: PointerEvent) {
        if (dragged) {
          dragged = false;
          return;
        }
        if (event.button !== 0 || onGizmo || transform.dragging) return;
        if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return;
        if (event.shiftKey || !live.current.spec || !v.model) return;
        const pick = live.current.onSelect;
        if (!pick) return;
        pick(pickAt(event.clientX, event.clientY));
      }
      /**
       * Frame what was double-clicked, or the whole model on empty space.
       *
       * Only framing: the two clicks underneath have already picked whatever
       * they landed on — the second one re-picks the same thing, which is no
       * change — and selecting again from here would be a third opinion.
       */
      function doubleClick(event: MouseEvent) {
        v.frame(pickAt(event.clientX, event.clientY));
      }
      /**
       * Ask for isolation to flip, through the prop when the page owns it and
       * through our own state when it does not.
       */
      function flipIsolate(next: Selection) {
        live.current.onIsolate?.(next);
        if (live.current.isolate === undefined) setOwnIsolate(next);
      }
      /**
       * Whether this canvas is the thing that answers an isolate key.
       *
       * It is when the page asked to hear about it, or when it left isolation
       * to the viewport entirely. A page that drives `isolate` from its own
       * keyboard handler and never passed `onIsolate` is doing it itself, and
       * a press swallowed here would be a press that does nothing at all.
       */
      function ownsIsolate() {
        return (
          Boolean(live.current.onIsolate) || live.current.isolate === undefined
        );
      }
      /**
       * Report what the pointer is over, throttled to 20 a second.
       *
       * Never while the camera or the gizmo is being dragged, and never when
       * the pointer is on a gizmo handle: lighting up whatever part happens to
       * lie behind an arrow is not what aiming at that arrow meant.
       */
      let hovered: Selection = null,
        looked = 0,
        lookedX = NaN,
        lookedY = NaN;
      function pointerMove(event: PointerEvent) {
        // Unconditionally, and before every early return below: the gizmo
        // lights its own axis up from an internal hover test that fires no
        // event, so a still camera over a still model would keep the highlight
        // from ever being drawn.
        wake();
        if (!live.current.onHover) return;
        if (event.buttons !== 0 || transform.dragging || transform.axis !== null)
          return;
        if (event.timeStamp - looked < 50) return;
        // A pointer resting on the canvas still produces move events — a
        // trackpad reports sub-pixel drift, and a scroll fires one per notch.
        // Raycasting from a point already raycast cannot find anything new.
        if (event.clientX === lookedX && event.clientY === lookedY) return;
        looked = event.timeStamp;
        lookedX = event.clientX;
        lookedY = event.clientY;
        const found = pickAt(event.clientX, event.clientY);
        if (sameSelection(found, hovered)) return;
        hovered = found;
        live.current.onHover(found);
      }
      function pointerLeave() {
        if (!hovered) return;
        hovered = null;
        live.current.onHover?.(null);
      }
      function key(event: KeyboardEvent) {
        if (typing(event.target)) return;
        const lower = event.key.toLowerCase();
        // Blender's numpad views, on the number row: the plain key is the near
        // face, ⌘ or Ctrl the one opposite. Read before ⌘D and before the
        // modifier guard under it, because half of these are modified.
        const faces = VIEW_KEY[event.key];
        if (faces && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          v.view(event.metaKey || event.ctrlKey ? faces[1] : faces[0]);
          return;
        }
        if ((event.metaKey || event.ctrlKey) && lower === 'd') {
          event.preventDefault();
          live.current.onDuplicate?.();
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        // A bone is a pivot, not a solid: turning or scaling one means nothing
        // the spec can hold, so those modes stay unreachable while one is up.
        const onBone = live.current.selected?.kind === 'bone';
        if (event.key === 'Escape') {
          // Two stages, outermost first: Escape out of the local view, and
          // only the next one out of the selection. Throwing away both at once
          // would lose the thing that was being looked at as well as the look.
          // Marked handled when it is taken, because a page may well bind
          // Escape at the window too, and that one would deselect in the same
          // press — which is the stage this one is standing in front of.
          if (isolating.current && ownsIsolate()) {
            event.preventDefault();
            flipIsolate(null);
          } else live.current.onSelect?.(null);
        } else if (event.key === '/') {
          if (!ownsIsolate()) return;
          event.preventDefault();
          if (isolating.current) flipIsolate(null);
          else if (live.current.selected) flipIsolate(live.current.selected);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          live.current.onDelete?.();
        } else if (lower === 'f') {
          event.preventDefault();
          v.frame(live.current.selected ?? null);
        } else if (event.key === 'Home') {
          event.preventDefault();
          v.frame(null);
        } else if (event.key === ' ') {
          // The canvas has focus, so this would otherwise scroll the page.
          event.preventDefault();
          live.current.onPlayToggle?.();
        } else if (lower === 'g' || lower === 'w') {
          setMode('translate');
        } else if (lower === 'r' || lower === 'e') {
          if (!onBone) setMode('rotate');
        } else if (lower === 's') {
          if (!onBone) setMode('scale');
        }
      }
      el.addEventListener('pointerdown', pointerDown);
      el.addEventListener('pointerup', pointerUp);
      el.addEventListener('pointermove', pointerMove);
      el.addEventListener('pointerleave', pointerLeave);
      el.addEventListener('dblclick', doubleClick);
      el.addEventListener('keydown', key);

      const ro = new ResizeObserver(() => {
        v.resize();
        // A resized drawing buffer holds a stretched copy of the last frame
        // until something redraws it.
        v.wake();
      });
      ro.observe(wrap.current ?? canvas.current);
      v.resize();
      let frame = 0;
      let previous = 0;
      // Frames that actually reached the renderer in the last second, rather
      // than callbacks: the loop skips anything under 30ms on purpose, so this
      // is the rate the viewport really draws at and not the rate rAF fires at.
      let drawn = 0,
        second = 0,
        told = 0;
      /**
       * Frames still owed after something changed.
       *
       * A viewport of a still model with a still camera was redrawing sixty
       * times a second to produce sixty identical images — a whole core of a
       * laptop's budget spent on nothing, next to a worker that would like to
       * have it. So it draws only when something moved.
       *
       * A counter rather than a boolean, because several of these settle over
       * more than one frame: `OrbitControls` damps to a stop after the pointer
       * has let go, and `TransformControls` re-places its helper on the frame
       * after it is told to. Owing a handful of frames costs nothing and is
       * the difference between "cheap" and "sometimes a frame behind".
       */
      let owed = 4;
      const wake = () => {
        owed = 4;
      };
      controls.addEventListener('change', wake);
      transform.addEventListener('change', wake);
      // Any React pass may have changed the scene — isolation, wireframe, the
      // gizmo's target, a rebuild. Rather than hunt down each one, the effect
      // below wakes the loop after every render of this component.
      v.wake = wake;
      function render(now: number) {
        frame = requestAnimationFrame(render);
        if (document.hidden || now - previous < 30) return;
        const delta = previous ? Math.min(0.1, (now - previous) / 1000) : 0;
        previous = now;
        // Anything that animates itself keeps the loop awake on its own.
        const moving =
          (v.mixer !== null && live.current.playing !== false) ||
          (live.current.rotate && !transform.dragging);
        if (moving) owed = 2;
        if (owed <= 0) {
          // The window still rolls, so the next busy second measures itself
          // rather than the idle one before it. What is deliberately *not*
          // reported is a rate of zero: an idle viewport drawing no frames is
          // the point, not a fault, and saying so would cost a commit of the
          // whole panel — which would wake the loop, which would draw a frame.
          if (second && now - second >= 1000) {
            second = now;
            drawn = 0;
          }
          return;
        }
        owed--;
        if (v.mixer) {
          v.mixer.timeScale = live.current.speed;
          const action = v.action;
          const span = action?.getClip().duration ?? 0;
          if (action && live.current.playing === false) {
            // Paused: a scrubber owns the clock, so the mixer is put exactly
            // where `time` asks and advanced by nothing at all.
            const at = wrapTime(live.current.time ?? 0, span);
            if (Math.abs(action.time - at) > 1e-6) action.time = at;
            v.mixer.update(0);
          } else {
            v.mixer.update(delta);
            if (action && span > 0 && now - told > 100) {
              told = now;
              live.current.onTime?.(wrapTime(action.time, span));
            }
          }
        }
        // A turntable turning under a drag drags the gizmo plane with it.
        controls.autoRotate = live.current.rotate && !transform.dragging;
        controls.update();
        renderer.render(scene, camera);
        drawn++;
        if (!second) second = now;
        else if (now - second >= 1000) {
          const fps = Math.round((drawn * 1000) / (now - second));
          second = now;
          drawn = 0;
          // The frame rate belongs beside the mesh counts, and those only
          // change on a rebuild — so it rides along with the last ones rather
          // than becoming a second channel the layout has to join up.
          gauge('fps', fps);
          if (v.metrics && v.metrics.fps !== fps) {
            v.metrics = { ...v.metrics, fps };
            live.current.onStats(v.metrics);
          }
        }
      }
      frame = requestAnimationFrame(render);
      return () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        controls.removeEventListener('change', wake);
        transform.removeEventListener('change', wake);
        el.removeEventListener('pointerdown', pointerDown);
        el.removeEventListener('pointerup', pointerUp);
        el.removeEventListener('pointermove', pointerMove);
        el.removeEventListener('pointerleave', pointerLeave);
        el.removeEventListener('dblclick', doubleClick);
        el.removeEventListener('keydown', key);
        removeEventListener('keydown', modifiers);
        removeEventListener('keyup', modifiers);
        removeEventListener('blur', forget);
        // Before the scene is disposed: a dimmed mesh is holding a ghost this
        // would dispose while the material it is standing in for leaks.
        v.unisolate();
        controls.dispose();
        transform.detach();
        scene.remove(transform.getHelper());
        transform.dispose();
        v.mixer?.stopAllAction();
        if (v.ghost) skeletonOf(v.ghost)?.dispose();
        if (v.model) skeletonOf(v.model)?.dispose();
        v.helper?.dispose();
        outline.dispose();
        bound.dispose();
        hoverBox.dispose();
        handles.clear();
        handleGeometry.dispose();
        handleIdle.dispose();
        handleChosen.dispose();
        boneLines.geometry.dispose();
        (boneLines.material as T.Material).dispose();
        disposeScene(scene);
        grid.geometry.dispose();
        (grid.material as T.Material).dispose();
        renderer.dispose();
        // No forceContextLoss(): React keeps this canvas element across a
        // remount, and a force-lost context can never be re-acquired on the
        // same canvas. Doing it here leaves the next mount with a null context
        // and a permanently dead preview. dispose() releases the GPU resources;
        // the context itself goes when the page does.
        runtime.current = null;
      };
    }, []);
    /**
     * The build worker, one per mounted viewport.
     *
     * Created in an effect rather than at module scope so a server render never
     * reaches `new Worker`, and so a remounted viewport gets a clean one rather
     * than inheriting a lane full of a dead component's requests.
     */
    const builder = useRef<BuildClient | null>(null);
    const [building, setBuilding] = useState<{
      since: number;
      phase?: BuildPhase;
    } | null>(null);
    useEffect(() => {
      builder.current = createBuildClient();
      return () => {
        builder.current?.dispose();
        builder.current = null;
      };
    }, []);
    useEffect(() => {
      const v = runtime.current;
      const client = builder.current;
      if (!v || !client) return;
      const source = props.spec
        ? { spec: props.spec }
        : { recipe: props.recipe };

      /** Everything that used to follow `buildSpec` in this effect. */
      const apply = (model: T.Object3D) => {
        const old = v.model;
        // A rebuild throws the objects a drag is holding on to away with the
        // old model, so let go of them first.
        drag.current = null;
        // And hand every dimmed mesh its own material back before the model
        // carrying it is disposed. The isolate effect below re-applies it to
        // whatever is built here, since it watches the same spec.
        v.unisolate();
        const rigged = props.spec
          ? Boolean(props.spec.rig || props.spec.joints?.length)
          : (props.recipe.kind === 'creature' ||
              props.recipe.kind === 'person') &&
            props.recipe.rigged;
        v.scene.add(model);
        v.model = model as T.Group;
        if (v.mixer) {
          v.mixer.stopAllAction();
          if (old) v.mixer.uncacheRoot(old);
        }
        if (v.helper) {
          v.scene.remove(v.helper);
          v.helper.dispose();
          v.helper = null;
        }
        v.mixer = null;
        v.action = null;
        if (rigged) {
          v.mixer = new T.AnimationMixer(model);
          // Through `pose`, so a rebuild that follows a bone edit does not
          // start the clip up again under the handle that is being placed.
          v.pose();
          v.helper = new T.SkeletonHelper(model);
          v.helper.visible = live.current.skeleton;
          (v.helper.material as T.LineBasicMaterial).depthTest = false;
          v.helper.renderOrder = 100;
          v.scene.add(v.helper);
        }
        if (old) {
          v.scene.remove(old);
          skeletonOf(old)?.dispose();
          disposeScene(old);
        }
        const previous = old?.userData.recipe ?? old?.userData.spec;
        const next = props.spec ?? props.recipe;
        // Recipes and specs sit at wildly different sizes, so switching between
        // them always deserves a refit even when the kind happens to match.
        const swapped = Boolean(old?.userData.spec) !== Boolean(props.spec);
        if (
          !previous ||
          swapped ||
          previous.kind !== next.kind ||
          previous.scale !== next.scale
        )
          v.fit();
        model.traverse((o) => {
          if (o instanceof T.Mesh)
            (o.material as T.MeshStandardMaterial).wireframe =
              live.current.wireframe;
        });
        // Handles are sized off the model, so a 4-metre swing and a 40-metre
        // kaiju both get a grabbable pivot rather than a dot or a boulder.
        const span = new T.Box3().setFromObject(model).getSize(new T.Vector3());
        v.handleSize = Math.max(0.004, span.length() * 0.012);
        v.rig();
        // The hovered thing was meshes that have just been thrown away; measure
        // it again on the ones that replaced them.
        v.hint();
        v.metrics = stats(model);
        props.onStats(v.metrics);
        // Reported from here because this is the only place that knows the
        // asset really built: a timeline can have the names and the durations
        // without rebuilding the clips, or importing three to ask.
        live.current.onClips?.(
          clipsOf(props.spec, props.recipe).map((clip) => ({
            name: clip.name,
            duration: clip.duration,
          })),
        );
        // Last, so whoever audits this is reading a model that is fully wired
        // up — skinned, posed and measured.
        live.current.onModel?.(model);
        // The isolate and gizmo effects below watch the same spec, but React
        // ran them when the spec changed rather than when the model landed.
        // Asking for one more pass is how they get to see what arrived.
        setBuilt((n) => n + 1);
      };

      let waiting = true;
      const start = () => {
        if (!waiting) return;
        // Deliberately not `onModel(null)`: the previous model is still on
        // screen and still the truth about it, so the findings panel keeps
        // describing it rather than blanking for a second and a half on every
        // edit. The chip in the corner is what says a newer one is coming.
        const since = performance.now();
        setBuilding({ since });
        const id = client.build('model', source, {
          onPhase: (phase) =>
            setBuilding((at) => (at ? { ...at, phase } : at)),
          onFailed: (message) => {
            setBuilding(null);
            live.current.onBuild?.({ id, done: true });
            setError(message);
          },
          onModel: (model) => {
            setBuilding(null);
            setError('');
            apply(model);
            live.current.onBuild?.({ id, done: true });
          },
        });
        live.current.onBuild?.({ id, since });
      };
      // A typed edit waits; a committed drag, a file load or a fresh mount does
      // not, because each of those is already exactly one edit.
      const timer =
        props.lastEdit === 'typed' ? setTimeout(start, TYPING_PAUSE) : 0;
      if (!timer) start();
      return () => {
        waiting = false;
        if (timer) clearTimeout(timer);
      };
    }, [props.recipe, props.spec, props.lastEdit]);
    /**
     * The comparison ghost: the previous build, drawn through this one.
     *
     * Built by exactly the same call the real model is, because a ghost made
     * any other way would be a second builder to keep honest — and a
     * comparison you cannot trust is worse than none. Everything that makes it
     * a ghost rather than a model is done afterwards, to clones of its own
     * materials: transparent, no depth writing so the solid model in front of
     * it still sorts correctly, and a cool tint that cannot be mistaken for
     * the accent the studio uses for what is selected.
     *
     * It is added to the scene and never to `v.model`, which is the whole
     * trick: the picker raycasts `v.model`, framing and the statistics measure
     * `v.model`, and isolation walks `v.model`. None of them can see this, so
     * none of them needed a special case for it.
     */
    const ghostSource = props.ghost ?? null;
    useEffect(() => {
      const v = runtime.current;
      const client = builder.current;
      if (!v || !client) return;
      if (v.ghost) {
        v.scene.remove(v.ghost);
        skeletonOf(v.ghost)?.dispose();
        disposeScene(v.ghost);
        v.ghost = null;
      }
      if (!ghostSource) {
        client.cancel('ghost');
        return;
      }
      // A spec and a recipe are told apart the way they are everywhere else in
      // this studio: by whether there is a `parts` array.
      const asSpec = Array.isArray((ghostSource as AssetSpec).parts)
        ? (ghostSource as AssetSpec)
        : null;
      // Its own lane, so a ghost nobody has looked at yet never delays the
      // model that is being edited.
      client.build(
        'ghost',
        asSpec ? { spec: asSpec } : { recipe: ghostSource as Recipe },
        {
          // A previous build that no longer parses is not worth taking the
          // viewport down for; the comparison simply has nothing to show.
          onFailed: () => {},
          onModel: (model) => {
            const at = runtime.current;
            if (!at) return;
            model.name = 'Ghost';
            const wire = Boolean(live.current.ghostWire);
            model.traverse((o) => {
              o.castShadow = false;
              o.receiveShadow = false;
              // Belt and braces: nothing raycasts the whole scene today, and
              // this is what keeps that true for whatever is added next.
              o.raycast = () => {};
              if (!(o instanceof T.Mesh)) return;
              const many = Array.isArray(o.material);
              const worn = many
                ? (o.material as T.Material[])
                : [o.material as T.Material];
              const made = worn.map((material) => {
                const copy = (material as T.MeshStandardMaterial).clone();
                copy.transparent = true;
                copy.opacity = 0.25;
                // Without this the ghost would punch holes in the model
                // standing in front of it, wherever it was drawn first.
                copy.depthWrite = false;
                copy.wireframe = wire;
                copy.color = new T.Color(GHOST_TINT);
                if (copy.emissive) {
                  copy.emissive = new T.Color(GHOST_TINT);
                  copy.emissiveIntensity = 0.3;
                }
                return copy;
              });
              o.material = many ? made : made[0];
              // Drawn before the solid model, so the transparency reads as
              // "behind".
              o.renderOrder = -1;
            });
            at.ghost = model as T.Group;
            at.scene.add(model);
            // Added straight to the scene, outside React: nothing else here
            // will ask the idle loop for the frame that draws it.
            at.wake();
          },
        },
      );
    }, [ghostSource]);
    // Wireframe on the ghost alone: rebuilding it to change one boolean would
    // throw away a few thousand triangles for a checkbox.
    useEffect(() => {
      const ghost = runtime.current?.ghost;
      if (!ghost) return;
      ghost.traverse((o) => {
        if (!(o instanceof T.Mesh)) return;
        for (const material of Array.isArray(o.material) ? o.material : [o.material])
          (material as T.MeshStandardMaterial).wireframe = Boolean(props.ghostWire);
      });
    }, [props.ghostWire, ghostSource]);
    // Declared after the rebuild so it runs after it, and watching the same
    // inputs: the rebuild drops isolation to give the old meshes their
    // materials back, and this puts it on the meshes that replaced them.
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      v.isolate(isolated);
      // Framed when the isolated thing itself changes and not on every
      // rebuild, or every edit made while isolated would yank the camera.
      if (isolated && !sameSelection(framed.current, isolated)) v.frame(isolated);
      framed.current = isolated;
    }, [isolated, built]);
    // Declared after the rebuild, so it runs after it: the gizmo re-attaches to
    // a proxy placed on the freshly built meshes every time the model changes.
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      // The mode has to land on the controls before `place` reads it back to
      // decide whether this part can be translated at all.
      v.transform.mode = props.selected?.kind === 'bone' ? 'translate' : mode;
      v.place(props.selected ?? null);
      // Redrawn here as well as on rebuild, because which handle is lit is a
      // function of the selection and nothing else changed.
      v.rig();
    }, [props.selected, built, mode]);
    // Declared after the rebuild for the same reason the gizmo effect is: the
    // box is measured off meshes that only exist once the model has been built.
    useEffect(() => {
      runtime.current?.hint();
    }, [props.hover, props.selected, built]);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      v.grid.visible = props.grid;
      v.model?.traverse((o) => {
        if (o instanceof T.Mesh)
          (o.material as T.MeshStandardMaterial).wireframe = props.wireframe;
      });
      v.resize();
    }, [props.grid, props.pixel, props.wireframe]);
    // Only the bone-ness of the selection matters here: re-posing on every
    // part click would restart the clip each time one was picked.
    const onBone = props.selected?.kind === 'bone';
    // A joints rig hangs off a static root; the body rig's Root is a rest-pose
    // offset and may be dragged, so only the first has nothing to say.
    const fixedRoot =
      onBone &&
      props.selected?.kind === 'bone' &&
      props.selected.name === 'Root' &&
      Boolean(props.spec?.joints?.length);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      if (v.helper) v.helper.visible = props.skeleton;
      v.rig();
      v.pose();
    }, [props.animation, props.skeleton, onBone]);
    const editable = Boolean(props.spec);
    // The grid for the gizmo that is actually up: a bone only ever translates,
    // whatever mode the buttons were left on.
    const snapHint = snap
      ? `SNAP ${SNAP[snap].label[SNAP_COLUMN[onBone ? 'translate' : mode]]}`
      : '';
    const picked = selectedPath(props.selected ?? null);
    const scattered =
      props.spec && picked
        ? partAt(props.spec, picked)?.repeat?.mode === 'surface'
        : false;
    return (
      <div className="asset-viewport" ref={wrap}>
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label="3D asset preview. Click a part to select it. Drag to orbit, right-drag to pan, scroll to zoom."
          style={{ imageRendering: props.pixel ? 'pixelated' : 'auto' }}
        />
        {editable && (
          <div className="gizmo-modes" role="group" aria-label="Gizmo mode">
            {(
              [
                ['translate', Move3d, 'Move (G)'],
                ['rotate', Rotate3d, 'Rotate (R)'],
                ['scale', Scale3d, 'Scale (S)'],
              ] as const
            ).map(([name, Icon, title]) => (
              <button
                key={name}
                title={
                  onBone && name !== 'translate'
                    ? 'A bone is a pivot — it only moves'
                    : title
                }
                aria-label={title}
                aria-pressed={onBone ? name === 'translate' : mode === name}
                disabled={onBone && name !== 'translate'}
                onClick={() => setMode(name)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="viewport-error" role="alert">
            {error}
          </p>
        )}
        {building && (
          <BuildingChip since={building.since} phase={building.phase} />
        )}
        <div className="viewport-hint">
          {readout || snapHint ? (
            <>
              {readout}
              {readout && snapHint ? <span>·</span> : null}
              {snapHint}
            </>
          ) : isolated ? (
            <>
              ISOLATED <span>·</span> / RESTORES <span>·</span> ESC CLEARS
            </>
          ) : editable ? (
            onBone ? (
              fixedRoot ? (
                <>
                  ROOT IS THE STATIC BONE AT THE ORIGIN <span>·</span> ESC
                  DESELECTS
                </>
              ) : (
                <>
                  DRAG TO PLACE THE PIVOT <span>·</span> MODEL IS IN ITS BIND
                  POSE <span>·</span> DEL REMOVES <span>·</span> ESC DESELECTS
                </>
              )
            ) : props.selected ? (
              scattered && mode === 'translate' ? (
                <>SCATTERED PARTS LAND BY RAYCAST — ROTATE OR SCALE INSTEAD</>
              ) : (
                <>
                  G/R/S TO SWITCH GIZMO <span>·</span> / ISOLATES{' '}
                  <span>·</span> DEL REMOVES <span>·</span> ⌘D DUPLICATES{' '}
                  <span>·</span> ESC DESELECTS
                </>
              )
            ) : (
              <>
                CLICK A PART TO EDIT IT <span>·</span> DRAG TO ORBIT{' '}
                <span>·</span> SCROLL TO ZOOM
              </>
            )
          ) : (
            <>
              DRAG TO ORBIT <span>·</span> SCROLL TO ZOOM <span>·</span>{' '}
              RIGHT-DRAG TO PAN
            </>
          )}
        </div>
        <div className="axes">
          <span>Y</span>
          <span>Z</span>
          <span>X</span>
        </div>
      </div>
    );
  },
);
