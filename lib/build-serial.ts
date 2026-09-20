import * as T from 'three';

/**
 * A built model, flattened into something `postMessage` can carry.
 *
 * The builder runs in a worker now, and a `T.Object3D` does not survive the
 * structured clone: it is a graph of class instances holding typed arrays,
 * shared materials, and a skeleton whose bones are nodes of the same tree.
 * This is that graph written down — arrays by reference so they can be
 * transferred rather than copied, materials and geometries by index so the
 * sharing the builder set up survives the trip, and bones by index into the
 * tree's own pre-order so a `SkinnedMesh` comes back bound to the same bones.
 *
 * What the round trip has to preserve is everything anything downstream reads:
 * `stats` counts meshes, triangles, bones and *distinct materials*; the audit
 * reads `userData.specPath`, `userData.spec`, `geometry.userData.rigParts` and
 * `surfaceOwners`; the viewport reads `userData.rigPart`, `userData.prim` and
 * `userData.surface`; the exporters read `geometry.userData.uvLayout` and the
 * skinning. `tests/build-client.test.ts` holds all of that to a direct build.
 */

type ArrayKind = 'f32' | 'u32' | 'u16' | 'u8' | 'i16';

type SerialAttribute = {
  kind: ArrayKind;
  array: ArrayBufferView;
  itemSize: number;
  normalized: boolean;
};

type SerialGeometry = {
  attributes: [string, SerialAttribute][];
  index: SerialAttribute | null;
  /** `uvLayout`, `rigParts`, `surfaceOwners` — all plain data already. */
  userData: Record<string, unknown>;
};

type SerialMaterial = {
  name: string;
  color: number;
  roughness: number;
  metalness: number;
  opacity: number;
  transparent: boolean;
  flatShading: boolean;
  vertexColors: boolean;
  side: T.Side;
};

type SerialSkeleton = {
  /** Pre-order indices of the bones, in skeleton order. */
  bones: number[];
  /** 16 numbers per bone. */
  boneInverses: number[];
  bindMatrix: number[];
  bindMode: string;
};

type SerialObject = {
  kind: 'group' | 'mesh' | 'skinned' | 'bone' | 'object';
  name: string;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  /** Local transform, as three stores it. */
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  userData: Record<string, unknown>;
  geometry?: number;
  material?: number;
  skeleton?: SerialSkeleton;
  children: SerialObject[];
};

export type SerialModel = {
  root: SerialObject;
  geometries: SerialGeometry[];
  materials: SerialMaterial[];
};

function kindOf(array: ArrayBufferView): ArrayKind {
  if (array instanceof Float32Array) return 'f32';
  if (array instanceof Uint32Array) return 'u32';
  if (array instanceof Uint16Array) return 'u16';
  if (array instanceof Uint8Array) return 'u8';
  if (array instanceof Int16Array) return 'i16';
  throw Error(`Cannot serialise a ${array.constructor.name} attribute.`);
}

function revive(attribute: SerialAttribute): T.BufferAttribute {
  const { array } = attribute;
  const typed =
    attribute.kind === 'f32'
      ? new Float32Array(array.buffer, array.byteOffset, array.byteLength / 4)
      : attribute.kind === 'u32'
        ? new Uint32Array(array.buffer, array.byteOffset, array.byteLength / 4)
        : attribute.kind === 'u16'
          ? new Uint16Array(array.buffer, array.byteOffset, array.byteLength / 2)
          : attribute.kind === 'i16'
            ? new Int16Array(array.buffer, array.byteOffset, array.byteLength / 2)
            : new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  return new T.BufferAttribute(typed, attribute.itemSize, attribute.normalized);
}

/**
 * Every buffer the message carries, for the transfer list.
 *
 * Transferring is what makes a 12 MB surface mesh free to hand over instead of
 * a second copy on each side. A view that does not cover its whole buffer is
 * left out: transferring it would detach bytes something else still owns, and
 * the copy costs less than that bug.
 */
export function transfersOf(model: SerialModel): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const take = (attribute: SerialAttribute | null) => {
    if (!attribute) return;
    const { array } = attribute;
    if (array.byteOffset !== 0 || array.byteLength !== array.buffer.byteLength)
      return;
    buffers.add(array.buffer as ArrayBuffer);
  };
  for (const geometry of model.geometries) {
    for (const [, attribute] of geometry.attributes) take(attribute);
    take(geometry.index);
    // `surfaceOwners.index` is a Uint16Array the audit reads; it rides along.
    const owners = geometry.userData.surfaceOwners as
      | { index?: ArrayBufferView }
      | undefined;
    if (owners?.index && owners.index.byteOffset === 0)
      buffers.add(owners.index.buffer as ArrayBuffer);
    // And the baked atlas, which is megabytes of texels and the one thing in
    // this message that would actually hurt to copy.
    const maps = geometry.userData.bakedMaps as
      | Record<string, ArrayBufferView | number>
      | undefined;
    if (maps)
      for (const value of Object.values(maps))
        if (typeof value !== 'number' && value.byteOffset === 0)
          buffers.add(value.buffer as ArrayBuffer);
  }
  return [...buffers];
}

export function serializeModel(root: T.Object3D): SerialModel {
  const geometries: SerialGeometry[] = [];
  const materials: SerialMaterial[] = [];
  const geometryIds = new Map<T.BufferGeometry, number>();
  const materialIds = new Map<T.Material, number>();
  const indices = new Map<T.Object3D, number>();

  // Pre-order, which is also the order `deserializeModel` rebuilds in, so a
  // bone's index means the same thing on both sides.
  let next = 0;
  root.traverse((object) => indices.set(object, next++));

  const attribute = (source: T.BufferAttribute): SerialAttribute => ({
    kind: kindOf(source.array as ArrayBufferView),
    array: source.array as ArrayBufferView,
    itemSize: source.itemSize,
    normalized: source.normalized,
  });

  const geometryId = (geometry: T.BufferGeometry): number => {
    const seen = geometryIds.get(geometry);
    if (seen !== undefined) return seen;
    const id = geometries.length;
    geometryIds.set(geometry, id);
    geometries.push({
      attributes: Object.entries(geometry.attributes).map(([name, source]) => [
        name,
        attribute(source as T.BufferAttribute),
      ]),
      index: geometry.index ? attribute(geometry.index) : null,
      userData: geometry.userData as Record<string, unknown>,
    });
    return id;
  };

  const materialId = (material: T.Material): number => {
    const seen = materialIds.get(material);
    if (seen !== undefined) return seen;
    const standard = material as T.MeshStandardMaterial;
    const id = materials.length;
    materialIds.set(material, id);
    materials.push({
      name: material.name,
      color: standard.color ? standard.color.getHex() : 0xffffff,
      roughness: standard.roughness ?? 1,
      metalness: standard.metalness ?? 0,
      opacity: material.opacity,
      transparent: material.transparent,
      flatShading: standard.flatShading ?? false,
      vertexColors: material.vertexColors,
      side: material.side,
    });
    return id;
  };

  const write = (object: T.Object3D): SerialObject => {
    const mesh = object as T.Mesh;
    const skinned = object as T.SkinnedMesh;
    const out: SerialObject = {
      kind:
        object instanceof T.SkinnedMesh
          ? 'skinned'
          : object instanceof T.Bone
            ? 'bone'
            : object instanceof T.Mesh
              ? 'mesh'
              : object instanceof T.Group
                ? 'group'
                : 'object',
      name: object.name,
      visible: object.visible,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      renderOrder: object.renderOrder,
      position: object.position.toArray() as [number, number, number],
      quaternion: object.quaternion.toArray() as [number, number, number, number],
      scale: object.scale.toArray() as [number, number, number],
      userData: object.userData as Record<string, unknown>,
      children: object.children.map(write),
    };
    if (object instanceof T.Mesh) {
      out.geometry = geometryId(mesh.geometry as T.BufferGeometry);
      // Only ever one material per mesh in this pipeline; an array would need
      // a group list to go with it, and nothing here makes one.
      if (Array.isArray(mesh.material))
        throw Error('Cannot serialise a mesh with a material array.');
      out.material = materialId(mesh.material as T.Material);
    }
    if (object instanceof T.SkinnedMesh) {
      const skeleton = skinned.skeleton;
      const inverses: number[] = [];
      for (const matrix of skeleton.boneInverses) inverses.push(...matrix.elements);
      out.skeleton = {
        bones: skeleton.bones.map((bone) => {
          const at = indices.get(bone);
          if (at === undefined)
            throw Error('A skinned mesh is bound to a bone outside its model.');
          return at;
        }),
        boneInverses: inverses,
        bindMatrix: [...skinned.bindMatrix.elements],
        bindMode: skinned.bindMode,
      };
    }
    return out;
  };

  return { root: write(root), geometries, materials };
}

export function deserializeModel(model: SerialModel): T.Object3D {
  const geometries = model.geometries.map((source) => {
    const geometry = new T.BufferGeometry();
    for (const [name, attribute] of source.attributes)
      geometry.setAttribute(name, revive(attribute));
    if (source.index) geometry.setIndex(revive(source.index));
    geometry.userData = source.userData;
    return geometry;
  });
  const materials = model.materials.map((source) => {
    const material = new T.MeshStandardMaterial({
      color: source.color,
      roughness: source.roughness,
      metalness: source.metalness,
      flatShading: source.flatShading,
      vertexColors: source.vertexColors,
    });
    material.name = source.name;
    material.opacity = source.opacity;
    material.transparent = source.transparent;
    material.side = source.side;
    return material;
  });

  const flat: T.Object3D[] = [];
  const pending: { mesh: T.SkinnedMesh; skeleton: SerialSkeleton }[] = [];

  const read = (source: SerialObject): T.Object3D => {
    let object: T.Object3D;
    if (source.kind === 'skinned') {
      const mesh = new T.SkinnedMesh(
        geometries[source.geometry!],
        materials[source.material!],
      );
      pending.push({ mesh, skeleton: source.skeleton! });
      object = mesh;
    } else if (source.kind === 'mesh') {
      object = new T.Mesh(geometries[source.geometry!], materials[source.material!]);
    } else if (source.kind === 'bone') {
      object = new T.Bone();
    } else if (source.kind === 'group') {
      object = new T.Group();
    } else {
      object = new T.Object3D();
    }
    // Pushed before the children, so the numbering matches `serializeModel`'s
    // pre-order traversal.
    flat.push(object);
    object.name = source.name;
    object.visible = source.visible;
    object.castShadow = source.castShadow;
    object.receiveShadow = source.receiveShadow;
    object.renderOrder = source.renderOrder;
    object.position.fromArray(source.position);
    object.quaternion.fromArray(source.quaternion);
    object.scale.fromArray(source.scale);
    object.userData = source.userData;
    for (const child of source.children) object.add(read(child));
    return object;
  };

  const root = read(model.root);
  root.updateMatrixWorld(true);
  for (const { mesh, skeleton } of pending) {
    const bones = skeleton.bones.map((at) => flat[at] as T.Bone);
    const inverses = [];
    for (let i = 0; i < bones.length; i++)
      inverses.push(
        new T.Matrix4().fromArray(skeleton.boneInverses, i * 16),
      );
    // Rebuilt from the recorded inverses rather than recomputed from the
    // bones: `new T.Skeleton(bones)` derives them from whatever world matrices
    // the bones happen to hold, which is the bind pose only by luck.
    mesh.bindMode = skeleton.bindMode as T.SkinnedMesh['bindMode'];
    mesh.bind(
      new T.Skeleton(bones, inverses),
      new T.Matrix4().fromArray(skeleton.bindMatrix),
    );
  }
  return root;
}
