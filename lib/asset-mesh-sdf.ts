/**
 * A signed distance field read straight off a triangle mesh.
 *
 * Every other shape in this project has an analytic field, because an analytic
 * field is exact, cheap and 1-Lipschitz for free. A `loft` has none: its
 * surface is whatever skinning a list of authored cross-sections produces, and
 * there is no closed form for the distance to a ruled patch between two
 * arbitrary polygons. Measuring the triangles the faceted builder already
 * produces is the only way to make the two backends agree about where a hull
 * actually is — and it agrees exactly, rather than to within some fitted
 * approximation, because both are reading the same triangles.
 *
 * Two halves, because distance and sign are different problems:
 *
 * - **Distance** is the nearest point on any triangle, found through a BVH.
 *   The magnitude is what the marcher interpolates across a cell, so it has to
 *   be the true distance rather than a bound.
 * - **Sign** is the generalised winding number of Jacobson et al. — the sum of
 *   the signed solid angles the triangles subtend at the query point, over 4π.
 *   For a closed mesh that is exactly 1 inside and 0 outside; for a mesh with a
 *   hole in it, it degrades smoothly instead of flipping the inside of the
 *   model inside out, which a ray-crossing test does the moment one triangle is
 *   missing. A hull that skins badly should look wrong, not explode.
 *
 * The winding number costs a solid angle per triangle, and the multipole
 * approximation that is meant to save it barely fires on a mesh this coarse:
 * two hundred triangles over a whole hull means each one is large next to the
 * distance a query sits from it, so the far-field test fails and the sum is
 * paid in full. Measured, that is about 3.4 microseconds a query — four times
 * the marcher's whole budget. So a mesh that is *closed and consistently wound*
 * — which everything the skinner produces is, and `watertight` proves one by
 * one — takes its sign from the angle-weighted pseudonormal of Baerentzen and
 * Aanaes instead: provably the same answer on such a mesh, read off the closest
 * point the distance query has already found, for a few nanoseconds. The
 * winding number remains the sign for everything else, and stays exported so
 * the equivalence can be tested rather than asserted.
 *
 * The field is exact, so it is 1-Lipschitz in whatever frame the triangles were
 * handed over in. The caller is responsible for evaluating it in that frame.
 */

/** Triangles per leaf. */
const LEAF = 4;

/**
 * How far a node has to be, in multiples of its own radius, before its solid
 * angle is taken from one dipole instead of triangle by triangle.
 *
 * The dipole is the first term of the multipole expansion of the solid angle,
 * so its relative error falls off as (radius / distance)². At two and a half
 * radii that is under two percent of a contribution which is itself small,
 * and nothing near the surface — where the sign is actually in doubt — ever
 * qualifies, because a node containing the nearest triangles fails the test.
 */
const BETA = 2.0;

export type MeshField = {
  /** Signed distance to the surface, negative inside. */
  distance(x: number, y: number, z: number): number;
  /** Unsigned distance to the nearest triangle. */
  nearest(x: number, y: number, z: number): number;
  /** Generalised winding number: 1 deep inside a closed mesh, 0 outside. */
  winding(x: number, y: number, z: number): number;
  triangles: number;
  /** Nodes in the BVH, for tests and for reporting build cost. */
  nodes: number;
  /** Whether the mesh is closed and consistently wound. */
  watertight: boolean;
};

type Build = {
  /** Triangle corners, nine numbers each, in BVH order. */
  corner: Float64Array;
  /** Per-node bounds, six numbers each. */
  bounds: number[];
  /** Per-node: left child, right child, first triangle, triangle count. */
  link: number[];
  /** Per-node: twice the area-weighted normal sum, then the area centroid. */
  moment: number[];
  /** Per-node: the radius of a sphere about the moment centroid that holds it. */
  radius: number[];
};

const EPS = 1e-12;

/** Squared distance from a point to a triangle, by Ericson's region test. */
function triangleDistance2(
  c: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
) {
  const ax = c[t], ay = c[t + 1], az = c[t + 2];
  const bx = c[t + 3], by = c[t + 4], bz = c[t + 5];
  const cx = c[t + 6], cy = c[t + 7], cz = c[t + 8];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3 || EPS);
    const qx = apx - abx * v, qy = apy - aby * v, qz = apz - abz * v;
    return qx * qx + qy * qy + qz * qz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6 || EPS);
    const qx = apx - acx * w, qy = apy - acy * w, qz = apz - acz * w;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6) || EPS);
    const qx = bpx + (cpx - bpx) * w;
    const qy = bpy + (cpy - bpy) * w;
    const qz = bpz + (cpz - bpz) * w;
    return qx * qx + qy * qy + qz * qz;
  }

  const denom = va + vb + vc || EPS;
  const v = vb / denom;
  const w = vc / denom;
  const qx = apx - abx * v - acx * w;
  const qy = apy - aby * v - acy * w;
  const qz = apz - abz * v - acz * w;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * The signed solid angle a triangle subtends at a point, by Van Oosterom and
 * Strackee.
 *
 * `atan2` of the determinant against the sum of the pairwise terms, which is
 * numerically well behaved everywhere except exactly on the triangle's plane
 * inside its own outline — where the solid angle genuinely jumps by 2π, and no
 * formulation can help. A point there is on the surface, and the caller's
 * distance is zero, so the sign does not matter.
 *
 * Positive when the corners run counter-clockwise seen from outside, so the
 * sum over a closed outward-wound mesh is 4π inside it and 0 outside.
 */
function solidAngle(
  c: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
) {
  const ax = c[t] - px, ay = c[t + 1] - py, az = c[t + 2] - pz;
  const bx = c[t + 3] - px, by = c[t + 4] - py, bz = c[t + 5] - pz;
  const cx = c[t + 6] - px, cy = c[t + 7] - py, cz = c[t + 8] - pz;
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(bx * bx + by * by + bz * bz);
  const lc = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (la < EPS || lb < EPS || lc < EPS) return 0;
  const det =
    ax * (by * cz - bz * cy) -
    ay * (bx * cz - bz * cx) +
    az * (bx * cy - by * cx);
  const denom =
    la * lb * lc +
    (ax * bx + ay * by + az * bz) * lc +
    (ax * cx + ay * cy + az * cz) * lb +
    (bx * cx + by * cy + bz * cz) * la;
  return 2 * Math.atan2(det, denom);
}

/**
 * Wrap a triangle list in a BVH and hand back the field it defines.
 *
 * Built once per primitive per build and then queried a few million times, so
 * every query path here is a loop over flat typed arrays with an explicit
 * stack: no allocation, no closures over mutable scratch, no `Vector3`.
 */
export function buildMeshField(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): MeshField {
  const count = Math.floor(indices.length / 3);
  const corner = new Float64Array(Math.max(1, count) * 9);
  // Triangle centroids drive the split; kept separate so the corner array can
  // be permuted into BVH order in one pass at the end.
  const centroid = new Float64Array(Math.max(1, count) * 3);
  const source = new Float64Array(Math.max(1, count) * 9);
  for (let t = 0; t < count; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      source[t * 9 + k * 3] = x;
      source[t * 9 + k * 3 + 1] = y;
      source[t * 9 + k * 3 + 2] = z;
      cx += x; cy += y; cz += z;
    }
    centroid[t * 3] = cx / 3;
    centroid[t * 3 + 1] = cy / 3;
    centroid[t * 3 + 2] = cz / 3;
  }

  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;

  const build: Build = {
    corner,
    bounds: [],
    link: [],
    moment: [],
    radius: [],
  };

  /** Recursively split [from, to) of `order`, returning the node index. */
  const node = (from: number, to: number): number => {
    const index = build.radius.length;
    build.bounds.length = (index + 1) * 6;
    build.link.length = (index + 1) * 4;
    build.moment.length = (index + 1) * 6;
    build.radius.push(0);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    // Twice the area-weighted normal, which is what the dipole needs, plus the
    // area-weighted centroid it is expanded about.
    let nx = 0, ny = 0, nz = 0;
    let mx = 0, my = 0, mz = 0;
    let area = 0;
    for (let i = from; i < to; i++) {
      const t = order[i] * 9;
      for (let k = 0; k < 3; k++) {
        const x = source[t + k * 3], y = source[t + k * 3 + 1], z = source[t + k * 3 + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      const ex = source[t + 3] - source[t], ey = source[t + 4] - source[t + 1], ez = source[t + 5] - source[t + 2];
      const fx = source[t + 6] - source[t], fy = source[t + 7] - source[t + 1], fz = source[t + 8] - source[t + 2];
      const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
      nx += gx; ny += gy; nz += gz;
      const a = Math.hypot(gx, gy, gz) * 0.5;
      area += a;
      const c = order[i] * 3;
      mx += centroid[c] * a;
      my += centroid[c + 1] * a;
      mz += centroid[c + 2] * a;
      if (centroid[c] < cMinX) cMinX = centroid[c];
      if (centroid[c + 1] < cMinY) cMinY = centroid[c + 1];
      if (centroid[c + 2] < cMinZ) cMinZ = centroid[c + 2];
      if (centroid[c] > cMaxX) cMaxX = centroid[c];
      if (centroid[c + 1] > cMaxY) cMaxY = centroid[c + 1];
      if (centroid[c + 2] > cMaxZ) cMaxZ = centroid[c + 2];
    }
    build.bounds[index * 6] = minX;
    build.bounds[index * 6 + 1] = minY;
    build.bounds[index * 6 + 2] = minZ;
    build.bounds[index * 6 + 3] = maxX;
    build.bounds[index * 6 + 4] = maxY;
    build.bounds[index * 6 + 5] = maxZ;
    // A node of zero total area — a fully degenerate run of slivers — has no
    // usable centroid, so fall back to the middle of its box.
    const scale = area > EPS ? 1 / area : 0;
    const px = scale ? mx * scale : (minX + maxX) / 2;
    const py = scale ? my * scale : (minY + maxY) / 2;
    const pz = scale ? mz * scale : (minZ + maxZ) / 2;
    build.moment[index * 6] = nx * 0.5;
    build.moment[index * 6 + 1] = ny * 0.5;
    build.moment[index * 6 + 2] = nz * 0.5;
    build.moment[index * 6 + 3] = px;
    build.moment[index * 6 + 4] = py;
    build.moment[index * 6 + 5] = pz;
    // Measured to the node's own corners rather than to its bounding box's,
    // because the box's corners can sit well outside anything the node holds —
    // and every millimetre of slack here is a node the far-field test refuses
    // and the query pays for triangle by triangle.
    let far = 0;
    for (let i = from; i < to; i++) {
      const t = order[i] * 9;
      for (let k = 0; k < 3; k++) {
        const d = Math.hypot(
          source[t + k * 3] - px,
          source[t + k * 3 + 1] - py,
          source[t + k * 3 + 2] - pz,
        );
        if (d > far) far = d;
      }
    }
    build.radius[index] = far;

    const span = to - from;
    const wx = cMaxX - cMinX, wy = cMaxY - cMinY, wz = cMaxZ - cMinZ;
    if (span <= LEAF || Math.max(wx, wy, wz) < EPS) {
      build.link[index * 4] = -1;
      build.link[index * 4 + 1] = -1;
      build.link[index * 4 + 2] = from;
      build.link[index * 4 + 3] = span;
      return index;
    }
    // Median on the widest axis of the centroid spread. A surface-area split
    // would pack the tree slightly tighter, but a loft's triangles come out of
    // the skinner already sorted along the spine, so the median is close to it
    // and costs a fraction of the build.
    const axis = wx >= wy && wx >= wz ? 0 : wy >= wz ? 1 : 2;
    const mid = (from + to) >> 1;
    const slice = Array.from(order.subarray(from, to));
    slice.sort((a, b) => {
      const d = centroid[a * 3 + axis] - centroid[b * 3 + axis];
      // Ties broken by index so the tree — and so every distance it reports —
      // is identical from one build to the next.
      return d !== 0 ? d : a - b;
    });
    order.set(slice, from);
    const left = node(from, mid);
    const right = node(mid, to);
    build.link[index * 4] = left;
    build.link[index * 4 + 1] = right;
    build.link[index * 4 + 2] = 0;
    build.link[index * 4 + 3] = 0;
    return index;
  };

  if (count) node(0, count);
  else {
    build.bounds.push(0, 0, 0, 0, 0, 0);
    build.link.push(-1, -1, 0, 0);
    build.moment.push(0, 0, 0, 0, 0, 0);
    build.radius.push(0);
  }

  // Permute the corners into BVH order so a leaf's triangles are contiguous.
  for (let i = 0; i < count; i++)
    corner.set(source.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);

  const bounds = Float64Array.from(build.bounds);
  const link = Int32Array.from(build.link);
  const moment = Float64Array.from(build.moment);
  const radius = Float64Array.from(build.radius);
  const nodes = radius.length;
  // One stack, reused across queries. The tree is balanced by construction, so
  // its depth is log2(triangles) and this is never close to full.
  const stack = new Int32Array(Math.max(64, nodes * 2));
  const queue = new Float64Array(Math.max(64, nodes * 2));

  /**
   * Whether every directed edge appears exactly once and its reverse with it.
   *
   * A mesh that passes is a closed, consistently wound surface, and the
   * angle-weighted pseudonormal of Baerentzen and Aanaes gives its sign exactly
   * — from the one closest point the distance query has already found, at no
   * extra cost. A mesh that fails gets the winding number instead, which is
   * slower by the number of triangles but keeps its nerve on a surface with a
   * hole in it. The shipped skinner only ever produces the first kind; the
   * second exists so that a loft an author has broken still reads as a solid
   * rather than as its own negative.
   */
  const watertight = (() => {
    if (!count) return false;
    const ids = new Map<string, number>();
    const label = (t: number, k: number) => {
      const key =
        `${corner[t + k * 3]},${corner[t + k * 3 + 1]},${corner[t + k * 3 + 2]}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      return id;
    };
    const seen = new Set<number>();
    const edges: [number, number][] = [];
    for (let t = 0; t < count; t++) {
      const a = label(t * 9, 0);
      const b = label(t * 9, 1);
      const c = label(t * 9, 2);
      if (a === b || b === c || c === a) return false;
      edges.push([a, b], [b, c], [c, a]);
    }
    for (const [a, b] of edges) {
      const key = a * ids.size + b;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    for (const [a, b] of edges) if (!seen.has(b * ids.size + a)) return false;
    return true;
  })();

  /** Squared distance from a point to a node's box, 0 when inside it. */
  const boxDistance2 = (n: number, x: number, y: number, z: number) => {
    const b = n * 6;
    const dx = x < bounds[b] ? bounds[b] - x : x > bounds[b + 3] ? x - bounds[b + 3] : 0;
    const dy = y < bounds[b + 1] ? bounds[b + 1] - y : y > bounds[b + 4] ? y - bounds[b + 4] : 0;
    const dz = z < bounds[b + 2] ? bounds[b + 2] - z : z > bounds[b + 5] ? z - bounds[b + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
  };

  /**
   * How close two triangles have to be to count as equally near.
   *
   * When the closest point falls on an edge or a vertex, every triangle meeting
   * there is exactly as close, and the pseudonormal needs all of them. In exact
   * arithmetic they tie; in doubles they tie to within rounding, and this is
   * that rounding. Distances here are squared and the mesh lives in the unit
   * box, so the absolute slack is worth more than a relative one near zero.
   */
  const TIE = 1e-11;
  /** Triangles found tying for nearest, and how many. */
  const tied = new Int32Array(32);
  let tieCount = 0;
  let bestSquared = Infinity;

  /** Walk the tree for the nearest triangles, filling `tied`. */
  const search = (x: number, y: number, z: number) => {
    bestSquared = Infinity;
    tieCount = 0;
    let top = 0;
    stack[top] = 0;
    queue[top++] = 0;
    while (top) {
      top--;
      if (queue[top] > bestSquared + TIE) continue;
      const n = stack[top];
      const span = link[n * 4 + 3];
      if (link[n * 4] < 0) {
        const from = link[n * 4 + 2];
        for (let i = from; i < from + span; i++) {
          const d = triangleDistance2(corner, i * 9, x, y, z);
          if (d < bestSquared - TIE) {
            bestSquared = d;
            tied[0] = i;
            tieCount = 1;
          } else if (d <= bestSquared + TIE) {
            if (d < bestSquared) bestSquared = d;
            if (tieCount < tied.length) tied[tieCount++] = i;
          }
        }
        continue;
      }
      const a = link[n * 4];
      const b = link[n * 4 + 1];
      const da = boxDistance2(a, x, y, z);
      const db = boxDistance2(b, x, y, z);
      // Nearer child last, so it is popped first and bounds its sibling.
      if (da < db) {
        stack[top] = b;
        queue[top++] = db;
        stack[top] = a;
        queue[top++] = da;
      } else {
        stack[top] = a;
        queue[top++] = da;
        stack[top] = b;
        queue[top++] = db;
      }
    }
    return Math.sqrt(bestSquared);
  };

  const nearest = (x: number, y: number, z: number) =>
    count ? search(x, y, z) : Infinity;

  const winding = (x: number, y: number, z: number) => {
    if (!count) return 0;
    let sum = 0;
    let top = 0;
    stack[top++] = 0;
    while (top) {
      const n = stack[--top];
      const m = n * 6;
      const dx = moment[m + 3] - x;
      const dy = moment[m + 4] - y;
      const dz = moment[m + 5] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = BETA * radius[n];
      if (d2 > reach * reach) {
        // One dipole for the whole node: area-weighted normal against the
        // direction to its centroid, falling off with the square of distance.
        const d = Math.sqrt(d2);
        sum += (moment[m] * dx + moment[m + 1] * dy + moment[m + 2] * dz) / (d * d2);
        continue;
      }
      if (link[n * 4] < 0) {
        const from = link[n * 4 + 2];
        const span = link[n * 4 + 3];
        for (let i = from; i < from + span; i++)
          sum += solidAngle(corner, i * 9, x, y, z);
        continue;
      }
      stack[top++] = link[n * 4];
      stack[top++] = link[n * 4 + 1];
    }
    return sum / (4 * Math.PI);
  };

  /** Scratch for the closest point, written by `search`'s tie list. */
  const near = [0, 0, 0];

  /**
   * The angle-weighted pseudonormal at the point `tied` all agree is closest.
   *
   * Every triangle meeting that point contributes its own unit normal weighted
   * by the angle it subtends there: its interior angle at a shared vertex, a
   * straight angle along a shared edge, a full turn when the point is inside
   * one face. That weighting is exactly what makes the dot product's sign right
   * at a crease, where a bare face normal is right on one side and wrong on the
   * other.
   */
  const pseudonormal = (x: number, y: number, z: number) => {
    // The closest point itself, recovered from the first tying triangle.
    closestPoint(corner, tied[0] * 9, x, y, z, near);
    const qx = near[0], qy = near[1], qz = near[2];
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < tieCount; k++) {
      const t = tied[k] * 9;
      // Equally near is not the same as touching the same point: on the medial
      // axis of a box every face ties, at six different places. Only the
      // triangles that actually meet at `q` belong in its pseudonormal, and the
      // rest are somebody else's equally good answer.
      if (k) {
        closestPoint(corner, t, x, y, z, near);
        if (
          Math.abs(near[0] - qx) > 1e-9 ||
          Math.abs(near[1] - qy) > 1e-9 ||
          Math.abs(near[2] - qz) > 1e-9
        )
          continue;
      }
      const ax = corner[t], ay = corner[t + 1], az = corner[t + 2];
      const bx = corner[t + 3], by = corner[t + 4], bz = corner[t + 5];
      const cx = corner[t + 6], cy = corner[t + 7], cz = corner[t + 8];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const fx = cx - ax, fy = cy - ay, fz = cz - az;
      let gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
      const area = Math.hypot(gx, gy, gz);
      if (area < EPS) continue;
      gx /= area;
      gy /= area;
      gz /= area;
      const weight = subtended(ax, ay, az, bx, by, bz, cx, cy, cz, qx, qy, qz, area);
      nx += gx * weight;
      ny += gy * weight;
      nz += gz * weight;
    }
    return (x - qx) * nx + (y - qy) * ny + (z - qz) * nz;
  };

  return {
    nearest,
    winding,
    distance: (x, y, z) => {
      if (!count) return Infinity;
      const d = search(x, y, z);
      if (d < EPS) return 0;
      if (watertight && tieCount) return pseudonormal(x, y, z) < 0 ? -d : d;
      // Half a turn is the only threshold that means anything on a mesh that
      // is not perfectly closed: a watertight one reports 0 or 1, and one with
      // a hole slides between them, so the midpoint is where "mostly enclosed"
      // stops being true.
      return winding(x, y, z) > 0.5 ? -d : d;
    },
    triangles: count,
    nodes,
    watertight,
  };
}

/**
 * The angle a triangle subtends at a point of its own boundary or interior.
 *
 * A full turn inside the face, a straight angle on an edge, and the interior
 * angle at a corner — the weights the pseudonormal is defined with. `area` is
 * twice the triangle's area, which sets the scale the corner and edge tests
 * measure against so a large triangle and a small one are judged the same way.
 */
function subtended(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  qx: number, qy: number, qz: number,
  area: number,
) {
  const near = Math.sqrt(area) * 1e-7;
  const dax = qx - ax, day = qy - ay, daz = qz - az;
  const dbx = qx - bx, dby = qy - by, dbz = qz - bz;
  const dcx = qx - cx, dcy = qy - cy, dcz = qz - cz;
  const la = Math.hypot(dax, day, daz);
  const lb = Math.hypot(dbx, dby, dbz);
  const lc = Math.hypot(dcx, dcy, dcz);
  if (la < near) return cornerAngle(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
  if (lb < near) return cornerAngle(cx - bx, cy - by, cz - bz, ax - bx, ay - by, az - bz);
  if (lc < near) return cornerAngle(ax - cx, ay - cy, az - cz, bx - cx, by - cy, bz - cz);
  // Otherwise on an edge or inside the face: the sub-triangle an edge makes
  // with `q` collapses exactly when `q` lies on that edge.
  const slack = area * 1e-7;
  if (twiceArea(dax, day, daz, dbx, dby, dbz) < slack) return Math.PI;
  if (twiceArea(dbx, dby, dbz, dcx, dcy, dcz) < slack) return Math.PI;
  if (twiceArea(dcx, dcy, dcz, dax, day, daz) < slack) return Math.PI;
  return 2 * Math.PI;
}

/** The angle between two edge vectors meeting at a corner. */
function cornerAngle(
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
) {
  const lu = Math.hypot(ux, uy, uz) || 1;
  const lv = Math.hypot(vx, vy, vz) || 1;
  const cos = (ux * vx + uy * vy + uz * vz) / (lu * lv);
  return Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
}

/** Twice the area of the triangle two vectors from a shared origin span. */
function twiceArea(
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
) {
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** The point of a triangle nearest `p`, written into `out`. */
function closestPoint(
  c: Float64Array,
  t: number,
  px: number,
  py: number,
  pz: number,
  out: number[],
) {
  const ax = c[t], ay = c[t + 1], az = c[t + 2];
  const bx = c[t + 3], by = c[t + 4], bz = c[t + 5];
  const cx = c[t + 6], cy = c[t + 7], cz = c[t + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az;
    return;
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3 || EPS);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
    return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6 || EPS);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6) || EPS);
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w;
    return;
  }
  const denom = va + vb + vc || EPS;
  const v = vb / denom;
  const w = vc / denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}
