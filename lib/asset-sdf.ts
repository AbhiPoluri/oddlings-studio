import * as T from 'three';
import type { Part, Shape } from './asset-spec';
import { buildMeshField, type MeshField } from './asset-mesh-sdf';

/**
 * Signed distance functions for the spec's primitives.
 *
 * Every canonical shape here is written to fill a known extent, and the caller
 * divides the query point by `size / extent` before evaluating. That is what
 * makes `size` mean the same thing in surface mode as it does in the faceted
 * builder: both end up occupying exactly the declared bounding box.
 *
 * Distances are Lipschitz — never larger than the true distance — because the
 * blend and the marching grid both assume a step of `d` cannot overshoot the
 * surface.
 */

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function length2(x: number, y: number) {
  return Math.hypot(x, y);
}

/** Canonical extent of each shape before it is fitted to `size`. */
export function canonicalExtent(shape: Shape): [number, number, number] {
  // Only shapes whose proportions are locked by their own definition need a
  // non-cube extent. A torus is 1 x 1 x 0.3, so squashing it into a cube would
  // make the tube three times fatter than the faceted builder draws it, and a
  // capsule stands 1.5 tall against a width of 1.
  //
  // `lathe` and `extrude` stay cubic on purpose: their proportions come from a
  // profile the author supplies, and both backends normalise that profile into
  // the unit box before anything else happens, so the extent is fixed even
  // though the silhouette is not.
  if (shape === 'torus') return [1, 1, 0.3];
  if (shape === 'capsule') return [1, 1.5, 1];
  return [1, 1, 1];
}

/**
 * The profile a `lathe` falls back to: a straight wall, so a lathe with no
 * profile is a plain cylinder. Every shape has to build from `{ shape, size }`
 * alone — that is what the editor hands a part the moment its shape changes,
 * and what both shape sweeps in the tests construct.
 */
export const DEFAULT_LATHE_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.5, -0.5],
  [0.5, 0.5],
];

/** And an `extrude` with no profile is a plain box. */
export const DEFAULT_EXTRUDE_PROFILE: ReadonlyArray<readonly [number, number]> =
  [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];

/** Twice the signed area of a 2D polygon. Positive is counter-clockwise. */
export function signedArea(points: ReadonlyArray<readonly number[]>) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return sum;
}

/**
 * A lathe profile as a closed polygon in the (radius, height) half-plane.
 *
 * The revolved solid is bounded by the profile on the outside and by the axis
 * on the inside, so closing the profile with a point on the axis at each end is
 * what turns an open curve into a solid. Both backends call this: the faceted
 * builder revolves the closed ring list — which makes the end caps fall out of
 * the same quad loop as the walls, with no special case — and the field
 * measures distance to the same polygon. Anything else and the two disagree
 * about where the ends of a vase are.
 *
 * The result is wound counter-clockwise, so a profile authored top-down comes
 * out solid rather than inside-out.
 */
export function closeProfile(profile: ReadonlyArray<readonly number[]>) {
  const points: [number, number][] = profile.map((p) => [
    Math.max(0, p[0]),
    p[1],
  ]);
  const first = points[0];
  const last = points[points.length - 1];
  if (last[0] > 1e-9) points.push([0, last[1]]);
  if (first[0] > 1e-9) points.unshift([0, first[1]]);
  if (signedArea(points) < 0) points.reverse();
  return points;
}

/** Profile bounds, as [minX, minY, maxX, maxY]. */
export function profileBounds(profile: ReadonlyArray<readonly number[]>) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of profile) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY] as const;
}

function sdSphere(x: number, y: number, z: number, r: number) {
  return Math.hypot(x, y, z) - r;
}

function sdBox(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
) {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  const outside = Math.hypot(
    Math.max(qx, 0),
    Math.max(qy, 0),
    Math.max(qz, 0),
  );
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

function sdOctahedron(x: number, y: number, z: number, s: number) {
  const m = Math.abs(x) + Math.abs(y) + Math.abs(z) - s;
  return m * 0.57735026919;
}

/**
 * Regular tetrahedron inscribed in the unit cube, as four half-spaces.
 *
 * `TetrahedronGeometry` uses the (1,1,1) (1,-1,-1) (-1,1,-1) (-1,-1,1) vertex
 * set, so the faces are the planes through the opposite four corners.
 */
function sdTetrahedron(x: number, y: number, z: number, s: number) {
  const k = 0.57735026919;
  const offset = s * k;
  const planes = [
    [-k, -k, k],
    [-k, k, -k],
    [k, -k, -k],
    [k, k, k],
  ];
  let d = -Infinity;
  for (const [nx, ny, nz] of planes)
    d = Math.max(d, x * nx + y * ny + z * nz - offset);
  return d;
}

/** Cone frustum along Y: radius `rBottom` at -h, `rTop` at +h. */
function sdFrustum(
  x: number,
  y: number,
  z: number,
  rBottom: number,
  rTop: number,
  h: number,
) {
  const q = length2(x, z);
  // Distance to the slanted side, measured in the (radius, height) plane.
  const kx = rTop - rBottom;
  const ky = 2 * h;
  const cax = q - Math.min(q, y < 0 ? rBottom : rTop);
  const cay = Math.abs(y) - h;
  const t = clamp(
    ((rTop - q) * kx + (h - y) * ky) / (kx * kx + ky * ky),
    0,
    1,
  );
  const cbx = q - rTop + kx * t;
  const cby = y - h + ky * t;
  const inside = cbx < 0 && cay < 0 ? -1 : 1;
  return (
    inside * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby))
  );
}

/** Capsule along Y with hemispherical caps: segment half-length `h`, radius `r`. */
function sdCapsuleY(x: number, y: number, z: number, h: number, r: number) {
  const yy = y - clamp(y, -h, h);
  return Math.hypot(x, yy, z) - r;
}

/** Torus lying in the XY plane, tube wrapped around the Z axis. */
function sdTorus(
  x: number,
  y: number,
  z: number,
  major: number,
  tube: number,
) {
  return Math.hypot(length2(x, y) - major, z) - tube;
}

/**
 * Tapered capsule between two points — the surface-mode form of `limb`.
 *
 * Unlike the other shapes this one is evaluated directly in the space its
 * endpoints were authored in, because a limb is defined by `from` and `to`
 * rather than by a bounding box.
 */
export function sdRoundCone(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r1: number,
  r2: number,
) {
  const dx = bx - ax,
    dy = by - ay,
    dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-12) return Math.hypot(px - ax, py - ay, pz - az) - r1;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;

  const pax = px - ax,
    pay = py - ay,
    paz = pz - az;
  const y = pax * dx + pay * dy + paz * dz;
  const z = y - l2;
  const xx = pax * l2 - dx * y;
  const xy = pay * l2 - dy * y;
  const xz = paz * l2 - dz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;

  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

/**
 * A quadratic bezier tube: the curved form of `limb`.
 *
 * The union of round cones along a subdivision of the curve. A closed-form
 * distance to a bezier exists but needs a cubic root per query and is worse
 * conditioned than the curve is smooth; sampling instead is exact for each cone
 * and never overestimates, which is all the marcher needs. Sixteen cones keeps
 * the largest chord error under a thousandth of the curve's own length.
 */
function sdBezierTube(
  px: number,
  py: number,
  pz: number,
  s: number[],
  r1: number,
  r2: number,
) {
  const steps = 16;
  let d = Infinity;
  let ax = s[0],
    ay = s[1],
    az = s[2];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // (1-t)^2 A + 2(1-t)t V + t^2 B
    const bx = u * u * s[0] + 2 * u * t * s[3] + t * t * s[6];
    const by = u * u * s[1] + 2 * u * t * s[4] + t * t * s[7];
    const bz = u * u * s[2] + 2 * u * t * s[5] + t * t * s[8];
    const ra = r1 + (r2 - r1) * ((i - 1) / steps);
    const rb = r1 + (r2 - r1) * t;
    const di = sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, ra, rb);
    if (di < d) d = di;
    ax = bx;
    ay = by;
    az = bz;
  }
  return d;
}

/**
 * Signed distance from a point to a closed 2D polygon, negative inside.
 *
 * Reads the polygon out of a flat args array rather than an array of points,
 * because this runs once per primitive per grid sample — a few million times
 * for a detailed asset — and allocating a Vector2 per edge there is the
 * difference between a build that takes a second and one that takes a minute.
 *
 * Concave contours are fine. The sign comes from a crossing count rather than
 * from the winding, so a polygon authored clockwise gives the same answer.
 */
function sdPolygon(
  v: number[],
  start: number,
  n: number,
  px: number,
  py: number,
  /**
   * Ignore edges lying on x = 0 when measuring, while still counting them as
   * crossings. A lathe's profile is closed along the axis, and that closing
   * edge is not a surface: revolving it sweeps out a line, so a point sitting
   * on the axis is deep inside the solid rather than on its skin. Measuring to
   * it would report every point up the middle of a vase as exactly on the
   * surface, and the marcher would carve a needle-thin hole through it.
   */
  skipAxis = false,
) {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ix = v[start + i * 2],
      iy = v[start + i * 2 + 1];
    const jx = v[start + j * 2],
      jy = v[start + j * 2 + 1];
    const ex = jx - ix,
      ey = jy - iy;
    const wx = px - ix,
      wy = py - iy;
    if (!skipAxis || ix > 1e-9 || jx > 1e-9) {
      const ee = ex * ex + ey * ey;
      const t = ee > 1e-18 ? clamp((wx * ex + wy * ey) / ee, 0, 1) : 0;
      const bx = wx - ex * t,
        by = wy - ey * t;
      const dd = bx * bx + by * by;
      if (dd < best) best = dd;
    }
    const c1 = py >= iy;
    const c2 = py < jy;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) inside = !inside;
  }
  return inside ? -Math.sqrt(best) : Math.sqrt(best);
}

/**
 * A profile revolved about Y, in canonical space.
 *
 * Exact: for a point at radius q the nearest surface point lies in the same
 * meridian half-plane, so the 3D distance is the 2D distance from (q, y) to the
 * closed profile. Evaluated canonically rather than in metres because the
 * revolve is only circular there — a part whose x and z differ is an ellipse in
 * metres, and the caller's `lipschitz` factor is what keeps that conservative.
 */
function sdLathe(a: number[], x: number, y: number, z: number) {
  return sdPolygon(a, 1, a[0], length2(x, z), y, true);
}

/**
 * A polygon swept along Z, optionally scaled towards one end.
 *
 * Evaluated in metres, not canonically: an arbitrary polygon has no symmetry to
 * protect, so storing it at its final size keeps the taper, the slab and the
 * bevel all measured in the same units the author wrote them in — and makes the
 * result an exact distance rather than a conservative one.
 *
 * Args are [count, taper, bevel, halfDepth, slopeDivisor, x, y, x, y, ...].
 */
function sdExtrude(a: number[], x: number, y: number, z: number) {
  const n = a[0];
  const taper = a[1];
  const bevel = a[2];
  const hz = a[3];
  // Outside the slab the nearest cross-section is the end cap's, so the scale
  // is clamped rather than extrapolated — otherwise a point below the base
  // measures against a cross-section that does not exist.
  const u = clamp(z / (2 * hz) + 0.5, 0, 1);
  const k = Math.max(1e-4, 1 + (taper - 1) * u);
  // Scaling the polygon by k scales distances to it by k, so the query point is
  // divided instead of rebuilding the contour. The divisor corrects for the
  // wall's slope: measuring across the cross-section overshoots the true
  // perpendicular distance on a slanted wall, and an overshoot is the one error
  // the marcher cannot survive.
  const plane = (k * sdPolygon(a, 5, n, x / k, y / k)) / a[4];
  const wall = plane + bevel;
  const cap = Math.abs(z) - (hz - bevel);
  return (
    Math.min(Math.max(wall, cap), 0) +
    Math.hypot(Math.max(wall, 0), Math.max(cap, 0)) -
    bevel
  );
}

/**
 * A box with its edges rounded off by `r` metres.
 *
 * In metres, from the part's own local frame, so the radius is the same on
 * every edge however the part is stretched.
 *
 * The faceted builder cuts one flat facet across each edge where this rounds
 * it. The facet is the chord of this arc, so the two agree exactly along every
 * chamfer boundary and part company by at most r(1 - 1/sqrt2), about three
 * tenths of the bevel, in the middle of a facet. At any bevel worth authoring
 * that is a fraction of a voxel, and chasing it exactly would mean a field
 * with a crease in it — which is the one thing surface mode exists to avoid.
 */
function sdRoundBox(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  r: number,
) {
  const qx = Math.abs(x) - (hx - r);
  const qy = Math.abs(y) - (hy - r);
  const qz = Math.abs(z) - (hz - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
    Math.min(Math.max(qx, qy, qz), 0) -
    r
  );
}

/** One primitive reduced to a distance field, ready to blend with its siblings. */
export type Prim = {
  /** World -> local, so the canonical SDF can be evaluated in place. */
  inverse: T.Matrix4;
  /** Divide the local point by this before evaluating the canonical shape. */
  stretch: [number, number, number];
  /** Smallest stretch component: converts canonical distance back to metres. */
  lipschitz: number;
  shape: Shape;
  /** Half-extents / radii the canonical function needs. */
  args: number[];
  /** World-space endpoints for `limb`, which ignores `inverse`. */
  segment?: number[];
  box: T.Box3;
  /**
   * `box` grown by the blend's reach: the region this primitive can influence.
   *
   * Filled in by the sampler, which is the only thing that needs it, and kept
   * here rather than in a parallel array because the hierarchical walk hands
   * primitive lists down through several levels and would otherwise allocate a
   * wrapper per level per block.
   */
  padded?: T.Box3;
  color: T.Color;
  rigPart?: string;
  specPath?: number[];
  jitter: number;
  seed: number;
  /** The authored part's own modifiers, carried whole so the field can read them. */
  deform?: NonNullable<Part['deform']>;
  /**
   * `deform` resolved into a warp, or null when it does nothing.
   *
   * Filled in by the first query rather than by `primFor`, because resolving it
   * measures what the warp does to the part's extent — a few thousand points —
   * and a primitive the sampler culls on its bounding box is never asked.
   */
  warp?: Warp | null;
  /** Carve out of the field instead of adding to it (surface mode). */
  subtract?: boolean;
  material?: NonNullable<Part['material']>;
  /** A `field` part's own distance expression, and how fast it may change. */
  field?: string;
  fieldLipschitz?: number;
  /** A `paint` expression: the part's colour as code, per vertex. */
  paint?: string;
  /** Authored `wrap`, before its target names are resolved. */
  wrap?: NonNullable<Part['wrap']>;
  /**
   * `wrap` resolved: the primitives this one hugs. Filled in by the surface
   * builder once every primitive exists; a wrap with no targets is inert.
   */
  wrapTargets?: Prim[];
  /** A loft's built triangles, for the mesh-SDF path. */
  mesh?: T.BufferGeometry;
};

/** The descriptor `makeMesh` stashes so surface mode can rebuild the shape analytically. */
export type PrimSource = Pick<
  Part,
  | 'shape'
  | 'size'
  | 'taper'
  | 'jitter'
  | 'from'
  | 'to'
  | 'via'
  | 'radius'
  | 'profile'
  | 'bevel'
  | 'stations'
  | 'spine'
  | 'closed'
  | 'deform'
  | 'subtract'
  | 'material'
  | 'field'
  | 'lipschitz'
  | 'paint'
  | 'wrap'
>;


/**
 * The toolkit a `field` expression sees as `s`.
 *
 * Every function measures in the part's canonical unit box, the same frame the
 * built-in shapes are evaluated in: x, y and z run from -0.5 to 0.5 across the
 * declared `size`, and the number returned is a distance in that frame. The
 * primitives are the standard exact fields, `smin`/`smax` the polynomial blend
 * the union uses, `noise`/`fbm` the builder's own value noise so a displaced
 * field is reproducible from the seed, and `rep` folds space for repetition.
 */
export type FieldTools = ReturnType<typeof fieldTools>;
export function fieldTools(seed: number) {
  const length = (x: number, y: number, z = 0) => Math.hypot(x, y, z);
  const smin = (a: number, b: number, k: number) => {
    if (k <= 0) return Math.min(a, b);
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  };
  const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);
  const noise = (x: number, y: number, z: number) => noise3(x, y, z, seed);
  const fbm = (x: number, y: number, z: number, octaves = 4) => {
    let sum = 0,
      amp = 0.5,
      f = 1,
      norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise3(x * f, y * f, z * f, seed + i * 131);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  /** Fold a coordinate into a cell of `period`, centred, for domain repetition. */
  const rep = (v: number, period: number) => v - period * Math.round(v / period);
  return {
    length,
    smin,
    smax,
    noise,
    fbm,
    clamp,
    mix,
    rep,
    abs: Math.abs,
    sphere: (x: number, y: number, z: number, r: number) => length(x, y, z) - r,
    /** Box with half-extents hx, hy, hz. */
    box: (x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
      const qx = Math.abs(x) - hx,
        qy = Math.abs(y) - hy,
        qz = Math.abs(z) - hz;
      return (
        length(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
        Math.min(Math.max(qx, qy, qz), 0)
      );
    },
    /** Rounded box: half-extents and a corner radius. */
    rbox: (x: number, y: number, z: number, hx: number, hy: number, hz: number, r: number) => {
      const qx = Math.abs(x) - hx + r,
        qy = Math.abs(y) - hy + r,
        qz = Math.abs(z) - hz + r;
      return (
        length(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
        Math.min(Math.max(qx, qy, qz), 0) -
        r
      );
    },
    /** Cylinder along Y: radius r, half-height h. */
    cyl: (x: number, y: number, z: number, r: number, h: number) => {
      const dx = length(x, z) - r,
        dy = Math.abs(y) - h;
      return Math.min(Math.max(dx, dy), 0) + length(Math.max(dx, 0), Math.max(dy, 0));
    },
    /** Capsule along Y between -h and h with radius r. */
    capsule: (x: number, y: number, z: number, r: number, h: number) =>
      length(x, y - clamp(y, -h, h), z) - r,
    /** Torus in the XZ plane: ring radius R, tube radius r. */
    torus: (x: number, y: number, z: number, R: number, r: number) =>
      length(length(x, z) - R, y) - r,
    /** Cone along Y from a base of radius r at y=-h to a point at y=h. */
    cone: (x: number, y: number, z: number, r: number, h: number) => {
      const q = length(x, z);
      const t = clamp((y + h) / (2 * h), 0, 1);
      const rr = r * (1 - t);
      const dx = q - rr,
        dy = Math.abs(y) - h;
      return Math.min(Math.max(dx, dy), 0) + length(Math.max(dx, 0), Math.max(dy, 0));
    },
    /** Hollow out a field into a shell of the given thickness. */
    onion: (d: number, thickness: number) => Math.abs(d) - thickness,
  };
}

type FieldFn = (x: number, y: number, z: number, s: FieldTools, M: Math) => number;
const compiled = new Map<string, FieldFn>();

/** A field with no expression is a unit sphere, as a loft with no stations is a box. */
export const DEFAULT_FIELD = 's.sphere(x, y, z, 0.5)';

/**
 * Turn a `field` expression into a function, or explain why it cannot be one.
 *
 * The expression is JavaScript with `x`, `y`, `z`, the toolkit `s` and `M`
 * (Math) in scope. A bare expression is returned; a body with its own
 * `return` is run as written, so multi-line fields with local variables work.
 * Compiled once per distinct string and shared by every copy of the part.
 */
export function compileField(field: string): FieldFn {
  const cached = compiled.get(field);
  if (cached) return cached;
  const body = /\breturn\b/.test(field) ? field : `return (${field});`;
  let fn: FieldFn;
  try {
    fn = new Function('x', 'y', 'z', 's', 'M', body) as FieldFn;
  } catch (error) {
    throw Error(`"field" does not compile: ${(error as Error).message}`);
  }
  const tools = fieldTools(0);
  const probe = fn(0.1, 0.2, 0.3, tools, Math);
  if (typeof probe !== 'number' || !Number.isFinite(probe))
    throw Error('"field" must return a finite number; it returned ' + String(probe) + ' at (0.1, 0.2, 0.3).');
  compiled.set(field, fn);
  return fn;
}

const toolsBySeed = new Map<number, FieldTools>();
function fieldEval(prim: Prim, x: number, y: number, z: number) {
  const fn = compileField(prim.field ?? DEFAULT_FIELD);
  let tools = toolsBySeed.get(prim.seed);
  if (!tools) {
    tools = fieldTools(prim.seed);
    toolsBySeed.set(prim.seed, tools);
  }
  const d = fn(x, y, z, tools, Math);
  // A field that blows up somewhere is treated as empty there rather than
  // poisoning the whole grid with NaN.
  // The expression's own value, undivided. The declared `lipschitz` bound is
  // honoured where it matters — the block sampler widens its slack by it (see
  // `slope` in asset-surface) — rather than by shrinking every distance here,
  // which would make the smooth union treat the part as close over a region
  // `lipschitz` times too wide and inflate it, and would hand it its
  // neighbours' skin at paint time.
  return Number.isFinite(d) ? d : 1;
}

const scratch = new T.Vector3();

/** Distance from a world-space point to one primitive, in metres. */
export function distanceTo(prim: Prim, x: number, y: number, z: number) {
  if (prim.shape === 'limb') {
    const s = prim.segment as number[];
    // Nine numbers is a bezier's three control points; six is a straight limb.
    return s.length >= 9
      ? sdBezierTube(x, y, z, s, prim.args[0], prim.args[1])
      : sdRoundCone(
          x,
          y,
          z,
          s[0],
          s[1],
          s[2],
          s[3],
          s[4],
          s[5],
          prim.args[0],
          prim.args[1],
        );
  }
  scratch.set(x, y, z).applyMatrix4(prim.inverse);
  let lx = scratch.x / prim.stretch[0];
  let ly = scratch.y / prim.stretch[1];
  let lz = scratch.z / prim.stretch[2];
  // Local metres, which the two shapes measured there — a bevelled box and an
  // extrude — read instead of the canonical point.
  let mx = scratch.x;
  let my = scratch.y;
  let mz = scratch.z;
  // A bend, twist or taper is undone on the query point rather than applied to
  // the shape: there is no analytic field for a bent frustum, but there is one
  // for a straight frustum evaluated at the point the bend came from.
  const warp = warpOf(prim);
  if (warp) {
    local[0] = lx;
    local[1] = ly;
    local[2] = lz;
    undeformPoint(warp, local);
    lx = local[0];
    ly = local[1];
    lz = local[2];
    mx = lx * prim.stretch[0];
    my = ly * prim.stretch[1];
    mz = lz * prim.stretch[2];
  }
  const a = prim.args;
  let d: number;
  switch (prim.shape) {
    case 'box':
    case 'plane':
      // A bevelled box is measured in metres so the chamfer is the width the
      // author asked for on every edge, then divided back out because the
      // caller scales canonical distances into metres for everyone else.
      d =
        a.length > 3 && a[3] > 0
          ? sdRoundBox(
              mx,
              my,
              mz,
              a[0] * prim.stretch[0],
              a[1] * prim.stretch[1],
              a[2] * prim.stretch[2],
              a[3],
            ) / prim.lipschitz
          : sdBox(lx, ly, lz, a[0], a[1], a[2]);
      break;
    // A profile shape whose args came from the taper-only path has no profile
    // to read, so it falls back to the box that bounds it rather than reading
    // past the end of the array. See `primArgs`.
    case 'lathe':
      d = a[0] >= 2 ? sdLathe(a, lx, ly, lz) : sdBox(lx, ly, lz, a[1], a[2], a[3]);
      break;
    case 'extrude':
      d =
        a[0] >= 3
          ? sdExtrude(a, mx, my, mz) / prim.lipschitz
          : sdBox(lx, ly, lz, a[1], a[2], a[3]);
      break;
    case 'loft':
      // A loft has no closed form, so its own triangles are the field. They
      // are packed into `args` fitted to the unit box, which is the frame
      // `lx, ly, lz` is already in — so the mesh field is 1-Lipschitz here for
      // the same reason every other canonical shape is, and `lipschitz` scales
      // it back into metres unchanged. A loft with no stations is a box, and
      // its args say so by carrying no vertices.
      d =
        a[0] >= 3
          ? loftFieldOf(prim).distance(lx, ly, lz)
          : sdBox(lx, ly, lz, a[1], a[2], a[3]);
      break;
    case 'field':
      // The author's own expression, in the canonical box. Divided by its
      // declared Lipschitz bound so a displaced field still under-reports
      // distance, which is what keeps the block sampler honest.
      d = fieldEval(prim, lx, ly, lz);
      break;
    case 'octahedron':
      d = sdOctahedron(lx, ly, lz, a[0]);
      break;
    case 'tetrahedron':
      d = sdTetrahedron(lx, ly, lz, a[0]);
      break;
    case 'cylinder':
    case 'prism':
    case 'cone':
      d = sdFrustum(lx, ly, lz, a[0], a[1], a[2]);
      break;
    case 'capsule':
      d = sdCapsuleY(lx, ly, lz, a[0], a[1]);
      break;
    case 'torus':
      d = sdTorus(lx, ly, lz, a[0], a[1]);
      break;
    default:
      d = sdSphere(lx, ly, lz, a[0]);
  }
  // The warp's factor divides rather than multiplies: an inverse warp can move
  // the point it is evaluated at faster than the query point moves, and the
  // block test only stays sound while the reported distance cannot outrun the
  // step that produced it.
  // The two shapes measured in local metres (an extrude, a bevelled box) pay
  // one more factor under a warp. Their query point goes canonical (divided by
  // the stretch), through the inverse warp, and back to metres (multiplied by
  // the stretch): a bend can turn a step along the part's thin axis into one
  // along its long axis, so the round trip stretches by up to the ratio of
  // the two, and a 4.5 cm plate bent 12° was changing five times faster than
  // distance. Canonical shapes never leave the divided frame, so the min
  // stretch `prim.lipschitz` already covers them.
  const metricShape =
    (prim.shape === 'extrude' && a[0] >= 3) ||
    ((prim.shape === 'box' || prim.shape === 'plane') && a.length > 3 && a[3] > 0);
  const anisotropy =
    warp && metricShape
      ? Math.max(...prim.stretch) / Math.max(1e-9, Math.min(...prim.stretch))
      : 1;
  const metres = warp
    ? (d * prim.lipschitz) / (warp.lipschitz * anisotropy)
    : d * prim.lipschitz;
  const targets = prim.wrapTargets;
  if (!targets || !targets.length || !prim.wrap) return metres;
  // A wrapped part is the intersection of its own solid with a shell of its
  // targets: the points between `gap` and `gap + thickness` off their union.
  // Both operands are distance bounds, and the max of two is one, so the
  // sampler's block test stays sound.
  let toTarget = Infinity;
  for (const target of targets) {
    const dt = distanceTo(target, x, y, z);
    if (dt < toTarget) toTarget = dt;
  }
  const inner = toTarget - prim.wrap.gap;
  const shell = Math.max(inner - prim.wrap.thickness, -inner);
  return Math.max(metres, shell);
}

/** Scratch for the inverse warp, so a hot query allocates nothing. */
const local = [0, 0, 0];

/**
 * Build the canonical arguments for a shape sized to the unit box.
 *
 * `stretch` then scales that unit shape up to the part's declared size, and
 * `lipschitz` scales the resulting distance back into metres. Using the
 * smallest stretch component keeps the field conservative on squashed parts.
 */
/** What a profile shape falls back to when its args came without a profile. */
const BOXLIKE = [0, 0.5, 0.5, 0.5];

/**
 * The cross-section of an `extrude`, in metres, centred on the part's origin.
 *
 * Shared with the faceted builder so the two backends cannot drift: the
 * profile is a silhouette, not a measurement, and both ends of it get fitted
 * into the declared `size` the same way. `taper` widens or narrows the section
 * towards +Z, and the widest end is the one that reaches `size`, which is why
 * the fit divides by it.
 */
export function extrudeSection(source: PrimSource) {
  const profile = (source.profile ?? DEFAULT_EXTRUDE_PROFILE).map(
    (p) => [p[0], p[1]] as [number, number],
  );
  // Counter-clockwise, so the walls the builder raises off it face outward.
  if (signedArea(profile) < 0) profile.reverse();
  const size = source.size ?? [1, 1, 1];
  const taper = effectiveTaper(source);
  const [minX, minY, maxX, maxY] = profileBounds(profile);
  const width = Math.max(maxX - minX, 1e-9);
  const height = Math.max(maxY - minY, 1e-9);
  const grow = Math.max(1, taper);
  const sx = size[0] / grow / width;
  const sy = size[1] / grow / height;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfDepth = Math.max(size[2] / 2, 1e-9);
  return {
    points: profile.map(
      ([x, y]) => [(x - cx) * sx, (y - cy) * sy] as [number, number],
    ),
    halfDepth,
    taper,
    // The schema already refuses a bevel wider than half the shortest side, but
    // a repeat's `sizeJitter` shrinks a copy's size without touching its bevel.
    // Clamping here is what keeps that copy from turning inside out — and keeps
    // both backends clamping to the same number.
    bevel: Math.min(
      source.bevel ?? 0,
      Math.min(size[0], size[1]) / 2,
      halfDepth / 2,
    ),
  };
}

/** The closed profile of a `lathe`, in the units the author wrote it in. */
export function latheSection(source: PrimSource) {
  return closeProfile(source.profile ?? DEFAULT_LATHE_PROFILE);
}

/** [count, r, y, r, y, ...], normalised into the canonical unit box. */
function latheArgs(source: PrimSource): number[] {
  const points = latheSection(source);
  let radius = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const [r, y] of points) {
    if (r > radius) radius = r;
    if (y < low) low = y;
    if (y > high) high = y;
  }
  const span = high - low;
  // A profile with no width or no height revolves into nothing. The schema
  // refuses both, so this only catches a hand-built prim.
  if (radius <= 0 || span <= 0) return BOXLIKE;
  const centre = (low + high) / 2;
  const args: number[] = [points.length];
  for (const [r, y] of points)
    args.push(r / (2 * radius), (y - centre) / span);
  return args;
}

/** [count, taper, bevel, halfDepth, slopeDivisor, x, y, ...], in metres. */
function extrudeArgs(source: PrimSource): number[] {
  const { points, halfDepth, taper, bevel } = extrudeSection(source);
  if (points.length < 3) return BOXLIKE;
  let reach = 0;
  for (const [x, y] of points) reach = Math.max(reach, Math.hypot(x, y));
  const slope = (Math.abs(taper - 1) * reach) / (2 * halfDepth);
  const args: number[] = [
    points.length,
    taper,
    bevel,
    halfDepth,
    Math.hypot(1, slope),
  ];
  for (const [x, y] of points) args.push(x, y);
  return args;
}

export function primArgs(
  shape: Shape,
  source: PrimSource | number,
): number[] {
  // A number is the old call: taper and nothing else. It still answers for
  // every shape whose field is fixed by its own definition, and the two shapes
  // that need a profile fall back to the box that bounds them — a placeholder
  // the marcher can survive, not the right silhouette. Pass the whole part to
  // get that.
  const part = typeof source === 'number' ? undefined : source;
  const taper = typeof source === 'number' ? source : effectiveTaper(source);
  switch (shape) {
    case 'lathe':
      return part ? latheArgs(part) : BOXLIKE;
    case 'extrude':
      return part ? extrudeArgs(part) : BOXLIKE;
    case 'loft':
      return part ? loftArgs(part) : BOXLIKE;
    case 'box': {
      const size = part?.size ?? [1, 1, 1];
      // `RoundedBoxGeometry` clamps the radius to the shortest side for us; the
      // field has to do the same or a copy the schema never saw — one a
      // repeat's `sizeJitter` shrank — inverts instead of shrinking.
      const bevel = Math.min(part?.bevel ?? 0, Math.min(...size) / 2);
      return bevel > 0 ? [0.5, 0.5, 0.5, bevel] : [0.5, 0.5, 0.5];
    }
    case 'plane':
      // A plane has no thickness; give it just enough to survive voxelisation.
      return [0.5, 0.5, 0.012];
    case 'octahedron':
      return [0.5];
    case 'tetrahedron':
      return [0.5];
    case 'cylinder':
    case 'prism':
      return [0.5, 0.5 * taper, 0.5];
    case 'cone':
      return [0.5, 0, 0.5];
    case 'capsule':
      // CapsuleGeometry(0.5, 0.5): radius 0.5, straight segment 0.5 long, so
      // a quarter either side of centre. Its canonical extent carries the
      // 1.5 height, so these stay in the primitive's own proportions.
      return [0.25, 0.5];
    case 'torus':
      return [0.35, 0.15];
    default:
      return [0.5];
  }
}

/** Smooth union. `k` is the blend radius in metres; 0 is a hard union. */
export function smin(a: number, b: number, k: number) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Seeded value noise, trilinearly interpolated.
 *
 * Surface mode cannot displace vertices the way the faceted builder does,
 * because there are no per-primitive vertices left to displace. Perturbing the
 * field instead gives the same eroded silhouette and survives the blend.
 */
export function noise3(x: number, y: number, z: number, seed: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  let out = 0;
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const w =
          (i ? ux : 1 - ux) * (j ? uy : 1 - uy) * (k ? uz : 1 - uz);
        out += w * hash3(ix + i, iy + j, iz + k, seed);
      }
  return out * 2 - 1;
}

function hash3(x: number, y: number, z: number, seed: number) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
  h = (h ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ deform */

/**
 * Shapes that already take a `taper` of their own.
 *
 * `deform.taper` and the standalone `taper` mean exactly the same thing — the
 * far end's scale — so on these it is routed into the shape's own machinery
 * rather than warped on top of it. That is what makes `deform: { taper: 0.6 }`
 * and `taper: 0.6` produce the identical cylinder instead of two shapes that
 * are nearly the same; it also keeps the exact frustum field, which is a far
 * better distance than any warp of a cylinder could be.
 */
const NATIVE_TAPER = new Set<Shape>(['cylinder', 'prism', 'cone', 'extrude', 'limb']);

/**
 * The taper a part is actually built with.
 *
 * `deform.taper` wins, because a `deform` block is the more specific statement
 * — except at its neutral value of 1, which is what the schema fills in when
 * an author writes a `deform` that only bends. Treating that as an override
 * would silently un-taper a tapered mast the moment someone bent it.
 */
export function effectiveTaper(source: Pick<Part, 'taper' | 'deform'>) {
  const shaped = source.deform?.taper;
  return shaped !== undefined && shaped !== 1 ? shaped : (source.taper ?? 1);
}

/**
 * A resolved bend / twist / taper, in the part's own canonical frame.
 *
 * The frame is the one `canonicalExtent` describes: the shape centred on the
 * origin, filling that extent, before `fitToSize` scales it into metres. Both
 * backends warp there and only there, which is the whole reason a deformed
 * part looks the same faceted as it does fused.
 *
 * `axis` is the part's own x, y or z. The two cross-section axes are the next
 * two in cyclic order, so (axis, u, v) is always right-handed: x bends toward
 * +y, y toward +z, z toward +x, and a positive twist turns u toward v. One
 * convention, stated once, is worth more than three special cases.
 */
export type Warp = {
  axis: number;
  u: number;
  v: number;
  /** Half the canonical extent along the axis. */
  h: number;
  taper: number;
  /** Radians. */
  twist: number;
  /** Radians. */
  bend: number;
  /** Signed radius of the bent axis, or 0 when it is straight. */
  bendRadius: number;
  /**
   * How much faster the inverse warp can move a point than the point moves.
   *
   * `distanceTo` divides by this. A warped field is `d(F⁻¹(x))`, whose gradient
   * is bounded by the largest singular value of `DF⁻¹` — which is not 1 — so
   * without the division the hierarchical sampler's block rejection would step
   * further than the field can be trusted and carve holes in a bent part.
   */
  lipschitz: number;
  /** Rings the faceted builder needs along the axis to draw this smoothly. */
  segments: number;
};

/**
 * Resolve a part's `deform` into a warp, or null when it does nothing.
 *
 * A `loft` is left out on purpose: its triangles are skinned rather than
 * fitted, so the warp is baked into them once at build time and the field
 * reads the deformed mesh directly. Warping the query point as well would
 * apply the bend twice. A `limb` is left out because it is drawn between two
 * authored points rather than inside a box, so there is no canonical frame to
 * bend in — move its `via` instead.
 */
export function warpFor(shape: Shape, deform: Part['deform']): Warp | null {
  if (!deform || shape === 'loft' || shape === 'limb') return null;
  const taper = NATIVE_TAPER.has(shape) ? 1 : (deform.taper ?? 1);
  const twist = T.MathUtils.degToRad(deform.twist ?? 0);
  const bend = T.MathUtils.degToRad(deform.bend ?? 0);
  if (taper === 1 && twist === 0 && bend === 0) return null;

  const axis = deform.axis === 'x' ? 0 : deform.axis === 'z' ? 2 : 1;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const extent = canonicalExtent(shape);
  const h = Math.max(extent[axis] / 2, 1e-6);
  const warp: Warp = {
    axis,
    u,
    v,
    h,
    taper,
    twist,
    bend,
    bendRadius: Math.abs(bend) > 1e-9 ? (2 * h) / bend : 0,
    lipschitz: 1,
    segments: Math.min(
      32,
      Math.max(1, Math.ceil(Math.max(Math.abs(deform.bend ?? 0), Math.abs(deform.twist ?? 0)) / 6)),
    ),
  };

  // The three warps, each bounded by the worst its own inverse can stretch.
  // The field is `d(F⁻¹(x))`, so what matters is the largest singular value of
  // `DF⁻¹`, which is one over the smallest singular value of `DF`.
  //
  // taper: `DF` scales the cross-section by s, smallest at the narrow end, so
  //   the bound is 1/min(1, taper). Clamped at 0.05 because the map is
  //   genuinely singular at a point — a taper of zero is a knife edge, and no
  //   finite factor makes an inverse warp well behaved there.
  // twist: `DF` is a rotation of the cross-section plus a shear of
  //   ψ' = twist / 2h along the axis, acting at radius r. Its smallest singular
  //   value is (√(g² + 4) − g)/2 with g = ψ'r, and 1 + g is a clean upper bound
  //   on the reciprocal — the `1 + |twist| · r` the guide quotes, since 2h is 1
  //   for every shape whose canonical extent is the unit box.
  // bend: `DF` stretches the outer fibre by (R + r)/R and compresses the inner
  //   one to (R − r)/R, and it is the compression that bounds the inverse:
  //   1/(1 − |bend| · r / 2h). To first order that is the outer fibre's stretch
  //   1 + |bend| · r / 2h, but it is strictly larger, and the block test is only
  //   sound with a bound that is never too small.
  const grow = Math.max(1, taper);
  const rBend = (extent[u] / 2) * grow;
  const rTwist = Math.hypot(extent[u] / 2, extent[v] / 2) * grow;
  const kTaper = 1 / Math.min(1, Math.max(taper, 0.05));
  const kTwist = 1 + (Math.abs(twist) * rTwist) / (2 * h);
  const kBend = 1 / (1 - Math.min(0.9, (Math.abs(bend) * rBend) / (2 * h)));
  warp.lipschitz = kTaper * kTwist * kBend;
  return warp;
}

/**
 * Bend, twist and taper a point in place, in the part's canonical frame.
 *
 * This is the map the faceted builder pushes its vertices through and the map
 * `undeformPoint` undoes on a query point, and there is deliberately nothing
 * else in it: no re-fitting of the result back into the part's box. Re-fitting
 * would depend on the deformed mesh's own bounding box, which the field never
 * sees, and the two backends would draw different shapes. The price is that a
 * bend moves material outside `size` — `size` is the box the part fills before
 * it is bent — and the guide says so.
 */
export function deformPoint(w: Warp, p: number[]) {
  let a = p[w.axis];
  let pu = p[w.u];
  let pv = p[w.v];
  // Clamped, so a point past the end of the shape carries the end's own
  // section rather than an extrapolated one that folds back through the axis.
  const t = clamp(a / (2 * w.h) + 0.5, 0, 1);
  if (w.taper !== 1) {
    const s = 1 + (w.taper - 1) * t;
    pu *= s;
    pv *= s;
  }
  if (w.twist !== 0) {
    const angle = w.twist * t;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const nu = pu * cos - pv * sin;
    pv = pu * sin + pv * cos;
    pu = nu;
  }
  if (w.bendRadius !== 0) {
    const r = w.bendRadius;
    const phi = a / r;
    const arm = r - pu;
    a = arm * Math.sin(phi);
    pu = r - arm * Math.cos(phi);
  }
  p[w.axis] = a;
  p[w.u] = pu;
  p[w.v] = pv;
}

/**
 * The exact inverse of `deformPoint`.
 *
 * Exact rather than approximate because the sign of the field comes from it:
 * an inverse that drifted would report points just inside a bent horn as
 * outside it, and the marcher would pit the surface.
 */
export function undeformPoint(w: Warp, p: number[]) {
  let a = p[w.axis];
  let pu = p[w.u];
  let pv = p[w.v];
  if (w.bendRadius !== 0) {
    const r = w.bendRadius;
    const sign = r < 0 ? -1 : 1;
    // The bent point lies on a circle about (axis 0, u = r); its distance from
    // that centre is the arm |r - u|, and the angle it subtends is the arc
    // parameter the forward map used.
    const arm = sign * Math.hypot(a, r - pu);
    const phi = Math.atan2(a * sign, (r - pu) * sign);
    pu = r - arm;
    a = phi * r;
  }
  const t = clamp(a / (2 * w.h) + 0.5, 0, 1);
  if (w.twist !== 0) {
    const angle = -w.twist * t;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const nu = pu * cos - pv * sin;
    pv = pu * sin + pv * cos;
    pu = nu;
  }
  if (w.taper !== 1) {
    const s = Math.max(1e-4, 1 + (w.taper - 1) * t);
    pu /= s;
    pv /= s;
  }
  p[w.axis] = a;
  p[w.u] = pu;
  p[w.v] = pv;
}

/**
 * The box a deformed shape occupies in its own canonical frame, or null when
 * the part is not deformed.
 *
 * A bend moves material outside the extent the shape started in — that is what
 * bending is — and `deformPoint` deliberately does not fit it back, because a
 * fit depends on the deformed mesh's own bounds and the field has only `size`
 * to go on. So the primitive's bounding box has to grow instead, and this is
 * how much: the canonical extent box pushed through the same warp the vertices
 * went through. Sampled rather than solved, because the extremes of a bent,
 * twisted, tapered box have no tidy closed form and a lattice of the box costs
 * a few microseconds once per primitive.
 *
 * `primFor` in `asset-surface.ts` is what needs this: without it the sampler
 * culls every query outside the un-bent box and marches a bent horn off flat.
 */
export function deformedBounds(shape: Shape, deform: Part['deform']) {
  const warp = warpFor(shape, deform);
  if (!warp) return null;
  const extent = canonicalExtent(shape);
  const box = new T.Box3();
  const point = [0, 0, 0];
  const steps = 8;
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++)
      for (let k = 0; k <= steps; k++) {
        point[0] = (i / steps - 0.5) * extent[0];
        point[1] = (j / steps - 0.5) * extent[1];
        point[2] = (k / steps - 0.5) * extent[2];
        deformPoint(warp, point);
        box.expandByPoint(scratch.set(point[0], point[1], point[2]));
      }
  // The lattice can undershoot the true extreme by half a cell of curvature, so
  // the box is grown by a fiftieth of the part. A bounding box that is slightly
  // too large costs a few more samples; one that is slightly too small cuts a
  // sliver off the model, which is the whole failure this exists to prevent.
  return box.expandByScalar(Math.max(extent[0], extent[1], extent[2]) / 50);
}

/** Resolved once per primitive, on its first query. */
function warpOf(prim: Prim) {
  if (prim.warp === undefined) prim.warp = warpFor(prim.shape, prim.deform);
  return prim.warp;
}

/* -------------------------------------------------------------------- loft */

/**
 * The closed 2D outline of one station.
 *
 * `mirror` reflects the authored half across x = 0 and welds the seam, so an
 * author draws one side of a hull and gets both. Points already sitting on the
 * seam are their own reflection, and emitting them twice would leave a
 * zero-length edge at the keel — which survives every test until the resample
 * divides by it.
 *
 * Wound counter-clockwise, because the ruled quads and the end caps both take
 * their outward direction from the contour's winding. Reversing keeps the
 * first point first: station 0 of every section has to start in the same place
 * or the quads join a hull's keel to its gunwale.
 */
function stationOutline(
  profile: ReadonlyArray<readonly [number, number]>,
  closed: 'mirror' | 'none',
) {
  const points: [number, number][] = profile.map((p) => [p[0], p[1]]);
  if (closed === 'mirror')
    for (let i = profile.length - 1; i >= 0; i--) {
      if (Math.abs(profile[i][0]) < 1e-9) continue;
      points.push([-profile[i][0], profile[i][1]]);
    }
  if (signedArea(points) < 0) {
    const head = points[0];
    return [head, ...points.slice(1).reverse()];
  }
  return points;
}

/**
 * Resample a closed contour to exactly `count` points, evenly by arc length.
 *
 * By arc length rather than by index, because the stations of a hull are
 * authored with whatever number of points each one needs — a transom wants
 * four, midships wants nine — and pairing them by index would run the
 * midships chine into the transom's corner and put a crease down the side.
 * Arc length pairs the two contours by how far round each point sits, which is
 * the correspondence an author draws by eye.
 *
 * A contour that already has the wanted count is handed back untouched, so a
 * spec whose stations all share a point count keeps its corners exactly where
 * they were authored.
 */
function resampleContour(points: [number, number][], count: number) {
  if (points.length === count) return points;
  const n = points.length;
  const run = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    run[i + 1] = run[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = run[n];
  const out: [number, number][] = [];
  if (total < 1e-12) {
    for (let i = 0; i < count; i++) out.push([points[0][0], points[0][1]]);
    return out;
  }
  let edge = 0;
  for (let i = 0; i < count; i++) {
    const want = (i / count) * total;
    while (edge < n - 1 && run[edge + 1] < want) edge++;
    const span = run[edge + 1] - run[edge];
    const t = span > 1e-12 ? (want - run[edge]) / span : 0;
    const a = points[edge];
    const b = points[(edge + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

type Frame = { point: number[]; tangent: number[] };

/** Where each station sits on the spine, and which way the spine points there. */
function spinePath(spine: Part['spine'], ats: number[]): Frame[] {
  // The default spine runs along +Z of the canonical box, which is what makes
  // a loft of identical stations the same solid as an `extrude` of that
  // profile — the one case where an author can check the skinner by eye.
  const from = spine?.from ?? [0, 0, -0.5];
  const to = spine?.to ?? [0, 0, 0.5];
  const via = spine?.via;
  if (!via) {
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    const tangent = [d[0] / length, d[1] / length, d[2] / length];
    return ats.map((at) => ({
      point: [from[0] + d[0] * at, from[1] + d[1] * at, from[2] + d[2] * at],
      tangent,
    }));
  }
  const at = (t: number) => {
    const u = 1 - t;
    return [0, 1, 2].map(
      (a) => u * u * from[a] + 2 * u * t * via[a] + t * t * to[a],
    );
  };
  const slope = (t: number) => {
    const d = [0, 1, 2].map(
      (a) => 2 * (1 - t) * (via[a] - from[a]) + 2 * t * (to[a] - via[a]),
    );
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / length, d[1] / length, d[2] / length];
  };
  // `at` is a fraction of the spine's length, not of the bezier's parameter,
  // so the stations of a curved spine stay evenly spread instead of bunching
  // where the curve is tight. A fixed table keeps it deterministic.
  const steps = 128;
  const run = new Float64Array(steps + 1);
  let last = at(0);
  for (let i = 1; i <= steps; i++) {
    const here = at(i / steps);
    run[i] =
      run[i - 1] + Math.hypot(here[0] - last[0], here[1] - last[1], here[2] - last[2]);
    last = here;
  }
  const total = run[steps] || 1;
  const parameter = (want: number) => {
    const target = want * total;
    let i = 0;
    while (i < steps - 1 && run[i + 1] < target) i++;
    const span = run[i + 1] - run[i];
    const f = span > 1e-12 ? (target - run[i]) / span : 0;
    return (i + f) / steps;
  };
  return ats.map((u) => {
    const t = parameter(u);
    return { point: at(t), tangent: slope(t) };
  });
}

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A rotation-minimising frame along the spine, by double reflection.
 *
 * The obvious frame — Frenet's — spins about the tangent wherever the curve's
 * curvature swings, and a hull skinned in it comes out with a twist in the
 * middle that nobody asked for. Double reflection carries the reference vector
 * from one station to the next with the least rotation any frame can have, and
 * it is exact for a straight run rather than undefined there.
 */
function minimalFrames(path: Frame[]) {
  const first = path[0].tangent;
  // The world axis least aligned with the tangent, scanning x, y, z in order.
  // For the default spine along +Z that is X, so the profile's own x and y land
  // on the world x and y and the loft agrees with `extrude` axis for axis.
  let pick = 0;
  for (let a = 1; a < 3; a++)
    if (Math.abs(first[a]) < Math.abs(first[pick])) pick = a;
  const seed = [0, 0, 0];
  seed[pick] = 1;
  const project = (r: number[], t: number[]) => {
    const k = dot3(r, t);
    const out = [r[0] - t[0] * k, r[1] - t[1] * k, r[2] - t[2] * k];
    const length = Math.hypot(out[0], out[1], out[2]) || 1;
    return [out[0] / length, out[1] / length, out[2] / length];
  };
  let reference = project(seed, first);
  const frames = [reference];
  for (let i = 0; i < path.length - 1; i++) {
    const v1 = [0, 1, 2].map((a) => path[i + 1].point[a] - path[i].point[a]);
    const c1 = dot3(v1, v1);
    let carried = reference;
    if (c1 > 1e-18) {
      const rl = [0, 1, 2].map((a) => reference[a] - (2 / c1) * dot3(v1, reference) * v1[a]);
      const tl = [0, 1, 2].map(
        (a) => path[i].tangent[a] - (2 / c1) * dot3(v1, path[i].tangent) * v1[a],
      );
      const v2 = [0, 1, 2].map((a) => path[i + 1].tangent[a] - tl[a]);
      const c2 = dot3(v2, v2);
      carried =
        c2 > 1e-18 ? [0, 1, 2].map((a) => rl[a] - (2 / c2) * dot3(v2, rl) * v2[a]) : rl;
    }
    reference = project(carried, path[i + 1].tangent);
    frames.push(reference);
  }
  return frames;
}

export type LoftMesh = {
  positions: number[];
  uvs: number[];
  indices: number[];
};

/**
 * Skin a loft's stations into triangles, fitted to the canonical unit box.
 *
 * Shared by both backends, exactly like `extrudeSection` and `latheSection`
 * are: the faceted builder wraps these numbers in a `BufferGeometry` and scales
 * them to `size`, and the field builds a BVH over the same numbers. There is
 * no second implementation to drift, which matters more here than anywhere
 * else in the file — a loft has no closed form for either side to check
 * against.
 *
 * Returns null when there are not two stations to skin, which is the signal to
 * fall back to a plain box.
 */
export function loftMesh(source: PrimSource): LoftMesh | null {
  const stations = [...(source.stations ?? [])].sort((a, b) => a.at - b.at);
  if (stations.length < 2) return null;
  const closed = source.closed ?? 'mirror';
  const outlines = stations.map((s) => stationOutline(s.profile, closed));
  const count = Math.max(...outlines.map((o) => o.length));
  const sections = outlines.map((o) => resampleContour(o, count));

  const path = spinePath(
    source.spine,
    stations.map((s) => s.at),
  );
  const references = minimalFrames(path);

  /** One station's contour lifted into the spine's frame there. */
  const ringAt = (index: number) => {
    const { point, tangent } = path[index];
    const r = references[index];
    // (tangent, r, s) right-handed, so a counter-clockwise contour in (r, s)
    // faces along the tangent — the same convention as an extrude's caps.
    const s = [
      tangent[1] * r[2] - tangent[2] * r[1],
      tangent[2] * r[0] - tangent[0] * r[2],
      tangent[0] * r[1] - tangent[1] * r[0],
    ];
    const out: number[] = [];
    for (const [x, y] of sections[index])
      for (let a = 0; a < 3; a++) out.push(point[a] + r[a] * x + s[a] * y);
    return out;
  };

  const base = stations.map((_, i) => ringAt(i));
  // A loft's canonical frame is the unit box, whatever its stations draw in it,
  // so the warp resolves exactly as a box's would. It is baked into the rings
  // here rather than undone on the query point, because a loft's field reads
  // these very triangles — warping them once is both backends done at a stroke.
  const warp = warpFor('box', source.deform);
  // A ruled band is linear in space, so splitting it by interpolating its two
  // rings adds vertices without moving the surface — which is exactly what a
  // bend needs, and costs nothing when there is no bend to draw.
  const split = warp ? warp.segments : 1;
  const rings: number[][] = [];
  const levels: number[] = [];
  for (let i = 0; i < base.length - 1; i++)
    for (let k = 0; k < split; k++) {
      const t = k / split;
      rings.push(base[i].map((v, a) => v + (base[i + 1][a] - v) * t));
      levels.push((i + t) / (base.length - 1));
    }
  rings.push(base[base.length - 1]);
  levels.push(1);

  if (warp) {
    const point = [0, 0, 0];
    for (const ring of rings)
      for (let i = 0; i < ring.length; i += 3) {
        point[0] = ring[i];
        point[1] = ring[i + 1];
        point[2] = ring[i + 2];
        deformPoint(warp, point);
        ring[i] = point[0];
        ring[i + 1] = point[1];
        ring[i + 2] = point[2];
      }
  }

  // Into the canonical unit box, so the field can read the same triangles the
  // builder draws and `size` still means the box the author asked for. The
  // builder's own `fitToSize` then reduces to a plain scale by `size`.
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i += 3)
      for (let a = 0; a < 3; a++) {
        if (ring[i + a] < low[a]) low[a] = ring[i + a];
        if (ring[i + a] > high[a]) high[a] = ring[i + a];
      }
  const fit = [0, 1, 2].map((a) =>
    high[a] - low[a] > 1e-9 ? 1 / (high[a] - low[a]) : 1,
  );
  const centre = [0, 1, 2].map((a) => (low[a] + high[a]) / 2);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const stride = count + 1;
  rings.forEach((ring, at) => {
    // The seam column is duplicated so the uvs can run the whole way round,
    // the same way the lathe does it.
    for (let j = 0; j <= count; j++) {
      const i = (j % count) * 3;
      for (let a = 0; a < 3; a++)
        positions.push((ring[i + a] - centre[a]) * fit[a]);
      uvs.push(j / count, levels[at]);
    }
  });
  for (let at = 0; at < rings.length - 1; at++)
    for (let j = 0; j < count; j++) {
      const low_ = at * stride + j;
      const lowNext = low_ + 1;
      const high_ = low_ + stride;
      const highNext = lowNext + stride;
      // The same diagonal on every quad, so a band reads as one surface rather
      // than a herringbone of alternating splits.
      indices.push(low_, lowNext, highNext, low_, highNext, high_);
    }

  const cap = (section: [number, number][]) =>
    T.ShapeUtils.triangulateShape(
      section.map(([x, y]) => new T.Vector2(x, y)),
      [],
    );
  // Earcut keeps the contour's winding, so the far cap faces along the spine
  // and the near one has to be turned around.
  for (const [a, b, c] of cap(sections[0])) indices.push(a, c, b);
  const last = (rings.length - 1) * stride;
  for (const [a, b, c] of cap(sections[sections.length - 1]))
    indices.push(last + a, last + b, last + c);

  return { positions, uvs, indices };
}

/** [vertices, triangles, x, y, z, ..., i, j, k, ...] in the canonical unit box. */
function loftArgs(source: PrimSource): number[] {
  const mesh = loftMesh(source);
  if (!mesh) return BOXLIKE;
  const args: number[] = [mesh.positions.length / 3, mesh.indices.length / 3];
  for (const v of mesh.positions) args.push(v);
  for (const i of mesh.indices) args.push(i);
  return args;
}

type LoftCache = { field: MeshField; geometry: T.BufferGeometry };

/**
 * One BVH per primitive per build, keyed on the argument array it was packed
 * into — which `primFor` builds once and never replaces, so the cache lives
 * exactly as long as the primitive does and dies with it.
 */
const loftCache = new WeakMap<number[], LoftCache>();

function loftFieldOf(prim: Prim) {
  let cached = loftCache.get(prim.args);
  if (!cached) {
    const a = prim.args;
    const vertices = a[0];
    const triangles = a[1];
    const positions = new Float64Array(vertices * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = a[2 + i];
    const indices = new Uint32Array(triangles * 3);
    for (let i = 0; i < indices.length; i++) indices[i] = a[2 + positions.length + i];
    const geometry = new T.BufferGeometry();
    geometry.setAttribute(
      'position',
      new T.Float32BufferAttribute(Array.from(positions), 3),
    );
    geometry.setIndex(Array.from(indices));
    cached = { field: buildMeshField(positions, indices), geometry };
    loftCache.set(a, cached);
  }
  prim.mesh = cached.geometry;
  return cached.field;
}
