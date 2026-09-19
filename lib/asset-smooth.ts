/**
 * Surface finishing: shade a fused mesh with hard edges only where the
 * geometry actually has one.
 *
 * A decimated shell at a game budget is genuinely faceted — on a 1.7 m
 * character at 9,000 triangles neighbouring faces turn about 16 degrees on
 * average — and flat shading draws every one of those facets as a tile, so a
 * curved pauldron reads as a mosaic. The surface underneath is fine: surface
 * nets land within a fraction of a cell of the field, and a smoothing pass
 * over the vertices (Taubin, tried before and after decimation) measurably
 * widened the spread of facet angles rather than narrowing it. What the eye
 * wants is not moved vertices but honest normals.
 *
 * `creaseSplit` gives the mesh those: a vertex's triangles are grouped by how
 * much they turn, faces that meet under the crease angle share one smooth
 * normal, and a vertex on a sharper edge is duplicated so each side keeps its
 * own. That is Blender's auto-smooth, and it exports the same way it renders.
 */
import * as T from 'three';

/** Copy an attribute so that new vertex `i` is old vertex `order[i]`. */
function reorder(source: T.BufferAttribute, order: Uint32Array) {
  const array = source.array;
  const made = new (array.constructor as new (length: number) => typeof array)(
    order.length * source.itemSize,
  );
  for (let i = 0; i < order.length; i++)
    for (let c = 0; c < source.itemSize; c++)
      made[i * source.itemSize + c] = array[order[i] * source.itemSize + c];
  return new T.BufferAttribute(made, source.itemSize, source.normalized);
}

/**
 * Split vertices at creases and give every vertex a normal.
 *
 * `degrees` is the crease angle: two triangles that meet under it share a
 * smooth normal, two that turn harder keep their own. 0 splits every edge,
 * which is flat shading with the normals written down; 180 splits none, which
 * is `computeVertexNormals`. The index keeps its triangle order, so anything
 * keyed by triangle (material groups, the uv plan) stays valid, and the
 * per-vertex records on `userData` — `rigParts`, `surfaceOwners.index` — are
 * carried across to the split vertices. `userData.creaseSource` maps each new
 * vertex to the welded one it came from.
 */
export function creaseSplit(
  geometry: T.BufferGeometry,
  degrees: number,
): T.BufferGeometry {
  const index = geometry.index;
  const position = geometry.attributes.position as T.BufferAttribute;
  if (!index) throw Error('creaseSplit needs an indexed mesh.');
  const indices = index.array as Uint32Array | Uint16Array;
  const count = position.count;
  const faces = index.count / 3;
  const cos = Math.cos((Math.min(180, Math.max(0, degrees)) * Math.PI) / 180);

  // Area-weighted face normals.
  const faceNormal = new Float32Array(faces * 3);
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let t = 0; t < faces; t++) {
    a.fromBufferAttribute(position, indices[t * 3]);
    b.fromBufferAttribute(position, indices[t * 3 + 1]);
    c.fromBufferAttribute(position, indices[t * 3 + 2]);
    b.sub(a);
    c.sub(a);
    a.crossVectors(b, c);
    faceNormal[t * 3] = a.x;
    faceNormal[t * 3 + 1] = a.y;
    faceNormal[t * 3 + 2] = a.z;
  }

  // Vertex → incident corners, compressed.
  const offset = new Uint32Array(count + 1);
  for (let i = 0; i < index.count; i++) offset[indices[i] + 1]++;
  for (let i = 0; i < count; i++) offset[i + 1] += offset[i];
  const fill = offset.slice(0, count);
  const corners = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) corners[fill[indices[i]]++] = i;

  const next = new Uint32Array(index.count);
  const order: number[] = [];
  const normals: number[] = [];
  // Per vertex: greedy clusters of its faces by angle to the running mean.
  const sums: number[] = [];
  for (let v = 0; v < count; v++) {
    sums.length = 0;
    const first = order.length;
    for (let k = offset[v]; k < offset[v + 1]; k++) {
      const corner = corners[k];
      const t = (corner / 3) | 0;
      const nx = faceNormal[t * 3],
        ny = faceNormal[t * 3 + 1],
        nz = faceNormal[t * 3 + 2];
      const len = Math.hypot(nx, ny, nz) || 1;
      let cluster = -1;
      for (let s = 0; s < sums.length; s += 3) {
        const sx = sums[s],
          sy = sums[s + 1],
          sz = sums[s + 2];
        const slen = Math.hypot(sx, sy, sz) || 1;
        const dot = (nx * sx + ny * sy + nz * sz) / (len * slen);
        if (dot >= cos) {
          cluster = s / 3;
          break;
        }
      }
      if (cluster < 0) {
        cluster = sums.length / 3;
        sums.push(0, 0, 0);
        order.push(v);
      }
      sums[cluster * 3] += nx;
      sums[cluster * 3 + 1] += ny;
      sums[cluster * 3 + 2] += nz;
      next[corner] = first + cluster;
    }
    for (let s = 0; s < sums.length; s += 3) {
      const len = Math.hypot(sums[s], sums[s + 1], sums[s + 2]) || 1;
      normals.push(sums[s] / len, sums[s + 1] / len, sums[s + 2] / len);
    }
  }
  const map = Uint32Array.from(order);

  const split = new T.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name === 'normal') continue;
    if (!(attribute instanceof T.BufferAttribute))
      throw Error(`Cannot split interleaved attribute "${name}" at creases.`);
    split.setAttribute(name, reorder(attribute, map));
  }
  split.setAttribute(
    'normal',
    new T.BufferAttribute(Float32Array.from(normals), 3),
  );
  split.setIndex(new T.BufferAttribute(next, 1));
  for (const group of geometry.groups)
    split.addGroup(group.start, group.count, group.materialIndex);

  split.userData = { ...geometry.userData };
  const rigParts = geometry.userData.rigParts as
    | (string | undefined)[]
    | undefined;
  if (rigParts) split.userData.rigParts = Array.from(map, (v) => rigParts[v]);
  const owners = geometry.userData.surfaceOwners as
    | { index: Uint16Array; paths: unknown; subtract?: boolean[] }
    | undefined;
  if (owners)
    split.userData.surfaceOwners = {
      ...owners,
      index: Uint16Array.from(map, (v) => owners.index[v]),
    };
  split.userData.creaseSource = map;
  return split;
}

/**
 * Canonical vertex ids by position, for topology checks on a mesh whose
 * vertices were split for normals or uvs. Two vertices within a nanometre
 * of each other are the same point.
 */
export function weldByPosition(geometry: T.BufferGeometry): Uint32Array {
  const position = geometry.attributes.position as T.BufferAttribute;
  const canon = new Uint32Array(position.count);
  const seen = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = `${Math.round(position.getX(i) * 1e6)},${Math.round(position.getY(i) * 1e6)},${Math.round(position.getZ(i) * 1e6)}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      canon[i] = i;
    } else canon[i] = first;
  }
  return canon;
}
