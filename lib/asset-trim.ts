/**
 * Trim the faces nobody can see out of a faceted model.
 *
 * The faceted builder is a kitbash: every part is a closed solid, and parts
 * are pushed into each other to join them. That leaves two kinds of waste. A
 * face buried inside a neighbour costs triangles and never draws. A face that
 * lies exactly on a neighbour's surface — the underside of a box sitting on a
 * slab — draws in the same place as the neighbour and flickers. Both are
 * "clipping" in a game artist's sense, and both are found the same way: every
 * part still has its signed distance field, so a face is hidden when all of
 * its corners and its centre, pushed a hair in front of the face, sit inside some
 * other part — pushed a hair in front of it, so that a face looking straight
 * into a neighbour counts as hidden whether it is deep inside or flush.
 *
 * Only parts that move together may hide each other. Under a rig, a shoulder
 * ball buried in the torso in the bind pose swings out of it in the Walk
 * clip, and the hole where its back was would show. So the test is scoped to
 * a group key — the joint a part is bound to, or its rig part — and a face is
 * trimmed only against parts in the same group. A prop with no rig is one
 * group. A rigged part with no explicit binding is its own group and is never
 * trimmed, because "where will this be in a second" has no answer.
 */
import * as T from 'three';
import { primsOf } from './asset-surface';
import { distanceTo, type Prim } from './asset-sdf';

export type TrimOptions = {
  /** The group a mesh belongs to; faces are trimmed only against the same group. */
  group: (mesh: T.Mesh) => string | null;
  /** How far in front of a face its test points sit, in metres. */
  epsilon?: number;
};

export type TrimReport = { removed: number; kept: number };

const a = new T.Vector3(),
  b = new T.Vector3(),
  c = new T.Vector3(),
  n = new T.Vector3(),
  g = new T.Vector3(),
  p = new T.Vector3();

function insideAny(prims: Prim[], x: number, y: number, z: number) {
  for (const prim of prims) {
    const box = prim.box;
    if (
      x < box.min.x ||
      x > box.max.x ||
      y < box.min.y ||
      y > box.max.y ||
      z < box.min.z ||
      z > box.max.z
    )
      continue;
    if (distanceTo(prim, x, y, z) < 0) return true;
  }
  return false;
}

/**
 * Drop hidden triangles from every mesh in `model`, in place.
 *
 * Meshes are converted to non-indexed geometry, which is what the faceted
 * finishing pass does anyway. Returns how many triangles went and how many
 * stayed, and records the same on `model.userData.trimmed` for the audit.
 */
export function trimHidden(model: T.Object3D, options: TrimOptions): TrimReport {
  model.updateMatrixWorld(true);
  const fallback = new T.Color('#808080');
  const prims = primsOf(model, fallback);
  // Prims and meshes come out of the same traversal in the same order.
  const meshes: T.Mesh[] = [];
  model.traverse((o) => {
    if (o instanceof T.Mesh && o.userData.prim) meshes.push(o);
  });
  if (meshes.length !== prims.length)
    throw Error('trimHidden: primitives and meshes do not line up.');

  const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
  const epsilon =
    options.epsilon ?? Math.max(1e-4, Math.max(size.x, size.y, size.z) * 1e-3);

  // Occluders per group: solid, added parts only. A cut is not a thing you
  // can be inside of, and a plane is too thin to hide anything.
  const groups = new Map<string, Prim[]>();
  const keyOf = new Map<T.Mesh, string | null>();
  meshes.forEach((mesh, i) => {
    const key = options.group(mesh);
    keyOf.set(mesh, key);
    if (key === null) return;
    const prim = prims[i];
    if (prim.subtract || prim.shape === 'plane') return;
    const list = groups.get(key) ?? [];
    list.push(prim);
    groups.set(key, list);
  });

  let removed = 0,
    kept = 0;
  meshes.forEach((mesh, i) => {
    const key = keyOf.get(mesh) ?? null;
    const self = prims[i];
    const occluders = key === null ? [] : (groups.get(key) ?? []).filter((prim) => prim !== self);
    let geometry = mesh.geometry;
    if (geometry.index) {
      const flat = geometry.toNonIndexed();
      geometry.dispose();
      geometry = flat;
      mesh.geometry = flat;
    }
    const position = geometry.attributes.position as T.BufferAttribute;
    const triangles = position.count / 3;
    if (!occluders.length) {
      kept += triangles;
      return;
    }
    const keep: number[] = [];
    for (let t = 0; t < triangles; t++) {
      a.fromBufferAttribute(position, t * 3).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, t * 3 + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, t * 3 + 2).applyMatrix4(mesh.matrixWorld);
      n.subVectors(b, a).cross(p.subVectors(c, a));
      if (n.lengthSq() < 1e-18) continue; // degenerate: drop it too
      // Test points sit a hair in FRONT of the face: a face is hidden when the
      // space it looks out onto is solid, which covers both a face buried in
      // a neighbour and a face lying flat on one.
      n.normalize().multiplyScalar(epsilon);
      g.copy(a).add(b).add(c).divideScalar(3);
      const hidden =
        insideAny(occluders, g.x + n.x, g.y + n.y, g.z + n.z) &&
        insideAny(occluders, a.x + n.x, a.y + n.y, a.z + n.z) &&
        insideAny(occluders, b.x + n.x, b.y + n.y, b.z + n.z) &&
        insideAny(occluders, c.x + n.x, c.y + n.y, c.z + n.z);
      if (hidden) removed++;
      else keep.push(t);
    }
    kept += keep.length;
    if (keep.length === triangles) return;
    const attributes = Object.entries(geometry.attributes) as [string, T.BufferAttribute][];
    const trimmed = new T.BufferGeometry();
    for (const [name, attribute] of attributes) {
      const array = attribute.array;
      const made = new (array.constructor as new (length: number) => typeof array)(
        keep.length * 3 * attribute.itemSize,
      );
      keep.forEach((t, k) => {
        for (let v = 0; v < 3; v++)
          for (let comp = 0; comp < attribute.itemSize; comp++)
            made[(k * 3 + v) * attribute.itemSize + comp] =
              array[(t * 3 + v) * attribute.itemSize + comp];
      });
      trimmed.setAttribute(name, new T.BufferAttribute(made, attribute.itemSize, attribute.normalized));
    }
    trimmed.userData = geometry.userData;
    geometry.dispose();
    mesh.geometry = trimmed;
  });

  model.userData.trimmed = { removed, kept };
  return { removed, kept };
}
