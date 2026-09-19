import * as T from 'three';

/**
 * The placement maths behind `rest` and `repeat.mode: "along"`.
 *
 * Both answer the same question the audit keeps asking authors: where does
 * this part actually go? An author writing a scute onto a back guesses a
 * height, builds, reads "sits in mid-air", nudges, and builds again. The two
 * routines here replace that loop with geometry — one finds the contact by
 * sweeping the real triangles, the other rides a part's own spine — and they
 * live apart from the builder so both can be measured without building a
 * model.
 *
 * Everything is world-space and free of randomness: the same inputs give the
 * same answer to the last bit, which is what lets a spec be rebuilt and still
 * export byte for byte.
 */

/** Nine floats per triangle: three vertices, already in world space. */
export type Triangles = Float64Array;

/**
 * A mesh's triangles in world space.
 *
 * Doubles rather than the float32 the buffer holds, because contact is
 * measured as a difference between two surfaces a few millimetres apart and
 * float32 carries about seven digits — enough to make a 1 mm answer on a 10 m
 * model wobble in its last place.
 */
export function worldTriangles(mesh: T.Mesh): Triangles {
  const position = mesh.geometry.attributes.position as T.BufferAttribute;
  const index = mesh.geometry.index;
  const count = index ? index.count : position.count;
  const out = new Float64Array(count * 3);
  const point = new T.Vector3();
  for (let i = 0; i < count; i++) {
    point
      .fromBufferAttribute(position, index ? index.getX(i) : i)
      .applyMatrix4(mesh.matrixWorld);
    out[i * 3] = point.x;
    out[i * 3 + 1] = point.y;
    out[i * 3 + 2] = point.z;
  }
  return out;
}

/** World directions a `rest` travels along, by the side it falls from. */
export const REST_STEPS = {
  above: [0, -1, 0],
  below: [0, 1, 0],
  '+x': [-1, 0, 0],
  '-x': [1, 0, 0],
  '+z': [0, 0, -1],
  '-z': [0, 0, 1],
} as const satisfies Record<string, readonly [number, number, number]>;

export type RestFrom = keyof typeof REST_STEPS;

/**
 * Could a part inside `box` ever meet `other` while sliding along `axis`?
 *
 * The travel is unbounded, so the only thing that can rule a target out is
 * missing the moving part sideways. Rejecting on that alone, before any
 * triangle is read, is what keeps `on: "any"` from costing the whole model.
 */
export function inSweep(box: T.Box3, other: T.Box3, axis: 0 | 1 | 2) {
  const min = [box.min.x, box.min.y, box.min.z];
  const max = [box.max.x, box.max.y, box.max.z];
  const otherMin = [other.min.x, other.min.y, other.min.z];
  const otherMax = [other.max.x, other.max.y, other.max.z];
  for (let a = 0; a < 3; a++) {
    if (a === axis) continue;
    if (min[a] > otherMax[a] || otherMin[a] > max[a]) return false;
  }
  return true;
}

/**
 * Triangles flattened onto the plane the travel is perpendicular to.
 *
 * Every ray in the sweep runs along the same direction, so a ray against a
 * triangle collapses to a point-in-triangle test in two dimensions plus one
 * interpolation — no ray-triangle routine, no tolerance to tune, and a hit
 * exactly on a shared vertex is reported by every triangle that owns it
 * rather than by none of them, which is how the pole of a sphere gets found.
 */
type Slab = {
  /** Per triangle: u,v,c per vertex, then the 2D bounds. See `STRIDE`. */
  data: Float64Array;
  count: number;
  /** umin, vmin, umax, vmax over every triangle. */
  rect: [number, number, number, number];
};

const STRIDE = 13;

function project(
  tris: Triangles,
  e1: T.Vector3,
  e2: T.Vector3,
  step: T.Vector3,
): Slab {
  const count = Math.floor(tris.length / 9);
  const data = new Float64Array(count * STRIDE);
  const rect: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (let t = 0; t < count; t++) {
    const at = t * STRIDE;
    let umin = Infinity,
      vmin = Infinity,
      umax = -Infinity,
      vmax = -Infinity;
    for (let i = 0; i < 3; i++) {
      const x = tris[t * 9 + i * 3];
      const y = tris[t * 9 + i * 3 + 1];
      const z = tris[t * 9 + i * 3 + 2];
      const u = x * e1.x + y * e1.y + z * e1.z;
      const v = x * e2.x + y * e2.y + z * e2.z;
      data[at + i * 3] = u;
      data[at + i * 3 + 1] = v;
      data[at + i * 3 + 2] = x * step.x + y * step.y + z * step.z;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    data[at + 9] = umin;
    data[at + 10] = vmin;
    data[at + 11] = umax;
    data[at + 12] = vmax;
    if (umin < rect[0]) rect[0] = umin;
    if (vmin < rect[1]) rect[1] = vmin;
    if (umax > rect[2]) rect[2] = umax;
    if (vmax > rect[3]) rect[3] = vmax;
  }
  return { data, count, rect };
}

/** The same slab with every triangle that cannot reach `rect` dropped. */
function restrict(slab: Slab, rect: readonly number[]): Slab {
  const keep: number[] = [];
  for (let t = 0; t < slab.count; t++) {
    const at = t * STRIDE;
    if (
      slab.data[at + 9] > rect[2] ||
      slab.data[at + 11] < rect[0] ||
      slab.data[at + 10] > rect[3] ||
      slab.data[at + 12] < rect[1]
    )
      continue;
    keep.push(at);
  }
  const data = new Float64Array(keep.length * STRIDE);
  keep.forEach((at, i) =>
    data.set(slab.data.subarray(at, at + STRIDE), i * STRIDE),
  );
  return { data, count: keep.length, rect: slab.rect };
}

/**
 * Where a line through (u, v) crosses this slab's triangles, appended to
 * `out` as coordinates along the travel direction.
 *
 * The barycentric test admits the boundary, so a line through an edge or a
 * vertex is a hit on both sides of it. Double-counting there is harmless: the
 * caller reads a minimum, a maximum, or a sorted list of pairs, and a
 * duplicated crossing changes none of the three.
 */
function crossings(slab: Slab, u: number, v: number, out: number[]) {
  const data = slab.data;
  for (let t = 0; t < slab.count; t++) {
    const at = t * STRIDE;
    if (
      u < data[at + 9] ||
      u > data[at + 11] ||
      v < data[at + 10] ||
      v > data[at + 12]
    )
      continue;
    const u0 = data[at],
      v0 = data[at + 1],
      c0 = data[at + 2];
    const u1 = data[at + 3],
      v1 = data[at + 4],
      c1 = data[at + 5];
    const u2 = data[at + 6],
      v2 = data[at + 7],
      c2 = data[at + 8];
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    // Edge-on triangles project to a line and carry no area to land in. The
    // faces either side of them cover the same ground.
    if (det > -1e-18 && det < 1e-18) continue;
    const b1 = ((u - u0) * (v2 - v0) - (u2 - u0) * (v - v0)) / det;
    const b2 = ((u1 - u0) * (v - v0) - (u - u0) * (v1 - v0)) / det;
    const b0 = 1 - b1 - b2;
    if (b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9) continue;
    out.push(b0 * c0 + b1 * c1 + b2 * c2);
  }
}

/** Lines through a slab's own vertices that fall inside `rect`, capped. */
function vertexLines(
  slab: Slab,
  rect: readonly number[],
  cap: number,
  out: number[],
) {
  const found: number[] = [];
  for (let t = 0; t < slab.count; t++)
    for (let i = 0; i < 3; i++) {
      const u = slab.data[t * STRIDE + i * 3];
      const v = slab.data[t * STRIDE + i * 3 + 1];
      if (u < rect[0] || u > rect[2] || v < rect[1] || v > rect[3]) continue;
      found.push(u, v);
    }
  const points = found.length / 2;
  const step = Math.max(1, Math.ceil(points / cap));
  for (let i = 0; i < points; i += step) out.push(found[i * 2], found[i * 2 + 1]);
}

/** Sample lines per side, and per axis of the grid. */
const VERTEX_LINES = 64;
const GRID = 9;

/**
 * How far this part has to travel along `direction` to touch those ones.
 *
 * Positive means it moves forward into contact; negative means it starts
 * overlapping and backs out until it is tangent. Both come out of one rule,
 * which is the point: a row of copies laid over a lumpy body straddles the
 * surface here and floats there, and `sink` can only mean the same thing for
 * every copy if the search answers on one scale.
 *
 * Along each sample line the moving part occupies [entry, exit] and each
 * target contributes the solid spans its own surface encloses. A span that
 * ends before the mover begins is behind it — a roof over a crate the crate
 * is not falling onto — and is dropped. Every other span offers its near face
 * as a landing, and the smallest offer over every line wins, so the part ends
 * clear of all of them rather than merely clear of the first.
 *
 * `null` when no line reaches a target at all: nothing is under the part, and
 * the caller is expected to say so by name rather than leave it hanging.
 */
export function contactTravel(
  mover: Triangles,
  targets: Triangles[],
  direction: T.Vector3,
): number | null {
  const step = direction.clone().normalize();
  // Any pair perpendicular to the travel will do; the answer is a distance
  // along `step` and cannot depend on how the other two axes are named.
  const e1 = new T.Vector3(1, 0, 0);
  if (Math.abs(step.x) > 0.9) e1.set(0, 1, 0);
  e1.crossVectors(step, e1).normalize();
  const e2 = new T.Vector3().crossVectors(step, e1).normalize();

  const moving = project(mover, e1, e2, step);
  if (!moving.count) return null;
  const slabs: Slab[] = [];
  const rect: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const target of targets) {
    const slab = project(target, e1, e2, step);
    if (!slab.count) continue;
    // Only the ground the two share can ever be touched, so the sweep is
    // planned over the overlap and both sides are cut down to it.
    if (
      slab.rect[0] > moving.rect[2] ||
      slab.rect[2] < moving.rect[0] ||
      slab.rect[1] > moving.rect[3] ||
      slab.rect[3] < moving.rect[1]
    )
      continue;
    slabs.push(slab);
    rect[0] = Math.min(rect[0], Math.max(slab.rect[0], moving.rect[0]));
    rect[1] = Math.min(rect[1], Math.max(slab.rect[1], moving.rect[1]));
    rect[2] = Math.max(rect[2], Math.min(slab.rect[2], moving.rect[2]));
    rect[3] = Math.max(rect[3], Math.min(slab.rect[3], moving.rect[3]));
  }
  if (!slabs.length || rect[0] > rect[2] || rect[1] > rect[3]) return null;

  const near = restrict(moving, rect);
  const solids = slabs.map((slab) => restrict(slab, rect));
  if (!near.count || !solids.some((slab) => slab.count)) return null;

  const lines: number[] = [];
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++)
      lines.push(
        rect[0] + ((rect[2] - rect[0]) * i) / (GRID - 1),
        rect[1] + ((rect[3] - rect[1]) * j) / (GRID - 1),
      );
  // A grid alone lands between the features it is looking for: the pole of a
  // sphere, the corner of a step. Adding each side's own vertices puts a line
  // exactly where the two surfaces are most likely to meet first.
  vertexLines(near, rect, VERTEX_LINES, lines);
  for (const slab of solids) vertexLines(slab, rect, VERTEX_LINES, lines);

  let best = Infinity;
  const mine: number[] = [];
  const theirs: number[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const u = lines[i];
    const v = lines[i + 1];
    mine.length = 0;
    crossings(near, u, v, mine);
    if (!mine.length) continue;
    let entry = Infinity;
    let exit = -Infinity;
    for (const c of mine) {
      if (c < entry) entry = c;
      if (c > exit) exit = c;
    }
    for (const slab of solids) {
      theirs.length = 0;
      crossings(slab, u, v, theirs);
      if (!theirs.length) continue;
      theirs.sort((a, b) => a - b);
      // Pairs, because each target is a closed surface: a line goes in at one
      // crossing and out at the next. An odd tail is a graze along an edge,
      // and a zero-thickness span is the honest reading of it.
      for (let p = 0; p < theirs.length; p += 2) {
        const low = theirs[p];
        const high = p + 1 < theirs.length ? theirs[p + 1] : low;
        if (high < entry) continue;
        const travel = low - exit;
        if (travel < best) best = travel;
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** The fields a spine can be read from — a part's authored shape, in effect. */
export type PathPrim = {
  shape: string;
  size?: readonly number[];
  from?: readonly number[];
  to?: readonly number[];
  via?: readonly number[];
  radius?: number;
  taper?: number;
};

/**
 * A line through a part with a surface around it, in world space.
 *
 * `u` is a fraction of arc length rather than of the curve's own parameter,
 * so ten copies along a bent tail are ten equal steps of tail and not ten
 * equal steps of algebra, which bunch up wherever the bend is tightest.
 */
export type PathSpine = {
  point(u: number): T.Vector3;
  /** Unit tangent, pointing from the start of the spine towards its end. */
  tangent(u: number): T.Vector3;
  /** Centreline to surface at `u`, in the world direction `dir`. */
  offset(u: number, dir: T.Vector3): number;
};

/**
 * The spine of a built part.
 *
 * A limb already is a spine: the curve its tube was swept along, with the
 * radius it was swept at, tapered the same way the geometry tapers. Anything
 * else is read as its longest axis through its own centre, with the surface
 * taken at the half-extent facing the side the copies sit on — a box's
 * silhouette is its box, so that line is exact for the shape the row is most
 * often laid along.
 *
 * `matrix` is assumed rigid, which is what a spec's holders carry: the model's
 * own scale is applied after every part is placed.
 */
export function spineOf(prim: PathPrim, matrix: T.Matrix4): PathSpine {
  const basis = new T.Matrix3().setFromMatrix4(matrix);
  if (prim.shape === 'limb') {
    const from = new T.Vector3(...(prim.from ?? [0, 0, 0]));
    const to = new T.Vector3(...(prim.to ?? [0, 1, 0]));
    const curve: T.Curve<T.Vector3> = prim.via
      ? new T.QuadraticBezierCurve3(from, new T.Vector3(...prim.via), to)
      : new T.LineCurve3(from, to);
    const radius = prim.radius ?? 0.1;
    const taper = prim.taper ?? 1;
    return {
      point: (u) => curve.getPointAt(u).applyMatrix4(matrix),
      tangent: (u) => curve.getTangentAt(u).applyMatrix3(basis).normalize(),
      // The tube's radius runs on the curve's own parameter, not on arc
      // length — `curvedLimbGeometry` steps it that way — so the surface a
      // copy sits on has to be read back through the same mapping. The zero
      // is three's "no explicit distance"; it reads the argument for truth.
      offset: (u) => radius * (1 + (taper - 1) * curve.getUtoTmapping(u, 0)),
    };
  }
  const size = prim.size ?? [1, 1, 1];
  // Shapes built round an axis are read along it: a capsule laid along a body
  // with `rotation: [90,0,0]` is still a capsule along its own Y, and a row on
  // it should follow the body, not stand up through it. Everything else is
  // read along whichever way it is longest.
  const swept = ['capsule', 'cylinder', 'cone', 'prism', 'lathe'].includes(prim.shape);
  let axis = swept ? 1 : 0;
  if (!swept) for (let a = 1; a < 3; a++) if (size[a] > size[axis]) axis = a;
  const half = [size[0] / 2, size[1] / 2, size[2] / 2];
  const along = new T.Vector3();
  along.setComponent(axis, 1);
  const start = along.clone().multiplyScalar(-half[axis]);
  const end = along.clone().multiplyScalar(half[axis]);
  const local = new T.Matrix3().copy(basis).invert();
  return {
    point: (u) => start.clone().lerp(end, u).applyMatrix4(matrix),
    tangent: () => along.clone().applyMatrix3(basis).normalize(),
    offset: (_u, dir) => {
      // The box's support in that direction: for the axis directions a row
      // actually uses this is the half-extent, and for anything between them
      // it is the corner the direction points at.
      const d = dir.clone().applyMatrix3(local);
      return half[0] * Math.abs(d.x) + half[1] * Math.abs(d.y) + half[2] * Math.abs(d.z);
    },
  };
}

/** Named sides, as degrees turned about the tangent from straight up. */
const SIDES = { up: 0, right: 90, down: 180, left: 270 } as const;

export type Side = keyof typeof SIDES | number;

export function sideDegrees(side: Side) {
  return typeof side === 'number' ? side : SIDES[side];
}

export type AlongPlacement = {
  /** Fraction of arc length this copy sits at. */
  at: number;
  position: T.Vector3;
  /** +y along the outward normal, +z along the tangent. */
  quaternion: T.Quaternion;
  normal: T.Vector3;
  tangent: T.Vector3;
};

const UP = new T.Vector3(0, 1, 0);
const FORWARD = new T.Vector3(0, 0, 1);

/**
 * Copies spaced evenly along a spine and turned to face off it.
 *
 * "Up" is the world's up, leant back until it is square to the tangent, so a
 * row down a drooping tail stays on top of the tail rather than tipping with
 * it — and so an author who writes `up` gets the side they can see. Numbers
 * turn from there about the tangent, which is what puts a row of rivets a
 * third of the way round a pipe.
 */
export function placeAlong(
  spine: PathSpine,
  count: number,
  span: readonly [number, number],
  side: Side,
): AlongPlacement[] {
  const angle = T.MathUtils.degToRad(sideDegrees(side));
  const out: AlongPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const at = count === 1 ? span[0] : span[0] + ((span[1] - span[0]) * i) / (count - 1);
    const tangent = spine.tangent(at);
    // Straight up has no component square to a vertical spine, so a row up a
    // mast takes its reference from the other axis instead.
    const reference = Math.abs(tangent.dot(UP)) > 0.999 ? FORWARD : UP;
    const normal = reference
      .clone()
      .addScaledVector(tangent, -reference.dot(tangent))
      .normalize()
      .applyAxisAngle(tangent, angle);
    const position = spine
      .point(at)
      .addScaledVector(normal, spine.offset(at, normal));
    const across = new T.Vector3().crossVectors(normal, tangent);
    out.push({
      at,
      position,
      quaternion: new T.Quaternion().setFromRotationMatrix(
        new T.Matrix4().makeBasis(across, normal, tangent),
      ),
      normal,
      tangent,
    });
  }
  return out;
}
