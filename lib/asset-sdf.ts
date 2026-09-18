import * as T from 'three';
import type { Part, Shape } from './asset-spec';

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
  color: T.Color;
  rigPart?: string;
  specPath?: number[];
  jitter: number;
  seed: number;
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
>;

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
  const lx = scratch.x / prim.stretch[0];
  const ly = scratch.y / prim.stretch[1];
  const lz = scratch.z / prim.stretch[2];
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
              scratch.x,
              scratch.y,
              scratch.z,
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
          ? sdExtrude(a, scratch.x, scratch.y, scratch.z) / prim.lipschitz
          : sdBox(lx, ly, lz, a[1], a[2], a[3]);
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
  return d * prim.lipschitz;
}

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
  const taper = source.taper ?? 1;
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
  const taper = typeof source === 'number' ? source : (source.taper ?? 1);
  switch (shape) {
    case 'lathe':
      return part ? latheArgs(part) : BOXLIKE;
    case 'extrude':
      return part ? extrudeArgs(part) : BOXLIKE;
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
