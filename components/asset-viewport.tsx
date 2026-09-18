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
import { buildAsset, stats } from '@/lib/asset-export';
import { buildSpec, type AssetSpec } from '@/lib/asset-spec';
import { readySurface } from '@/lib/asset-surface';
import {
  frameIsExact,
  frameOf,
  partAt,
  samePath,
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
export type ViewHandle = {
  capture: () => string;
  home: () => void;
  front: () => void;
};
export type AssetStats = ReturnType<typeof stats>;
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
  onStats: (s: AssetStats) => void;
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
  helper: T.SkeletonHelper | null;
  grid: T.GridHelper;
  floor: T.Mesh;
  fit: () => void;
  resize: () => void;
  place: (selection: Selection) => void;
  /** Redraw the bone handles from the current spec. */
  rig: () => void;
  /** Bind pose while a bone is selected; the chosen clip otherwise. */
  pose: () => void;
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

/** The world box of every mesh an authored part became. */
function worldBounds(model: T.Object3D, path: Path) {
  const box = new T.Box3();
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (samePath((object.userData.specPath as Path | undefined) ?? null, path)) {
      box.expandByObject(object);
      return;
    }
    // Surface mode leaves one fused mesh, so the part is a set of vertices
    // rather than an object: the owner table is the only way back to it.
    const owners = object.geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (Path | undefined)[] }
      | undefined;
    if (!owners) return;
    const position = object.geometry.attributes.position;
    const point = new T.Vector3();
    object.updateMatrixWorld();
    for (let i = 0; i < position.count; i++)
      if (samePath(owners.paths[owners.index[i]] ?? null, path))
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
      const owns =
        (index.getX(i) === bone && (!weight || weight.getX(i) >= 0.5)) ||
        (index.getY(i) === bone && Boolean(weight) && weight.getY(i) > 0.5);
      if (owns)
        box.expandByPoint(
          point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld),
        );
    }
  });
  return box;
}

export const AssetViewport = forwardRef<ViewHandle, Props>(
  function AssetViewport(props, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const live = useRef(props);
    live.current = props;
    const runtime = useRef<Runtime | null>(null);
    const drag = useRef<Drag | null>(null);
    const [error, setError] = useState('');
    const [mode, setMode] = useState<Mode>('translate');
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
            t = v.transform.getHelper().visible;
          v.scene.background = null;
          v.grid.visible = false;
          v.floor.visible = false;
          // The gizmo, the outlines and the bone handles are editing
          // furniture, not the asset.
          v.proxy.visible = false;
          v.handles.visible = false;
          v.bound.visible = false;
          v.transform.getHelper().visible = false;
          v.renderer.render(v.scene, v.camera);
          const output = v.renderer.domElement.toDataURL('image/png');
          v.scene.background = bg;
          v.grid.visible = g;
          v.floor.visible = f;
          v.proxy.visible = p;
          v.handles.visible = h;
          v.bound.visible = b;
          v.transform.getHelper().visible = t;
          v.renderer.render(v.scene, v.camera);
          return output;
        },
        home() {
          runtime.current?.fit();
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
      controls.maxPolarAngle = Math.PI * 0.49;
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
        handles,
        bound,
        handleSize: 0.02,
        model: null,
        mixer: null,
        helper: null,
        grid,
        floor,
        fit() {
          if (!v.model) return;
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
          const el = canvas.current;
          if (!el) return;
          const ratio = live.current.pixel
            ? 0.45
            : Math.min(devicePixelRatio, 1.5);
          renderer.setSize(
            Math.max(1, Math.round(el.clientWidth * ratio)),
            Math.max(1, Math.round(el.clientHeight * ratio)),
            false,
          );
          camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
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
         * Redraw the authored skeleton: one handle per bone, a line to each
         * parent, everything drawn over the model so a pivot buried inside a
         * body is still reachable.
         */
        rig() {
          handles.clear();
          const spec = live.current.spec;
          const layout = spec ? boneLayout(spec) : [];
          handles.visible = layout.length > 0;
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
          if (clip) v.mixer.clipAction(clip).reset().play();
        },
      };
      runtime.current = v;

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

      transform.addEventListener('objectChange', () => {
        const d = drag.current;
        if (!d) return;
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
        // A click on a gizmo handle never moves the pointer, so without this it
        // would fall through the gizmo and deselect the part being dragged.
        onGizmo = transform.axis !== null;
        el.focus({ preventScroll: true });
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
        const rect = el.getBoundingClientRect();
        raycaster.setFromCamera(
          new T.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
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
          if (onBone) {
            pick({ kind: 'bone', name: onBone.object.userData.bone as string });
            return;
          }
        }
        const hit = raycaster.intersectObject(v.model, true)[0];
        if (!hit) {
          pick(null);
          return;
        }
        const mesh = hit.object as T.Mesh;
        const direct = mesh.userData.specPath as Path | undefined;
        if (direct) {
          pick({ kind: 'part', path: [...direct] });
          return;
        }
        const owners = mesh.geometry?.userData.surfaceOwners as
          | { index: Uint16Array; paths: (Path | undefined)[] }
          | undefined;
        if (owners && hit.face) {
          for (const vertex of [hit.face.a, hit.face.b, hit.face.c]) {
            const path = owners.paths[owners.index[vertex]];
            if (path) {
              pick({ kind: 'part', path: [...path] });
              return;
            }
          }
        }
        pick(null);
      }
      function key(event: KeyboardEvent) {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
          return;
        const lower = event.key.toLowerCase();
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
          live.current.onSelect?.(null);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          live.current.onDelete?.();
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
      el.addEventListener('keydown', key);

      const ro = new ResizeObserver(v.resize);
      ro.observe(canvas.current);
      v.resize();
      let frame = 0;
      let previous = 0;
      function render(now: number) {
        frame = requestAnimationFrame(render);
        if (document.hidden || now - previous < 30) return;
        const delta = previous ? Math.min(0.1, (now - previous) / 1000) : 0;
        previous = now;
        if (v.mixer) {
          v.mixer.timeScale = live.current.speed;
          v.mixer.update(delta);
        }
        // A turntable turning under a drag drags the gizmo plane with it.
        controls.autoRotate = live.current.rotate && !transform.dragging;
        controls.update();
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(render);
      return () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        el.removeEventListener('pointerdown', pointerDown);
        el.removeEventListener('pointerup', pointerUp);
        el.removeEventListener('keydown', key);
        controls.dispose();
        transform.detach();
        scene.remove(transform.getHelper());
        transform.dispose();
        v.mixer?.stopAllAction();
        if (v.model) skeletonOf(v.model)?.dispose();
        v.helper?.dispose();
        outline.dispose();
        bound.dispose();
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
    const [surfaceReady, setSurfaceReady] = useState(false);
    useEffect(() => {
      readySurface().then(() => setSurfaceReady(true));
    }, []);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      // A surface spec cannot be built until its decimator is in memory, and
      // rendering the faceted fallback in the meantime would show the user a
      // model that is not the one they authored.
      if (props.spec?.surface && !surfaceReady) return;
      const old = v.model;
      // A rebuild throws the objects a drag is holding on to away with the old
      // model, so let go of them first.
      drag.current = null;
      let model: T.Group;
      try {
        model = props.spec ? buildSpec(props.spec) : buildAsset(props.recipe);
      } catch (error) {
        // Hot reloading `asset-surface` gives it a fresh, unloaded module while
        // this component's `surfaceReady` state survives the refresh. Rather
        // than crash the tree, go back to waiting and let the effect re-run.
        if (error instanceof Error && /decimator/.test(error.message)) {
          setSurfaceReady(false);
          void readySurface().then(() => setSurfaceReady(true));
          return;
        }
        throw error;
      }
      const rigged = props.spec
        ? Boolean(props.spec.rig || props.spec.joints?.length)
        : (props.recipe.kind === 'creature' ||
            props.recipe.kind === 'person') &&
          props.recipe.rigged;
      v.scene.add(model);
      v.model = model;
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
      if (rigged) {
        v.mixer = new T.AnimationMixer(model);
        // Through `pose`, so a rebuild that follows a bone edit does not start
        // the clip up again under the handle that is being placed.
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
      props.onStats(stats(model));
    }, [props.recipe, props.spec, surfaceReady]);
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
    }, [props.selected, props.spec, props.recipe, surfaceReady, mode]);
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
      v.pose();
    }, [props.animation, props.skeleton, onBone]);
    const editable = Boolean(props.spec);
    const picked = selectedPath(props.selected ?? null);
    const scattered =
      props.spec && picked
        ? partAt(props.spec, picked)?.repeat?.mode === 'surface'
        : false;
    return (
      <div className="asset-viewport">
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
        <div className="viewport-hint">
          {editable ? (
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
                  G/R/S TO SWITCH GIZMO <span>·</span> DEL REMOVES{' '}
                  <span>·</span> ⌘D DUPLICATES <span>·</span> ESC DESELECTS
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
