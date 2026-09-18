import * as T from 'three';
import { stats } from './asset-build';
import {
  boxDistance,
  collect,
  insideFaces,
  MESH_SAMPLES,
  type Piece,
} from './asset-audit';
import { boneLayout } from './asset-joints';
import { buildSpec, parseSpec, type Shape } from './asset-spec';
import { disposeScene } from './three-world';
import { flatten, jointBindingsByPath } from './spec-edit';

/**
 * Measuring tape for an authored spec.
 *
 * The audit says what is wrong. This says what is there — where every part
 * actually ended up, how big it is, what it nearly touches and by how much,
 * which bone carries it, and whether it survived the surface build at all.
 *
 * It exists because agents kept writing the same throwaway scripts. Two blind
 * authoring sessions spent most of their iterations rebuilding, by hand and
 * badly, the four numbers below: a part's world box, the gap to its neighbour,
 * the bone binding, and whether a part owns any surface. None of those are
 * cheap to get right — a bounding box is not a gap, and a gap measured between
 * bounding boxes is wrong for anything that is not a box — so getting them
 * right once, here, is worth more than any amount of advice.
 *
 * SAMPLING. Gaps are exact point-to-triangle distances, not box distances, on
 * the same bounded sample the audit uses: up to `MESH_SAMPLES` (140) points per
 * mesh, against EVERY triangle of the other mesh. Faces are never sampled,
 * because a surface missing four faces in five is a sieve. Candidate parts are
 * tried nearest-box-first and the search stops as soon as the remaining boxes
 * are further off than the best answer so far, so the pairwise cost collapses
 * to a handful of real comparisons per part.
 *
 * COST. One faceted build (~10-20 ms for 30 parts) plus, when the spec asks for
 * surface mode, exactly one surface build — the same one `oddlings build` pays.
 * At the default detail of 128 a 30-part surface spec measures in ~0.2 s; the
 * shipped specs at detail 320 take ~0.5-2 s, which is the surface build, not
 * the measuring. Pass `surface: false` to skip it and lose only the
 * surface-vertex columns.
 */

export type Vec3 = [number, number, number];

export type Bounds = {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  centre: Vec3;
};

export type Neighbour = {
  /** The other part's display name, and its path in the spec. */
  name: string;
  path: number[];
  /**
   * Clearance between the two surfaces, in world units after `spec.scale`.
   * Positive is a real gap; negative is how deep one sinks into the other.
   * Zero means they touch.
   */
  gap: number;
};

export type PartMeasure = {
  /** Index chain from the top of the spec — the same path findings carry. */
  path: number[];
  name: string;
  shape: Shape;
  /** Nesting depth, 0 for a top-level part. */
  depth: number;
  /** Meshes this one authored part expands into, counting mirror and repeat. */
  copies: number;
  /** Every copy's world box, unioned. After `spec.scale`. */
  bounds: Bounds;
  /** The bone this part follows: a `rigPart`, inherited from a parent if unset. */
  rigPart: string | null;
  /** The joint that carries it, for a mechanism spec. */
  joint: string | null;
  /**
   * Surface mode only: vertices of the fused mesh whose nearest primitive is
   * this part. Zero is the `no-surface` defect — the part is in the spec, costs
   * build time and cannot be seen. `null` when the spec is faceted.
   */
  surfaceVertices: number | null;
  ownsSurface: boolean | null;
  /** The nearest other part. Only filled for the parts that were asked about. */
  nearest: Neighbour | null;
};

export type BoneMeasure = {
  name: string;
  parent: string | null;
  /**
   * Model space, BEFORE `spec.scale` — the same space `joints[].at` and
   * `rig.bones` are written in, so a number read here can be written back.
   */
  at: Vec3;
  /** Vertices whose heaviest skin weight is this bone. */
  vertices: number;
};

export type SpecMeasure = {
  name: string;
  scale: number;
  /** Which backend built the geometry these numbers describe. */
  mode: 'faceted' | 'surface';
  /** The whole model's world box, after `spec.scale`. */
  bounds: Bounds;
  triangles: number;
  meshes: number;
  parts: PartMeasure[];
  /** `Root` first, then bones in skeleton order. Empty for an unrigged spec. */
  skeleton: BoneMeasure[];
  /** How these numbers were arrived at. See the sampling note above. */
  sampling: {
    meshSamples: number;
    /** How many parts got a `nearest`. */
    measuredParts: number;
    /** Vertices carrying a skin weight, which is what `skeleton` counts. */
    riggedVertices: number;
    ms: number;
  };
};

export type MeasureOptions = {
  /**
   * Part names to measure gaps for. Every part is measured by default, which
   * is what you want the first time; name two or three once you are iterating
   * on one corner of a model.
   */
  parts?: string[];
  /**
   * Run the surface build. Default true when the spec declares one. Turning it
   * off drops `surfaceVertices` and skips the expensive half of the work.
   */
  surface?: boolean;
};

/** Parity samples per overlapping pair. See `gapBetween`. */
const PARITY_SAMPLES = 16;

function round(n: number) {
  // `+ 0` folds -0 back to 0: a negative zero survives JSON and reads, in a
  // gap column, as a part that penetrates its neighbour by nothing at all.
  return Number(n.toFixed(4)) + 0;
}

function vec(v: T.Vector3): Vec3 {
  return [round(v.x), round(v.y), round(v.z)];
}

function bounds(box: T.Box3): Bounds {
  return {
    min: vec(box.min),
    max: vec(box.max),
    size: vec(box.getSize(new T.Vector3())),
    centre: vec(box.getCenter(new T.Vector3())),
  };
}

/**
 * Every sample point's distance to the other mesh's surface, in one pass.
 *
 * The clearance and the penetration depth are the same measurement read from
 * opposite ends — the smallest distance, and the largest distance that is
 * still inside — so they are worth computing together rather than walking
 * every triangle twice.
 */
function distances(small: Piece, large: Piece) {
  const closest = new T.Vector3();
  const scored = small.points.map((point) => {
    let d = Infinity;
    for (const face of large.faces) {
      face.closestPointToPoint(point, closest);
      const hit = closest.distanceTo(point);
      if (hit < d) d = hit;
    }
    return { point, d };
  });
  let min = Infinity;
  for (const entry of scored) if (entry.d < min) min = entry.d;
  return { scored, min };
}

/**
 * Signed clearance between two meshes: positive apart, negative interpenetrating.
 *
 * Penetration is the deepest sample of one mesh that lies inside the other,
 * which is the number an author can act on — "sunk 3 cm in" rather than
 * "overlapping". The parity test that decides inside from outside costs a ray
 * against every face, so it is spent only on the deepest handful of samples,
 * and only when the boxes overlap at all. A pair whose boxes are apart cannot
 * interpenetrate, and its clearance is already the answer.
 *
 * Samples outside the other part's own bounding box are dropped before the ray
 * is cast. It is a free necessary condition, and it is what stops a corner two
 * boxes share from being read as a point buried the full width of one of them.
 */
function gapBetween(a: Piece, b: Piece) {
  const [small, large] = a.radius <= b.radius ? [a, b] : [b, a];
  const { scored, min } = distances(small, large);
  if (boxDistance(a.box, b.box) > 0) return min;
  const deepest = scored
    .filter((entry) => large.box.containsPoint(entry.point))
    .sort((x, y) => y.d - x.d);
  for (const entry of deepest.slice(0, PARITY_SAMPLES))
    if (insideFaces(entry.point, large.faces)) return -entry.d;
  return min;
}

/** The nearest piece belonging to some other part, and how far off it is. */
function nearestOther(
  mine: Piece[],
  others: Piece[],
  label: (key: string) => string,
): Neighbour | null {
  let best: { gap: number; piece: Piece } | null = null;
  for (const piece of mine) {
    const ranked = others
      .map((other) => ({ other, floor: boxDistance(piece.box, other.box) }))
      .sort((x, y) => x.floor - y.floor);
    for (const { other, floor } of ranked) {
      // A box floor of 0 is the only floor an interpenetrating pair can have,
      // and those sort first — so once the floors go positive nothing left can
      // beat a negative best.
      if (best && floor > Math.max(0, best.gap)) break;
      const gap = gapBetween(piece, other);
      if (!best || gap < best.gap) best = { gap, piece: other };
    }
  }
  if (!best) return null;
  return {
    name: label(best.piece.partKey),
    path: best.piece.path ?? [],
    gap: round(best.gap),
  };
}

/** Vertices per bone, by heaviest weight, across every skinned mesh. */
function boneVertices(model: T.Object3D) {
  const counts = new Map<string, number>();
  let total = 0;
  model.traverse((object) => {
    if (!(object instanceof T.SkinnedMesh)) return;
    const index = object.geometry.attributes.skinIndex as
      | T.BufferAttribute
      | undefined;
    const weight = object.geometry.attributes.skinWeight as
      | T.BufferAttribute
      | undefined;
    if (!index || !weight) return;
    const bones = object.skeleton.bones;
    for (let i = 0; i < index.count; i++) {
      let pick = 0;
      let heaviest = -1;
      for (let slot = 0; slot < 4; slot++) {
        const w = weight.getComponent(i, slot);
        if (w <= heaviest) continue;
        heaviest = w;
        pick = index.getComponent(i, slot);
      }
      const bone = bones[pick];
      if (!bone) continue;
      total++;
      counts.set(bone.name, (counts.get(bone.name) ?? 0) + 1);
    }
  });
  return { counts, total };
}

/**
 * Measure an authored spec.
 *
 * Deterministic, and free of side effects: nothing is written and no file is
 * read. The returned object is plain JSON, so it survives an MCP boundary and
 * a `--json` pipe unchanged.
 */
export function measureSpec(
  // `unknown`, like `buildSpec`: a spec off disk or across an MCP boundary is
  // untyped JSON until `parseSpec` has had a look at it.
  input: unknown,
  options: MeasureOptions = {},
): SpecMeasure {
  const started = Date.now();
  const spec = parseSpec(input);
  const wantSurface = Boolean(spec.surface) && options.surface !== false;

  // The model as it really ships, for the skeleton and the fused shell.
  const real = buildSpec(wantSurface ? spec : { ...spec, surface: undefined });
  // And the same parts as separate solids, which is the only backend that
  // still knows where each authored part went. A fused mesh has one box for
  // the whole creature. Rigging is dropped from this one: it bakes geometry
  // into model space and then skins it, and the skinning is pure cost here.
  const faceted = wantSurface
    ? buildSpec({
        ...spec,
        surface: undefined,
        rig: undefined,
        joints: undefined,
      })
    : real;

  try {
    const rows = flatten(spec);
    const labels = new Map(
      rows.map((row) => [
        row.path.join('.'),
        row.part.name ?? row.part.shape,
      ]),
    );
    const label = (key: string) => labels.get(key) ?? key;
    const joints = jointBindingsByPath(spec);

    const byPart = new Map<string, Piece[]>();
    for (const piece of collect(faceted).pieces) {
      const group = byPart.get(piece.partKey);
      if (group) group.push(piece);
      else byPart.set(piece.partKey, [piece]);
    }

    // Which parts were asked about. A name that matches nothing is a typo, and
    // silently measuring nothing would look like a model with no neighbours.
    let wanted: Set<string> | null = null;
    if (options.parts?.length) {
      wanted = new Set<string>();
      for (const name of options.parts) {
        const found = rows.filter((row) => row.part.name === name);
        if (!found.length)
          throw Error(
            `No part is called "${name}". Named parts: ${rows
              .map((row) => row.part.name)
              .filter(Boolean)
              .join(', ') || '(none)'}.`,
          );
        for (const row of found) wanted.add(row.path.join('.'));
      }
    }

    // Surface ownership, counted per authored part rather than per primitive,
    // because a repeat's copies share one path and an author edits the path.
    const owned = new Map<string, number>();
    if (wantSurface)
      real.traverse((object) => {
        if (!(object instanceof T.Mesh)) return;
        const owners = object.geometry.userData.surfaceOwners as
          | { index: Uint16Array; paths: (number[] | undefined)[] }
          | undefined;
        if (!owners) return;
        for (let i = 0; i < owners.index.length; i++) {
          const path = owners.paths[owners.index[i]];
          if (!path) continue;
          const key = path.join('.');
          owned.set(key, (owned.get(key) ?? 0) + 1);
        }
      });

    let measuredParts = 0;
    const parts: PartMeasure[] = rows.map((row) => {
      const key = row.path.join('.');
      const mine = byPart.get(key) ?? [];
      const box = new T.Box3();
      for (const piece of mine) box.union(piece.box);
      const ask = !wanted || wanted.has(key);
      const others = ask
        ? [...byPart.entries()]
            .filter(([other]) => other !== key)
            .flatMap(([, group]) => group)
        : [];
      const nearest = ask && mine.length && others.length
        ? nearestOther(mine, others, label)
        : null;
      if (nearest) measuredParts++;
      return {
        path: row.path,
        name: row.part.name ?? row.part.shape,
        shape: row.part.shape,
        depth: row.depth,
        copies: mine.length || row.copies,
        bounds: bounds(box.isEmpty() ? new T.Box3().set(
          new T.Vector3(),
          new T.Vector3(),
        ) : box),
        rigPart: mine[0]?.rigPart ?? row.part.rigPart ?? null,
        joint: joints.get(key) ?? null,
        surfaceVertices: wantSurface ? (owned.get(key) ?? 0) : null,
        ownsSurface: wantSurface ? (owned.get(key) ?? 0) > 0 : null,
        nearest,
      };
    });

    const { counts, total } = boneVertices(real);
    const skeleton: BoneMeasure[] = boneLayout(spec).map((bone) => ({
      name: bone.name,
      parent: bone.parent,
      at: [round(bone.at[0]), round(bone.at[1]), round(bone.at[2])],
      vertices: counts.get(bone.name) ?? 0,
    }));

    const measured = stats(real);
    return {
      name: spec.name,
      scale: spec.scale,
      mode: wantSurface ? 'surface' : 'faceted',
      bounds: bounds(new T.Box3().setFromObject(real)),
      triangles: measured.triangles,
      meshes: measured.meshes,
      parts,
      skeleton,
      sampling: {
        meshSamples: MESH_SAMPLES,
        measuredParts,
        riggedVertices: total,
        ms: Date.now() - started,
      },
    };
  } finally {
    if (faceted !== real) disposeScene(faceted);
    disposeScene(real);
  }
}
