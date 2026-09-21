import * as T from 'three';
import { weldByPosition } from './asset-smooth';
import { AUTO_WEIGHT, autoBone } from './asset-rig';
import { buildSpec, type AssetSpec } from './asset-spec';
import { auditVisual, type VisualOptions } from './asset-audit-visual';
import { disposeScene } from './three-world';

/**
 * Geometry checks that run on a finished model.
 *
 * The point is to catch, from numbers alone, the mistakes that otherwise only
 * surface when a human looks at the thing from an angle nobody rendered: parts
 * hanging in mid-air, a model that fell into pieces, a character too big for
 * the rig's fixed weighting bands.
 *
 * Every check has to be worth acting on. A check that cries wolf trains its
 * reader to skip the whole report, which is the failure this is meant to
 * design out — so anything with a high false-positive rate is deliberately
 * absent. See the closing note.
 */

export type Severity = 'error' | 'warn' | 'info';

/**
 * The edit that would clear a finding, as numbers rather than advice.
 *
 * A message can say a part is floating; only a vector says which way and how
 * far. Working that out by hand is what agents spend their iterations on —
 * they write a throwaway script, measure two boxes, guess an axis, rebuild,
 * and guess again. Every field here is in SPEC units, before `spec.scale`, so
 * it can be added to an authored number without conversion.
 */
export type Hint = {
  /**
   * Translation to add to the part's `position`, in model space.
   *
   * Model space, not parent space: a top-level part takes it as written, and a
   * child of a ROTATED parent needs it rotated into that parent's frame first.
   * Most parts have an unrotated parent, so most of the time it is the former.
   */
  move?: [number, number, number];
  /**
   * A value to raise a setting to. Only `detached-shell` carries it, where it
   * is the `surface.blend` that would close the gap — blend fuses parts up to
   * half its own width, so it is twice the measured gap. The gap itself is on
   * the finding's `threshold`, in the same spec units, so neither number has
   * to be recovered from the other.
   */
  grow?: number;
  /** The part the fix is measured against: what to move toward, or fuse with. */
  toward?: string;
};

export type Finding = {
  severity: Severity;
  /** Stable machine-readable id, e.g. `detached-part`. */
  code: string;
  message: string;
  /** The authored spec part this concerns, when the model came from a spec. */
  part?: number[];
  value?: number;
  threshold?: number;
  /** How to fix it, in numbers. See `Hint`. Absent when nothing can be said. */
  hint?: Hint;
};

export type Audit = {
  /** True when nothing was reported as an error. */
  ok: boolean;
  findings: Finding[];
};

/**
 * Surface samples kept per mesh. Low-poly parts are sampled exhaustively; the
 * cap only bites on dense geometry, where a subset tells "touching" from
 * "floating" just as well.
 */
export const MESH_SAMPLES = 140;

export type Piece = {
  /** One mesh — one copy of an authored part. */
  id: number;
  /** The authored part it came from; copies of one part share this. */
  partKey: string;
  path?: number[];
  points: T.Vector3[];
  /** World-space faces, so contact can be measured against the surface. */
  faces: T.Triangle[];
  box: T.Box3;
  centre: T.Vector3;
  radius: number;
  rigPart?: string;
};

/**
 * Sample points across a mesh's surface, not only at its corners.
 *
 * Two solids that interpenetrate share no vertices — a blossom pushed into a
 * leafy dome has its corners centimetres from the dome's corners even though
 * the surfaces cross. Measuring corner to corner therefore reports every part
 * of every model as detached. Face centroids and edge midpoints put samples
 * where the surfaces actually meet.
 *
 * Exported because `asset-measure` answers "how far apart are these two parts"
 * with the same machinery. One sampler means the gap a measurement reports and
 * the gap a finding was raised on cannot disagree.
 */
export function sampleMesh(mesh: T.Mesh) {
  const position = mesh.geometry.attributes.position as T.BufferAttribute;
  // An indexed geometry (a lathe, a loft) lists its triangles through the
  // index; reading positions in threes there walks vertex columns instead, and
  // a stride that lands on the ring count samples one ring of the whole part.
  const index = mesh.geometry.index;
  const vertex = (k: number) => (index ? index.getX(k) : k);
  const triangles = Math.floor((index ? index.count : position.count) / 3);
  // Points are sampled; faces never are. Distance and containment are both
  // measured against the surface, and a surface missing four faces in five is
  // a sieve: rays pass through the gaps and the parity test lies.
  const step = Math.max(1, Math.ceil(triangles / (MESH_SAMPLES / 7)));
  const points: T.Vector3[] = [];
  const faces: T.Triangle[] = [];
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  // One sample per window of `step` triangles, at a scrambled offset inside
  // the window. A fixed stride aliases with structured meshes: a lathe emits
  // its triangles column by column, and a stride equal to the column length
  // samples the same ring of every column and reports a dome as a disc.
  let window = 0;
  let next = 0;
  for (let t = 0; t < triangles; t++) {
    const i = t * 3;
    a.fromBufferAttribute(position, vertex(i)).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, vertex(i + 1)).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, vertex(i + 2)).applyMatrix4(mesh.matrixWorld);
    faces.push(new T.Triangle(a.clone(), b.clone(), c.clone()));
    if (t !== next) continue;
    window++;
    next = Math.min(triangles - 1, window * step + ((window * 7919) % step));
    points.push(
      a.clone(),
      b.clone(),
      c.clone(),
      new T.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3),
      new T.Vector3().addVectors(a, b).multiplyScalar(0.5),
      new T.Vector3().addVectors(b, c).multiplyScalar(0.5),
      new T.Vector3().addVectors(a, c).multiplyScalar(0.5),
    );
  }
  return { points, faces };
}

/**
 * One entry per mesh, because a repeat makes many copies of one part and they
 * do not stand or fall together: four blossoms can sit in the foliage while
 * two hang in the air above it. Auditing the part as a whole would let the
 * attached copies vouch for the floating ones.
 *
 * Exported for `asset-measure`, which reports on the same units the findings
 * are raised on — a report that grouped copies differently from the audit
 * would send an agent looking for a part the audit never named.
 */
export function collect(model: T.Object3D) {
  const pieces: Piece[] = [];
  let grouped = false;
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const path = o.userData.specPath as number[] | undefined;
    if (path) grouped = true;
    const { points, faces } = sampleMesh(o);
    if (!points.length) return;
    const box = new T.Box3().setFromPoints(points);
    pieces.push({
      id: pieces.length,
      partKey: path ? path.join('.') : `mesh-${pieces.length}`,
      path,
      points,
      faces,
      box,
      centre: box.getCenter(new T.Vector3()),
      radius: box.getSize(new T.Vector3()).length() / 2,
      rigPart: o.userData.rigPart as string | undefined,
    });
  });
  return { pieces, grouped };
}

/**
 * What the rig will actually bind, as points in the model's own space.
 *
 * A faceted asset binds a whole mesh to one bone, so one sample per mesh says
 * everything. A surface asset is a single mesh covering the entire body and
 * binds vertex by vertex, so asking it for one bone would answer for the
 * creature's centre of mass and nothing else — every leg check would fail on a
 * model whose legs are bound perfectly well. Sampling vertices instead keeps
 * the rig findings measuring the binding rather than the backend.
 */
type RigSample = {
  x: number;
  y: number;
  minY: number;
  maxY: number;
  rigPart?: string;
};

function rigSamples(model: T.Object3D, scale: number) {
  const samples: RigSample[] = [];
  let perVertex = false;
  const point = new T.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const bound = o.geometry.userData.rigParts as
      | (string | undefined)[]
      | undefined;
    // Geometry a `joints` chain claimed is bound as surely as a `rigPart` pin
    // is — more so, since the author named the part — so it counts as pinned
    // here. Otherwise a cape hanging above the head band would be reported as
    // a torso about to swing with the head.
    const jointed = o.geometry.userData.jointParts as
      | (string | undefined)[]
      | undefined;
    if (bound) {
      perVertex = true;
      const position = o.geometry.attributes.position as T.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        const y = point.y / scale;
        samples.push({
          x: point.x / scale,
          y,
          minY: y,
          maxY: y,
          rigPart: bound[i] ?? jointed?.[i],
        });
      }
      return;
    }
    const box = new T.Box3().setFromObject(o);
    const centre = box.getCenter(new T.Vector3());
    samples.push({
      x: centre.x / scale,
      y: centre.y / scale,
      minY: box.min.y / scale,
      maxY: box.max.y / scale,
      // A faceted mesh is one part on one bone, so its first vertex answers
      // for all of them.
      rigPart: (o.userData.rigPart as string | undefined) ?? jointed?.[0],
    });
  });
  return { samples, unit: perVertex ? 'vertex' : 'mesh' };
}

/** Shortest distance between two axis-aligned boxes; zero when they overlap. */
export function boxDistance(a: T.Box3, b: T.Box3) {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
}

/**
 * The closest the two surfaces come, and the pair of points that achieves it.
 *
 * Measured from the sparser mesh's sample points to the denser mesh's faces,
 * for the reason `touching` gives: sampling density must not decide the
 * answer. `from` lies on `small`, `to` on `large`, so `to - from` is the
 * translation that brings the first into contact with the second.
 */
export function nearestBetween(small: Piece, large: Piece) {
  const closest = new T.Vector3();
  let distance = Infinity;
  const from = new T.Vector3();
  const to = new T.Vector3();
  for (const point of small.points)
    for (const face of large.faces) {
      face.closestPointToPoint(point, closest);
      const d = closest.distanceTo(point);
      if (d >= distance) continue;
      distance = d;
      from.copy(point);
      to.copy(closest);
    }
  return { distance, from, to };
}

/**
 * Is this point inside that closed surface? Ray-parity, as `enclosedBy`.
 *
 * The direction is deliberately not an axis. Every primitive here has
 * axis-aligned faces somewhere, and a ray cast down an axis from a sampled
 * corner runs along an edge of the other mesh, where a triangle intersection
 * is a coin toss — which reads back as "this corner is deep inside the part
 * next to it". An oblique direction misses every edge it is not aimed at.
 */
const PROBE = new T.Vector3(0.5601, 0.6215, 0.5477).normalize();

export function insideFaces(point: T.Vector3, faces: T.Triangle[]) {
  const ray = new T.Ray(point, PROBE.clone());
  const hit = new T.Vector3();
  let crossings = 0;
  for (const face of faces)
    if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) crossings++;
  return crossings % 2 === 1;
}

/**
 * Do these two meshes touch?
 *
 * Measured from the smaller mesh's sample points to the larger mesh's faces,
 * never point to point. Samples are capped per mesh, so a 2 m tower carries
 * them 20 cm apart while a 16 cm window carries them 2 cm apart; comparing the
 * two sets of points would call an embedded window detached simply because the
 * tower had no sample nearby. Distance to the surface itself does not care how
 * finely that surface was sampled.
 *
 * The tolerance scales with the smaller mesh, because a single absolute
 * epsilon cannot serve a model holding both a 2 mm bead and a 2 m tower.
 */
function touching(a: Piece, b: Piece) {
  const tolerance = Math.max(Math.min(a.radius, b.radius) * 0.25, 0.002);
  if (boxDistance(a.box, b.box) > tolerance) return false;
  const [small, large] = a.radius <= b.radius ? [a, b] : [b, a];
  const closest = new T.Vector3();
  for (const point of small.points)
    for (const face of large.faces) {
      face.closestPointToPoint(point, closest);
      if (closest.distanceTo(point) <= tolerance) return true;
    }
  // Surfaces can be far apart while the parts could not be more attached: a
  // bud pushed deep into a bush sits centimetres from the foliage's outer
  // shell. Distance alone would call that detached and push authors towards
  // parts that merely graze the body.
  return enclosedBy(small, large);
}

/**
 * Is this part inside that one? Counts how many faces a ray from its centre
 * crosses on the way out — an odd number means it started within a closed
 * surface, which every primitive here is.
 */
function enclosedBy(inner: Piece, outer: Piece) {
  if (!outer.box.containsPoint(inner.centre)) return false;
  const ray = new T.Ray(inner.centre, new T.Vector3(1, 0, 0));
  const hit = new T.Vector3();
  let crossings = 0;
  for (const face of outer.faces)
    if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) crossings++;
  return crossings % 2 === 1;
}

/**
 * Split one mesh into its connected shells.
 *
 * A surface-mode asset is a single mesh, so the mesh-to-mesh contact test above
 * has nothing to compare and would cheerfully report that the model hangs
 * together while half of it floats. Topology answers the question exactly
 * instead: two vertices belong to the same shell when a chain of triangles
 * joins them, with no distance tolerance to guess at.
 */
function shellsOf(geometry: T.BufferGeometry) {
  const index = geometry.index;
  const count = (geometry.attributes.position as T.BufferAttribute).count;
  if (!index) return [];

  // A crease split duplicates vertices along hard edges. Those are the same
  // points of the same shell, so the walk runs over welded ids and only the
  // grouping at the end hands back every duplicate.
  const canon = weldByPosition(geometry);
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = canon[i];
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < index.count; i += 3) {
    const a = find(index.getX(i));
    const b = find(index.getX(i + 1));
    const c = find(index.getX(i + 2));
    if (a !== b) parent[b] = a;
    if (a !== c) parent[find(c)] = a;
  }
  const shells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const group = shells.get(root);
    if (group) group.push(i);
    else shells.set(root, [i]);
  }
  return [...shells.values()].sort((a, b) => b.length - a.length);
}

/**
 * Edges used by exactly one triangle — the rim of a hole.
 *
 * An open shell is the one surface defect an engine cannot work around: it has
 * no inside, so it shadows wrong, it cannot be a collider, and a physics solver
 * will happily pour things through it.
 */
function openEdges(geometry: T.BufferGeometry) {
  const index = geometry.index;
  if (!index) return 0;
  const uses = new Map<number, number>();
  const count = (geometry.attributes.position as T.BufferAttribute).count;
  const canon = weldByPosition(geometry);
  for (let i = 0; i < index.count; i += 3) {
    const tri = [
      canon[index.getX(i)],
      canon[index.getX(i + 1)],
      canon[index.getX(i + 2)],
    ];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? a * count + b : b * count + a;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of uses.values()) if (n === 1) open++;
  return open;
}

/** Group meshes into chunks that hang together. */
function componentsOf(pieces: Piece[]) {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      if (find(i) === find(j)) continue;
      if (touching(pieces[i], pieces[j])) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Piece[]>();
  pieces.forEach((piece, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), piece]);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// --- fix hints ---------------------------------------------------------
//
// Everything below turns a finding into an edit. It runs only when a finding
// has already been raised, so a clean model pays nothing for it.

/**
 * Four decimals, which is a tenth of a millimetre.
 *
 * Rounding has to be tight enough that applying the hint really does clear the
 * finding: contact is judged against a tolerance of at least 2 mm, and the
 * worst case here is 5e-5 per axis. Printing eight decimals of float noise
 * would be worse than useless to the reader.
 */
function round4(n: number) {
  return Number(n.toFixed(4));
}

function movement(delta: T.Vector3, scale: number): [number, number, number] {
  return [
    round4(delta.x / scale),
    round4(delta.y / scale),
    round4(delta.z / scale),
  ];
}

/**
 * The stray's shortest route back to the body, as a translation.
 *
 * Measured both ways round and the shorter kept, because the sampled side is
 * the approximate one: a dense stray beside a two-triangle plate is best
 * measured from the plate, and the reverse for a stray the size of a rivet.
 */
function routeTo(stray: Piece, body: Piece[]) {
  let best: { delta: T.Vector3; distance: number; piece: Piece } | null = null;
  // Nearest boxes first, so `best` collapses early and the box test below
  // rejects almost every remaining candidate before any triangle is touched.
  const ranked = body
    .map((piece) => ({ piece, floor: boxDistance(stray.box, piece.box) }))
    .sort((a, b) => a.floor - b.floor);
  for (const { piece, floor } of ranked) {
    if (best && floor > best.distance) break;
    const out = nearestBetween(stray, piece);
    const back = nearestBetween(piece, stray);
    const [distance, delta] = out.distance <= back.distance
      ? [out.distance, out.to.clone().sub(out.from)]
      : [back.distance, back.from.clone().sub(back.to)];
    if (!best || distance < best.distance) best = { delta, distance, piece };
  }
  return best;
}

/** World-space triangles of an indexed mesh — the fused surface, in practice. */
function indexedFaces(mesh: T.Mesh, keep?: (a: number) => boolean) {
  const position = mesh.geometry.attributes.position as T.BufferAttribute;
  const index = mesh.geometry.index;
  if (!index) return [];
  const faces: T.Triangle[] = [];
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i),
      ib = index.getX(i + 1),
      ic = index.getX(i + 2);
    if (keep && !(keep(ia) && keep(ib) && keep(ic))) continue;
    faces.push(
      new T.Triangle(
        a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld).clone(),
        b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld).clone(),
        c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld).clone(),
      ),
    );
  }
  return faces;
}

/** Closest point on a triangle soup, and how far it is. */
function nearestOnFaces(point: T.Vector3, faces: T.Triangle[]) {
  const closest = new T.Vector3();
  const at = new T.Vector3();
  let distance = Infinity;
  for (const face of faces) {
    face.closestPointToPoint(point, closest);
    const d = closest.distanceTo(point);
    if (d >= distance) continue;
    distance = d;
    at.copy(closest);
  }
  return { distance, at };
}

/**
 * How far the part reaches from its own centre along `direction`.
 *
 * A buried part has to travel its own half-width plus the depth it is sunk to,
 * and half-width is not half the bounding box: a plate pushed edge-on into a
 * hull reaches barely a centimetre one way and twenty the other. Casting
 * against the part's own faces measures the direction that matters.
 */
function reachAlong(piece: Piece, direction: T.Vector3) {
  const ray = new T.Ray(piece.centre.clone(), direction);
  const hit = new T.Vector3();
  let far = 0;
  for (const face of piece.faces)
    if (ray.intersectTriangle(face.a, face.b, face.c, false, hit))
      far = Math.max(far, hit.distanceTo(piece.centre));
  return far;
}

type SurfaceOwners = {
  index: Uint16Array;
  paths: (number[] | undefined)[];
  /** True for the primitives that carve the field instead of adding to it. */
  subtract?: boolean[];
};

/**
 * How far to push a buried part until it shows.
 *
 * The fused mesh is the only geometry a surface build leaves behind, and it
 * has no record of where a part that owns none of it went. Rebuilding the same
 * spec through the faceted backend puts the part's own box and faces back in
 * hand — it costs one extra build, which is why nothing calls this unless a
 * `no-surface` finding has already been raised.
 *
 * The push is the part's own reach along the outward normal, plus the depth it
 * is sunk to, plus one grid cell of clearance: a part flush with its
 * neighbour's surface still owns nothing, because every vertex there is a tie
 * the neighbour wins. All distances are world-space until `movement` converts.
 */
function burialHints(
  fused: T.Mesh,
  wanted: number[][],
  spec: AssetSpec,
  scale: number,
  voxel: number,
  label: (key: string) => string,
): Map<string, Hint> {
  const hints = new Map<string, Hint>();
  // Rigging only re-parents geometry it has already baked into model space, so
  // dropping it changes nothing a box or a face would notice, and saves the
  // skinning pass.
  const faceted = buildSpec({
    ...spec,
    surface: undefined,
    rig: undefined,
    joints: undefined,
    // The whole point is to find a part buried in its neighbour, which is
    // exactly what trimming would remove.
    trim: false,
  });
  try {
    const byKey = new Map<string, Piece>();
    for (const piece of collect(faceted).pieces)
      if (!byKey.has(piece.partKey)) byKey.set(piece.partKey, piece);
    const faces = indexedFaces(fused);
    if (!faces.length) return hints;
    const owners = fused.geometry.userData.surfaceOwners as
      | SurfaceOwners
      | undefined;
    const position = fused.geometry.attributes.position as T.BufferAttribute;
    const vertex = new T.Vector3();
    for (const path of wanted) {
      const key = path.join('.');
      const piece = byKey.get(key);
      if (!piece) continue;
      const near = nearestOnFaces(piece.centre, faces);
      if (!Number.isFinite(near.distance) || near.distance < 1e-9) continue;
      // The part is buried, so the closest point on the shell is outward from
      // its centre by definition.
      const out = near.at.clone().sub(piece.centre).normalize();
      const depth = near.distance - reachAlong(piece, out);
      // The neighbour to become proud of: the nearest surface vertex that
      // belongs to some OTHER part. Another copy of this same part owning the
      // vertex says nothing an author can act on.
      let toward: string | undefined;
      if (owners) {
        let best = Infinity;
        for (let i = 0; i < position.count; i++) {
          const from = owners.paths[owners.index[i]];
          if (!from || from.join('.') === key) continue;
          const d = vertex
            .fromBufferAttribute(position, i)
            .applyMatrix4(fused.matrixWorld)
            .distanceToSquared(near.at);
          if (d >= best) continue;
          best = d;
          toward = label(from.join('.'));
        }
      }
      const push = depth + voxel;
      hints.set(key, {
        // A negative push means the part already stands proud and was lost to
        // decimation instead. Moving it further out would not bring it back,
        // so say nothing rather than something wrong.
        ...(push > 0 ? { move: movement(out.multiplyScalar(push), scale) } : {}),
        ...(toward ? { toward } : {}),
      });
    }
  } finally {
    disposeScene(faceted);
  }
  return hints;
}

export type AuditOptions = {
  /** True when the model is rigged, which enables the weighting checks. */
  rigged?: boolean;
  /**
   * The spec's display scale. Skinning happens before it is applied, so the
   * rig's fixed height bands must be compared against unscaled geometry — a
   * 1.2 m character shown at scale 2 is still a 1.2 m character to the rigger.
   */
  scale?: number;
  /** Part paths to readable names, for the messages. */
  labels?: Map<string, string>;
  /**
   * Also rasterise the model and report what a picture of it shows: parts
   * that read as one shape, triangles no camera reaches. Off by default
   * because it costs a few hundred milliseconds and this is the call an agent
   * makes in a loop. See `asset-audit-visual`.
   */
  visual?: boolean | VisualOptions;
};

export function auditModel(
  model: T.Object3D,
  options: AuditOptions = {},
): Audit {
  const findings: Finding[] = [];
  // Contact and burial are questions about the authored solids. A trimmed
  // faceted model has had its hidden faces removed — exactly the faces that
  // touch a neighbour — so those checks run on an untrimmed rebuild of the
  // same spec. The rebuild is disposed at the end; every finding still points
  // at the model that was passed in.
  const authored = model.userData.spec as AssetSpec | undefined;
  const solid =
    model.userData.trimmed && authored
      ? buildSpec({ ...authored, trim: false, rig: undefined, joints: undefined })
      : model;
  const { pieces, grouped } = collect(solid);
  const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
  const name = (key: string) => options.labels?.get(key) ?? key;
  // Geometry is measured in world space, which carries the display scale;
  // every hint is an edit to an authored number, which does not. One divisor,
  // declared once, is the difference between a hint an agent can paste and a
  // hint that moves a part twice as far as it should.
  const scale = options.scale && options.scale > 0 ? options.scale : 1;

  if (!pieces.length) {
    findings.push({
      severity: 'error',
      code: 'empty',
      message: 'This asset contains no meshes.',
    });
    return { ok: false, findings };
  }

  const tiny = new Map<string, number>();
  for (const piece of pieces)
    if (piece.radius < 1e-3)
      tiny.set(piece.partKey, (tiny.get(piece.partKey) ?? 0) + 1);
  for (const [key, count] of tiny)
    findings.push({
      severity: 'error',
      code: 'degenerate-part',
      part: pieces.find((p) => p.partKey === key)?.path,
      value: count,
      message: `"${name(key)}" is too small to see${count > 1 ? ` (${count} copies)` : ''}.`,
    });

  // --- detachment -------------------------------------------------------
  // Only meaningful for spec-built models. A generator's meshes are placed by
  // hand-tuned code, and reporting on those would be noise, not signal.
  if (grouped && pieces.length > 1) {
    const components = componentsOf(pieces);
    const [body, ...loose] = components;
    if (loose.length) {
      const strays = loose.flat();
      const stray = new Map<string, number>();
      for (const piece of strays)
        stray.set(piece.partKey, (stray.get(piece.partKey) ?? 0) + 1);
      const total = new Map<string, number>();
      for (const piece of pieces)
        total.set(piece.partKey, (total.get(piece.partKey) ?? 0) + 1);
      for (const [key, count] of stray) {
        // The route is measured from a copy that actually floats. Picking the
        // first copy with this path would sometimes pick one already sitting
        // in the body, and hand back a move of zero.
        const adrift = strays.find((p) => p.partKey === key)!;
        const route = routeTo(adrift, body);
        findings.push({
          severity: 'error',
          code: 'detached-part',
          part: pieces.find((p) => p.partKey === key)?.path,
          value: count,
          threshold: total.get(key),
          message: `${count} of ${total.get(key)} "${name(key)}" ${count === 1 ? 'sits' : 'sit'} in mid-air, touching nothing. Move ${count === 1 ? 'it' : 'them'} into the body, or place the part against a surface instead of at a fixed radius. Or add "rest": { "on": "<part>" } and let the builder find the contact.`,
          ...(route
            ? {
                hint: {
                  move: movement(route.delta, scale),
                  toward: name(route.piece.partKey),
                },
              }
            : {}),
        });
      }
      findings.push({
        severity: 'info',
        code: 'components',
        value: components.length,
        message: `${body.length} of ${pieces.length} meshes form the main body; ${strays.length} float free across ${loose.length} piece${loose.length === 1 ? '' : 's'}.`,
      });
    } else
      findings.push({
        severity: 'info',
        code: 'connected',
        message: `All ${pieces.length} meshes hang together.`,
      });
    const trimmed = model.userData.trimmed as { removed: number; kept: number } | undefined;
    if (trimmed?.removed)
      findings.push({
        severity: 'info',
        code: 'trimmed',
        value: trimmed.removed,
        message: `Trimmed ${trimmed.removed} hidden triangles (${Math.round((100 * trimmed.removed) / (trimmed.removed + trimmed.kept))}% of the kitbash) that were buried in, or lying flat on, parts that move with them.`,
      });
  }

  // --- where the triangle budget went ------------------------------------
  // Per authored part, for either backend: a part that takes a fifth of the
  // triangles for a hundredth of the surface is a rivet or a fillet that the
  // decimator could not let go of, and the number is the argument for
  // `surface.feature`, a larger `blend`, or simply dropping the part.
  {
    const tris = new Map<string, number>();
    const area = new Map<string, number>();
    const va = new T.Vector3(), vb = new T.Vector3(), vc = new T.Vector3();
    let totalTris = 0, totalArea = 0;
    const tally = (key: string, t: number, a: number) => {
      tris.set(key, (tris.get(key) ?? 0) + t);
      area.set(key, (area.get(key) ?? 0) + a);
      totalTris += t;
      totalArea += a;
    };
    model.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      const geometry = object.geometry;
      const position = geometry.attributes.position as T.BufferAttribute | undefined;
      if (!position) return;
      const owners = geometry.userData.surfaceOwners as
        | { index: Uint16Array; paths: (number[] | undefined)[] }
        | undefined;
      const index = geometry.index;
      const count = index ? index.count : position.count;
      const at = (i: number) => (index ? index.getX(i) : i);
      const meshKey = (object.userData.specPath as number[] | undefined)?.join('.') ?? object.name;
      for (let i = 0; i < count; i += 3) {
        const a = at(i), b = at(i + 1), c = at(i + 2);
        va.fromBufferAttribute(position, a);
        vb.fromBufferAttribute(position, b).sub(va);
        vc.fromBufferAttribute(position, c).sub(va);
        const tri = vb.cross(vc).length() / 2;
        const key = owners ? (owners.paths[owners.index[a]] ?? []).join('.') : meshKey;
        tally(key, 1, tri);
      }
    });
    if (totalTris > 0 && tris.size > 1) {
      const rows = [...tris.entries()]
        .map(([key, t]) => ({ key, t, share: t / totalTris, areaShare: (area.get(key) ?? 0) / Math.max(totalArea, 1e-9) }))
        .sort((x, y) => y.t - x.t);
      const top = rows.slice(0, 4).map((r) => `${name(r.key)} ${Math.round(r.share * 100)}%`).join(', ');
      // The worst offender by triangles per unit of surface, among parts big
      // enough to matter.
      const greedy = rows
        .filter((r) => r.share >= 0.02)
        .sort((x, y) => y.share / Math.max(y.areaShare, 1e-6) - x.share / Math.max(x.areaShare, 1e-6))[0];
      let note = '';
      if (greedy && greedy.share / Math.max(greedy.areaShare, 1e-6) > 3)
        note = ` "${name(greedy.key)}" takes ${Math.round(greedy.share * 100)}% of the triangles for ${Math.max(1, Math.round(greedy.areaShare * 100))}% of the surface; raise surface.feature or blend, or simplify it.`;
      findings.push({
        severity: 'info',
        code: 'budget',
        message: `Triangles by part: ${top}.${note}`,
      });
    }
  }

  // --- one mesh, but is it one piece? ------------------------------------
  model.traverse((object) => {
    if (!(object instanceof T.Mesh) || !object.userData.surface) return;
    const open = openEdges(object.geometry);
    if (open)
      findings.push({
        severity: 'error',
        code: 'open-shell',
        value: open,
        message: `The mesh has ${open} edges with only one triangle on them, so it is not closed. A shell with holes has no inside: it shadows wrong and cannot be used as a collider.`,
      });
    const shells = shellsOf(object.geometry);
    if (shells.length < 2) {
      findings.push({
        severity: 'info',
        code: 'one-shell',
        message: `The mesh is a single connected shell of ${shells[0]?.length ?? 0} vertices.`,
      });
      return;
    }
    const owners = object.geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (number[] | undefined)[] }
      | undefined;
    // The main shell as triangles, built once however many strays there are.
    const inBody = new Uint8Array(
      (object.geometry.attributes.position as T.BufferAttribute).count,
    );
    for (const vertex of shells[0]) inBody[vertex] = 1;
    const bodyFaces = indexedFaces(object, (v) => inBody[v] === 1);
    const vertexAt = (i: number) =>
      new T.Vector3()
        .fromBufferAttribute(
          object.geometry.attributes.position as T.BufferAttribute,
          i,
        )
        .applyMatrix4(object.matrixWorld);
    for (const shell of shells.slice(1)) {
      const parts = new Set<string>();
      let path: number[] | undefined;
      if (owners)
        for (const vertex of shell) {
          const from = owners.paths[owners.index[vertex]];
          if (!from) continue;
          path ??= from;
          parts.add(name(from.join('.')));
        }
      const made = parts.size
        ? ` It is made of ${[...parts].slice(0, 4).join(', ')}.`
        : '';
      // How far the stray floats, and from what. Measured vertex-to-triangle
      // so the answer is a real clearance rather than a bounding-box guess.
      let gap = Infinity;
      let landing: T.Vector3 | null = null;
      const stride = Math.max(1, Math.ceil(shell.length / MESH_SAMPLES));
      for (let i = 0; i < shell.length; i += stride) {
        const near = nearestOnFaces(vertexAt(shell[i]), bodyFaces);
        if (near.distance >= gap) continue;
        gap = near.distance;
        landing = near.at.clone();
      }
      let toward: string | undefined;
      if (landing && owners) {
        let best = Infinity;
        for (const vertex of shells[0]) {
          const d = vertexAt(vertex).distanceToSquared(landing);
          if (d >= best) continue;
          best = d;
          const from = owners.paths[owners.index[vertex]];
          toward = from ? name(from.join('.')) : undefined;
        }
      }
      // `blend` closes a gap up to half its own width, so the blend that would
      // fuse this shell is twice the clearance — but only inside the range the
      // schema allows. Past that the parts have to move, not melt.
      const clearance = Number.isFinite(gap) ? round4(gap / scale) : null;
      const blend = clearance === null ? null : round4(clearance * 2);
      const hint: Hint = {
        ...(blend !== null && blend > 0 && blend <= 0.5 ? { grow: blend } : {}),
        ...(toward ? { toward } : {}),
      };
      findings.push({
        severity: 'error',
        code: 'detached-shell',
        part: path,
        value: shell.length,
        // How far the stray actually floats, in spec units. `grow` is the
        // blend that would close it; this is the thing being closed.
        ...(clearance === null ? {} : { threshold: clearance }),
        message: `The mesh falls into ${shells.length} separate shells; one of ${shell.length} vertices floats free of the body.${made} Raise the blend so the parts fuse, or move them into contact.`,
        ...(hint.grow !== undefined || hint.toward ? { hint } : {}),
      });
    }
  });

  // --- parts that produced no surface -----------------------------------
  // Colour and rig binding go to the nearest primitive per vertex, so a part
  // that is present but recessed inside its neighbour owns nothing: it costs
  // build time, it is in the spec, and it is invisible. Authors lose whole
  // iterations to this with no diagnostic, so name every such part.
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const owners = object.geometry.userData.surfaceOwners as
      | SurfaceOwners
      | undefined;
    if (!owners) return;
    const seen = new Uint8Array(owners.paths.length);
    for (let i = 0; i < owners.index.length; i++) seen[owners.index[i]] = 1;
    const missing = new Map<string, { path: number[]; copies: number }>();
    owners.paths.forEach((path, prim) => {
      // A subtractor that owns no vertex cut nothing that shows — a niche
      // sunk too far into a wall, a bore that missed. That is a note about the
      // cut, not a part left invisible, and telling an author to "make it
      // proud of its neighbour" would be exactly the wrong advice.
      if (owners.subtract?.[prim]) return;
      if (seen[prim] || !path) return;
      const key = path.join('.');
      const entry = missing.get(key) ?? { path, copies: 0 };
      entry.copies++;
      missing.set(key, entry);
    });
    const spec = model.userData.spec as AssetSpec | undefined;
    // A grid cell, in world units: `sampleGrid` steps the longest axis of the
    // model by `detail`, and a part has to clear one of those to own a vertex.
    const voxel = spec?.surface
      ? Math.max(size.x, size.y, size.z) / Math.max(8, spec.surface.detail)
      : 0;
    const hints = spec && missing.size
      ? burialHints(
          object,
          [...missing.values()].map((entry) => entry.path),
          spec,
          scale,
          voxel,
          name,
        )
      : new Map<string, Hint>();
    for (const { path, copies } of missing.values()) {
      const hint = hints.get(path.join('.'));
      findings.push({
        severity: 'warn',
        code: 'no-surface',
        part: path,
        value: copies,
        message: `${copies > 1 ? `${copies} copies of ` : ''}"${name(path.join('.'))}" own no surface: every vertex nearby belongs to a neighbour, so the part is invisible. Make it proud of its neighbour by at least a grid cell, or remove it.`,
        ...(hint && (hint.move || hint.toward) ? { hint } : {}),
      });
    }
  });

  // --- cuts that were never made ----------------------------------------
  // `subtract` is a field-mode instruction: it carves the blended surface.
  // The faceted builder has no CSG to carve with, so it builds the part as the
  // plain solid it was authored as — which puts a window-shaped block where the
  // window should be. Nothing about the geometry says that went wrong, so the
  // spec has to.
  const unfielded = new Map<string, { path?: number[]; copies: number }>();
  const uncut = new Map<string, { path?: number[]; copies: number }>();
  model.traverse((object) => {
    if (!(object instanceof T.Mesh) || object.userData.surface) return;
    const prim = object.userData.prim as
      | { subtract?: boolean; shape?: string }
      | undefined;
    if (prim?.shape === 'field' || (prim as { wrap?: unknown } | undefined)?.wrap) {
      const path = object.userData.specPath as number[] | undefined;
      const key = path ? path.join('.') : object.name;
      const entry = unfielded.get(key) ?? { path, copies: 0 };
      entry.copies++;
      unfielded.set(key, entry);
    }
    if (!prim?.subtract) return;
    const path = object.userData.specPath as number[] | undefined;
    const key = path ? path.join('.') : object.name;
    const entry = uncut.get(key) ?? { path, copies: 0 };
    entry.copies++;
    uncut.set(key, entry);
  });
  for (const [key, { path, copies }] of uncut)
    findings.push({
      severity: 'warn',
      code: 'subtract-needs-surface',
      ...(path ? { part: path } : {}),
      value: copies,
      message: `"${name(key)}" asks to be subtracted, but this asset is built from stacked solids, so it was added as one instead of cut away${copies > 1 ? ` (${copies} copies)` : ''}. Give the spec a surface block to get the cut, or drop the subtract flag.`,
    });
  for (const [key, { path, copies }] of unfielded)
    findings.push({
      severity: 'warn',
      code: 'field-needs-surface',
      ...(path ? { part: path } : {}),
      value: copies,
      message: `"${name(key)}" is a field or wrapped part, and the faceted builder has no field to mesh or wrap, so it drew the plain shape${copies > 1 ? ` (${copies} copies)` : ''}. Give the spec a surface block to build it.`,
    });

  // --- rig weighting ----------------------------------------------------
  if (options.rigged) {
    const [low, high] = AUTO_WEIGHT.designedFor;
    const rigHeight = size.y / scale;
    const { samples, unit } = rigSamples(model, scale);
    const unpinned = samples.filter((s) => !s.rigPart);
    const share = unpinned.length / Math.max(1, samples.length);
    const many = unit === 'vertex'
      ? `${Math.round(share * 100)}% of the surface`
      : `${unpinned.length} unpinned mesh${unpinned.length === 1 ? '' : 'es'}`;
    if (rigHeight < low || rigHeight > high) {
      if (unpinned.length)
        findings.push({
          severity: 'error',
          code: 'rig-scale',
          value: Number(rigHeight.toFixed(2)),
          message: `Automatic skin weighting uses fixed height bands tuned for ${low}–${high} m, but this model is ${rigHeight.toFixed(2)} m tall before its display scale, so ${many} will bind to the wrong bone. Set rigPart on every part, or build at ${low}–${high} m and use the spec's scale field for the final size.`,
        });
      else
        findings.push({
          severity: 'info',
          code: 'rig-scale-pinned',
          message: `Model is ${rigHeight.toFixed(2)} m tall before scale, outside the automatic weighting range, but every part pins its own bone.`,
        });
    }

    // Decorations legitimately ride the head — horns, antennae, a crest — so
    // counting parts would flag correct work. What actually goes wrong is a
    // torso caught in the head band, and that shows up as head-bound geometry
    // reaching far down the body.
    const headBound = unpinned.filter(
      (s) => autoBone({ x: s.x, y: s.y }) === 'Head',
    );
    if (headBound.length) {
      let top = -Infinity;
      let bottom = Infinity;
      for (const s of headBound) {
        top = Math.max(top, s.maxY);
        bottom = Math.min(bottom, s.minY);
      }
      const reach = ((top - bottom) * scale) / Math.max(size.y, 1e-6);
      if (reach > 0.4)
        findings.push({
          severity: 'error',
          code: 'rig-head-heavy',
          value: Number(reach.toFixed(2)),
          threshold: 0.4,
          message: `Geometry bound to the head bone spans ${Math.round(reach * 100)}% of the model's height, so the body will swing with the head. Parts above ${AUTO_WEIGHT.head} m follow the head unless they set rigPart — pin the torso and limbs, or sit them lower.`,
        });
    }

    // Any geometry on a leg bone is enough, pinned or not; an explicit thigh_l
    // animates exactly as well as an automatic one.
    const legged = samples.some((s) =>
      s.rigPart
        ? s.rigPart.startsWith('thigh') ||
          s.rigPart.startsWith('shin') ||
          s.rigPart.startsWith('foot')
        : autoBone({ x: s.x, y: s.y }).startsWith('Thigh'),
    );
    if (!legged)
      findings.push({
        severity: 'warn',
        code: 'rig-no-legs',
        message: `Nothing binds to a leg bone, so the walk and jump clips will not move the lower body. Put geometry below ${AUTO_WEIGHT.legs} m or set rigPart to a thigh, shin or foot.`,
      });
  }

  // --- shape ------------------------------------------------------------
  const flat = size.y / Math.max(size.x, size.z);
  findings.push({
    severity: 'info',
    code: 'proportions',
    value: Number(flat.toFixed(2)),
    message: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m, height-to-width ${flat.toFixed(2)}${flat < 0.5 ? ' — reads flat from the side' : ''}.`,
  });

  // Pixels, on request. Everything it reports is a warning or a note, so `ok`
  // still means what it meant: the geometry is sound.
  if (options.visual)
    findings.push(
      ...auditVisual(model, model.userData.spec as AssetSpec | undefined, {
        labels: options.labels,
        ...(options.visual === true ? {} : options.visual),
      }).findings,
    );

  if (solid !== model) disposeScene(solid);
  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/**
 * Note on surface mode: `detached-shell` is the stronger of the two
 * connectivity checks. Mesh-to-mesh contact has to pick a tolerance and can
 * only ever answer "close enough"; shell topology answers exactly, because two
 * parts either share triangles or they do not.
 *
 * Deliberately absent: a "this part is buried inside another" check. Eyes sit
 * inside heads, cores inside torsos, pegs inside sockets — containment flags
 * correct work far more often than mistakes, and a report that has to be
 * ignored is worse than no report at all.
 */
