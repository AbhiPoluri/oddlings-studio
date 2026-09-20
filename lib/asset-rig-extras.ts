import * as T from 'three';
import { boneLayout } from './asset-joints';
import type { AssetSpec } from './asset-spec';

/**
 * The skeleton, written into the GLB so a game never needs a sidecar.
 *
 * A GLB already carries the bones — but only as a bind pose an engine walks by
 * name, and a game that wants to plant a foot, aim a leg or drive a chain has
 * to know which bones form that chain and where the limb actually ends. Both
 * of the shipped demos answered that with a hand-written JSON file beside the
 * model, which drifts the moment anyone edits the spec. These extras are the
 * same answer derived from the spec and the built geometry, travelling inside
 * the file that they describe.
 *
 * Everything is in model space, in metres, before the spec's display scale —
 * the same space `boneLayout` and the bind pose use, so a pivot here lands on
 * the bone of the same name in the GLB. `scale` is the multiplier the root
 * node carries; multiply by it for world space.
 */
export type RigExtras = {
  version: 1;
  units: 'm';
  /** `spec.scale`: the root node's scale, which these numbers are all before. */
  scale: number;
  /** The body the chains hang off, repeated from `bones[0]` for convenience. */
  root: { name: string; at: Vec3 };
  bones: RigBone[];
  /** One per leaf, root first, so a game can walk a limb without a parent map. */
  chains: { leaf: string; bones: string[] }[];
};

export type Vec3 = [number, number, number];

export type RigBone = {
  name: string;
  /** Skeleton index — the number this bone's skin weights point at. */
  index: number;
  /** Null for the root only; otherwise a name in this same list. */
  parent: string | null;
  /** Pivot, model space. */
  at: Vec3;
  /**
   * Leaf bones only: how far the geometry bound to this bone reaches along
   * the chain — the sole below an ankle, the top of a head, the hand at the
   * end of a forearm. Null when nothing is bound to it.
   */
  end?: Vec3 | null;
};

/**
 * Float32 geometry reads back as 0.30000001192, and the same number has to
 * survive a JSON round trip to compare equal. A tenth of a millimetre is finer
 * than anything a spec authors. `|| 0` folds -0 onto 0, which JSON does anyway.
 */
function round(value: number) {
  return Math.round(value * 1e4) / 1e4 || 0;
}

function triple(v: T.Vector3): Vec3 {
  return [round(v.x), round(v.y), round(v.z)];
}

/** What a leaf bone is looking for: how far its geometry reaches, and from where. */
type Reach = {
  pivot: T.Vector3;
  /** Down the chain from the parent. Null when the pivot sits on its parent. */
  along: T.Vector3 | null;
  best: number;
  found: T.Vector3 | null;
};

/**
 * Measure how far each leaf bone's bound geometry reaches down its chain.
 *
 * Read off the skin weights rather than the part tree: that is the one place
 * both rigs and both build backends agree. `rigCreature` blends each vertex
 * between two bones and `rigJoints` pins it to one, faceted mode binds a mesh
 * at a time and surface mode a vertex at a time — but all four end up as
 * skinIndex/skinWeight on geometry the rigger already baked into model space,
 * so the strongest weight is the bone a vertex belongs to in every case.
 */
function reachOf(model: T.Object3D, wanted: Map<number, Reach>) {
  const at = new T.Vector3();
  model.traverse((object) => {
    if (!(object instanceof T.SkinnedMesh)) return;
    const { position, skinIndex, skinWeight } = object.geometry.attributes;
    if (!position || !skinIndex || !skinWeight) return;
    for (let i = 0; i < position.count; i++) {
      let bone = -1;
      let weight = 0;
      for (const slot of ['getX', 'getY', 'getZ', 'getW'] as const) {
        const w = skinWeight[slot](i);
        if (w > weight) {
          weight = w;
          bone = skinIndex[slot](i);
        }
      }
      const reach = wanted.get(bone);
      if (!reach) continue;
      at.set(position.getX(i), position.getY(i), position.getZ(i));
      // Along the chain, the far tip is the largest projection onto it. The
      // vertex that wins is not the answer — a sole has four corners tied for
      // lowest, and which one a mesher happens to emit first is noise that
      // differs between the faceted and the fused backend. The projection is
      // the same point either way: straight down the bone, at the far face.
      const score = reach.along
        ? at.dot(reach.along)
        : at.distanceToSquared(reach.pivot);
      if (reach.found && score <= reach.best) continue;
      reach.best = score;
      // A bone whose pivot sits on its parent has no chain direction to
      // project onto, so the farthest bound vertex itself is the best tip
      // available. Rare: it takes a spec that stacks two joints on one point.
      reach.found = reach.along
        ? reach.pivot
            .clone()
            .addScaledVector(reach.along, score - reach.pivot.dot(reach.along))
        : at.clone();
    }
  });
}

/**
 * The rig of a built spec, as plain JSON for `extras.oddlings` in the GLB.
 *
 * `model` is the finished, skinned model the spec built: the pivots come from
 * the spec, but where a limb *ends* is a fact about the geometry that was
 * bound to it, and only the built model knows that. Returns undefined for
 * anything with no skeleton — a static spec, or a blueprint recipe — so the
 * exporter's hook writes no extras rather than an empty block.
 */
export function rigExtras(
  spec: AssetSpec | undefined,
  model: T.Object3D,
): RigExtras | undefined {
  if (!spec) return undefined;
  const layout = boneLayout(spec);
  if (!layout.length) return undefined;

  const index = new Map(layout.map((bone, at) => [bone.name, at]));
  const parents = new Set(layout.map((bone) => bone.parent).filter(Boolean));
  const wanted = new Map<number, Reach>();
  layout.forEach((bone, at) => {
    if (parents.has(bone.name)) return;
    const pivot = new T.Vector3(...bone.at);
    const parent =
      bone.parent === null ? null : layout[index.get(bone.parent)!];
    const along = parent
      ? pivot.clone().sub(new T.Vector3(...parent.at))
      : new T.Vector3();
    wanted.set(at, {
      pivot,
      along: along.lengthSq() > 1e-12 ? along.normalize() : null,
      best: -Infinity,
      found: null,
    });
  });
  reachOf(model, wanted);

  const chain = (leaf: string) => {
    const names: string[] = [];
    for (let name: string | null = leaf; name !== null;) {
      names.unshift(name);
      name = layout[index.get(name)!].parent;
    }
    return names;
  };

  return {
    version: 1,
    units: 'm',
    scale: spec.scale,
    root: { name: layout[0].name, at: triple(new T.Vector3(...layout[0].at)) },
    bones: layout.map((bone, at) => {
      const reach = wanted.get(at);
      return {
        name: bone.name,
        index: at,
        parent: bone.parent,
        at: triple(new T.Vector3(...bone.at)),
        ...(reach ? { end: reach.found ? triple(reach.found) : null } : {}),
      };
    }),
    chains: [...wanted.keys()].map((at) => ({
      leaf: layout[at].name,
      bones: chain(layout[at].name),
    })),
  };
}
