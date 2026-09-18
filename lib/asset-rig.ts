import * as T from 'three';
export const JOINTS = [
  'Root',
  'Hips',
  'Spine',
  'Head',
  'Arm_L',
  'Forearm_L',
  'Arm_R',
  'Forearm_R',
  'Thigh_L',
  'Shin_L',
  'Foot_L',
  'Thigh_R',
  'Shin_R',
  'Foot_R',
] as const;
/** The 14 bones a humanoid rig has, and the only names an override may use. */
export type BoneName = (typeof JOINTS)[number];
export type RigSettings = {
  hipHeight: number;
  headPivot: number;
  shoulderWidth: number;
  /**
   * Absolute model-space positions for individual bones, replacing whatever
   * the three measurements derived.
   *
   * Three numbers describe a body well enough to get a skeleton roughly right,
   * and never well enough to get one exactly right: a long-armed goblin or a
   * head sitting forward of the spine has no expression in hipHeight,
   * headPivot and shoulderWidth. An override says where one bone actually
   * goes. It is absolute rather than a delta so that a hand-editor can write
   * back the position it just dragged a handle to, and mirroring is the
   * author's business — setting `Arm_L` does not move `Arm_R`.
   */
  bones?: Partial<Record<BoneName, [number, number, number]>>;
};
export const defaultRig: RigSettings = {
  hipHeight: 0.48,
  headPivot: 0.9,
  shoulderWidth: 0.28,
};
/**
 * Which bone each of `JOINTS` hangs off, by index; the root hangs off nothing.
 *
 * `JOINTS` is ordered parent before child, which is what lets the layout below
 * resolve every absolute position in one forward pass.
 */
const BONE_PARENT: readonly (number | null)[] = [
  null, 0, 1, 2, 2, 4, 2, 6, 1, 8, 9, 1, 11, 12,
];

/** Where a bone sits relative to its parent before any override. */
function restOffsets(settings: RigSettings) {
  const local: [number, number, number][] = JOINTS.map(() => [0, 0, 0]);
  local[1] = [0, settings.hipHeight, 0];
  local[2] = [0, 0.1, 0];
  local[3] = [0, settings.headPivot - settings.hipHeight - 0.1, 0];
  // +Z is the front, so a character's own left is +x. Every shipped spec put
  // its `_l` parts there; the bones used to sit on the other side, which Walk
  // hid (a swing about x does not care which side you are on) and Wave did
  // not (the arm lifted about a pivot across the body).
  for (const [side, arm, thigh] of [
    [1, 4, 8],
    [-1, 6, 11],
  ]) {
    local[arm] = [side * settings.shoulderWidth, 0, 0];
    local[arm + 1] = [side * 0.09, -0.12, 0.025];
    local[thigh] = [side * 0.16, 0.34 - settings.hipHeight, 0];
    local[thigh + 1] = [side * 0.015, -0.15, 0.015];
    local[thigh + 2] = [side * 0.015, -0.14, 0.055];
  }
  return local;
}

export type BonePlacement = {
  name: BoneName;
  parent: BoneName | null;
  /** Model space, before the spec's display scale. */
  at: [number, number, number];
};

/**
 * The skeleton a rig block describes, in model space, overrides applied.
 *
 * Pure, and the single source of truth for bone positions: `rigCreature`
 * builds its hierarchy from this, and `boneLayout` hands the same numbers to
 * anything that wants to draw a handle on a bone without building the model.
 * Returned in `JOINTS` order, so entry `i` is skeleton bone `i`.
 */
export function rigBoneLayout(settings: RigSettings = defaultRig) {
  const local = restOffsets(settings);
  const placed: BonePlacement[] = [];
  JOINTS.forEach((name, index) => {
    const parent = BONE_PARENT[index];
    // Safe because JOINTS lists a parent before its children.
    const base = parent === null ? [0, 0, 0] : placed[parent].at;
    const override = settings.bones?.[name];
    placed.push({
      name,
      parent: parent === null ? null : JOINTS[parent],
      at: override
        ? [override[0], override[1], override[2]]
        : [
            base[0] + local[index][0],
            base[1] + local[index][1],
            base[2] + local[index][2],
          ],
    });
  });
  return placed;
}
/**
 * Where automatic skin weighting puts an unpinned part, by the position of its
 * centre. These are absolute metres, not derived from the rig settings, which
 * is why auto-weighting only suits a character of roughly human-ish height at
 * the origin. The audit reads the same numbers so the two can never drift.
 */
export const AUTO_WEIGHT = {
  /** Above this height a part follows the head. */
  head: 0.82,
  /** Below this height a part follows the nearer leg. */
  legs: 0.36,
  /** Wider than this from the centre line a part follows the nearer arm. */
  arms: 0.28,
  /** The height range these thresholds were tuned for. */
  designedFor: [0.7, 1.5] as [number, number],
};

/** The bone an unpinned part at this centre will be weighted to. */
export function autoBone(centre: { x: number; y: number }) {
  if (centre.y > AUTO_WEIGHT.head) return 'Head';
  if (centre.y < AUTO_WEIGHT.legs)
    return centre.x > 0 ? 'Thigh_L' : 'Thigh_R';
  if (Math.abs(centre.x) > AUTO_WEIGHT.arms)
    return centre.x > 0 ? 'Arm_L' : 'Arm_R';
  return 'Spine';
}

export function rigCreature(
  source: T.Group,
  settings: RigSettings = defaultRig,
) {
  const model = new T.Group();
  model.name = source.name;
  model.userData = source.userData;
  const layout = rigBoneLayout(settings);
  const bones = layout.map((place) => {
    const b = new T.Bone();
    b.name = place.name;
    return b;
  });
  // The layout is absolute; a bone's `position` is relative to its parent, so
  // an override on a parent carries its children along rather than stretching
  // the limb away from them.
  layout.forEach((place, index) => {
    const parent = BONE_PARENT[index];
    const base = parent === null ? [0, 0, 0] : layout[parent].at;
    bones[index].position.set(
      place.at[0] - base[0],
      place.at[1] - base[1],
      place.at[2] - base[2],
    );
    if (parent !== null) bones[parent].add(bones[index]);
  });
  model.add(bones[0]);
  model.updateMatrixWorld(true);
  const skeleton = new T.Skeleton(bones);
  skeleton.calculateInverses();
  source.updateMatrixWorld(true);
  source.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    const position = geometry.attributes.position;
    const ids: number[] = [],
      weights: number[] = [];
    const meshCenter = new T.Box3()
      .setFromBufferAttribute(position as T.BufferAttribute)
      .getCenter(new T.Vector3());
    // A surface-mode asset is one mesh covering the whole body, so binding it
    // by the mesh's own centre would weight the entire creature to a single
    // bone. It carries the bone each vertex's source primitive was pinned to
    // instead, and unpinned vertices fall back to their own position rather
    // than to the centre of everything.
    const perVertex = geometry.userData.rigParts as
      | (string | undefined)[]
      | undefined;
    const partCenter = new T.Vector3();
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (perVertex)
        partCenter.set(position.getX(i), y, position.getZ(i));
      else partCenter.copy(meshCenter);
      let a = 1,
        b = 1,
        t = 0;
      const named: Record<string, number> = {
        head: 3,
        spine: 2,
        hips: 1,
        arm_l: 4,
        forearm_l: 5,
        arm_r: 6,
        forearm_r: 7,
        thigh_l: 8,
        shin_l: 9,
        foot_l: 10,
        thigh_r: 11,
        shin_r: 12,
        foot_r: 13,
      };
      const explicit =
        named[
          String(perVertex ? perVertex[i] : object.userData.rigPart)
        ];
      if (explicit !== undefined) {
        a = explicit;
        b = explicit;
      } else if (partCenter.y > AUTO_WEIGHT.head) {
        a = 3;
        b = 3;
      } else if (partCenter.y < AUTO_WEIGHT.legs) {
        const thigh = partCenter.x < 0 ? 8 : 11;
        if (y > 0.19) {
          a = thigh;
          b = thigh + 1;
          t = T.MathUtils.clamp((0.3 - y) / 0.11, 0, 1);
        } else {
          a = thigh + 1;
          b = thigh + 2;
          t = T.MathUtils.clamp((0.14 - y) / 0.1, 0, 1);
        }
      } else if (Math.abs(partCenter.x) > AUTO_WEIGHT.arms) {
        a = partCenter.x < 0 ? 4 : 6;
        b = a + 1;
        t = T.MathUtils.clamp((0.52 - y) / 0.14, 0, 1);
      } else {
        a = 1;
        b = 2;
        t = T.MathUtils.clamp((y - 0.4) / 0.22, 0, 1);
      }
      ids.push(a, b, 0, 0);
      weights.push(1 - t, t, 0, 0);
    }
    geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(ids, 4));
    geometry.setAttribute(
      'skinWeight',
      new T.Float32BufferAttribute(weights, 4),
    );
    const skinned = new T.SkinnedMesh(geometry, object.material);
    skinned.name = object.name;
    // Carry the source mesh's metadata across. Without this a rigged asset
    // loses `specPath` and `rigPart`, which silently disables the editor's
    // part selection and every audit check that groups meshes by part.
    skinned.userData = { ...object.userData };
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    model.add(skinned);
    skinned.bind(skeleton, new T.Matrix4());
    object.geometry.dispose();
  });
  model.updateMatrixWorld(true);
  return model;
}
function rotations(
  name: string,
  times: number[],
  angles: number[],
  axis: 'x' | 'y' | 'z' = 'x',
) {
  const q = new T.Quaternion(),
    a = new T.Vector3(
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0,
    );
  return new T.QuaternionKeyframeTrack(
    `${name}.quaternion`,
    times,
    angles.flatMap((angle) => {
      q.setFromAxisAngle(a, angle);
      return q.toArray();
    }),
  );
}
export function rigClips(): T.AnimationClip[] {
  const times = [0, 0.25, 0.5, 0.75, 1];
  const walk = new T.AnimationClip('Walk', 1, [
    rotations('Thigh_L', times, [0.48, 0, -0.48, 0, 0.48]),
    rotations('Thigh_R', times, [-0.48, 0, 0.48, 0, -0.48]),
    rotations('Shin_L', times, [0.1, 0.55, 0.05, 0, 0.1]),
    rotations('Shin_R', times, [0.05, 0, 0.1, 0.55, 0.05]),
    rotations('Arm_L', times, [-0.25, 0, 0.25, 0, -0.25]),
    rotations('Arm_R', times, [0.25, 0, -0.25, 0, 0.25]),
    rotations('Head', times, [0.025, -0.025, 0.025, -0.025, 0.025], 'z'),
    new T.VectorKeyframeTrack(
      'Root.position',
      times,
      [0, 0, 0, 0, 0.045, 0, 0, 0, 0, 0, 0.045, 0, 0, 0, 0],
    ),
  ]);
  const idle = new T.AnimationClip('Idle', 3, [
    rotations('Head', [0, 1.5, 3], [-0.035, 0.035, -0.035], 'z'),
    rotations('Arm_L', [0, 1.5, 3], [0.03, -0.04, 0.03], 'z'),
    rotations('Arm_R', [0, 1.5, 3], [-0.03, 0.04, -0.03], 'z'),
    new T.VectorKeyframeTrack(
      'Spine.scale',
      [0, 1.5, 3],
      [1, 1, 1, 1.025, 1.035, 1.025, 1, 1, 1],
    ),
  ]);
  const jumpTimes = [0, 0.18, 0.42, 0.68, 1];
  const jump = new T.AnimationClip('Jump', 1, [
    rotations('Thigh_L', jumpTimes, [0, 0.48, -0.22, -0.05, 0]),
    rotations('Thigh_R', jumpTimes, [0, 0.48, -0.22, -0.05, 0]),
    rotations('Shin_L', jumpTimes, [0, -0.62, 0.18, 0.08, 0]),
    rotations('Shin_R', jumpTimes, [0, -0.62, 0.18, 0.08, 0]),
    rotations('Arm_L', jumpTimes, [0, 0.25, -0.85, -0.22, 0]),
    rotations('Arm_R', jumpTimes, [0, 0.25, -0.85, -0.22, 0]),
    new T.VectorKeyframeTrack(
      'Root.position',
      jumpTimes,
      [0, 0, 0, 0, -0.04, 0, 0, 0.34, 0, 0, 0.08, 0, 0, 0, 0],
    ),
  ]);
  const waveTimes = [0, 0.2, 0.42, 0.64, 0.86, 1.1];
  const wave = new T.AnimationClip('Wave', 1.1, [
    rotations('Arm_R', waveTimes, [0, -1.45, -1.45, -1.45, -1.45, 0], 'z'),
    rotations('Forearm_R', waveTimes, [0, -0.28, 0.5, -0.45, 0.42, 0], 'x'),
    rotations('Head', waveTimes, [0, -0.08, 0.06, -0.06, 0.04, 0], 'z'),
  ]);
  const attackTimes = [0, 0.22, 0.42, 0.66, 1];
  const attack = new T.AnimationClip('Attack', 1, [
    rotations('Spine', attackTimes, [0, -0.32, 0.48, 0.12, 0], 'y'),
    rotations('Arm_L', attackTimes, [0, 0.68, -0.85, -0.18, 0], 'x'),
    rotations('Arm_R', attackTimes, [0, 0.68, -0.85, -0.18, 0], 'x'),
    rotations('Forearm_L', attackTimes, [0, -0.5, 0.25, 0.08, 0], 'x'),
    rotations('Forearm_R', attackTimes, [0, -0.5, 0.25, 0.08, 0], 'x'),
    new T.VectorKeyframeTrack(
      'Root.position',
      attackTimes,
      [0, 0, 0, 0, 0, -0.06, 0, 0.02, 0.14, 0, 0, 0.04, 0, 0, 0],
    ),
  ]);
  return [idle, walk, jump, wave, attack];
}
export function skeletonOf(model: T.Object3D) {
  let result: T.Skeleton | undefined;
  model.traverse((o) => {
    if (o instanceof T.SkinnedMesh) result = o.skeleton;
  });
  return result;
}
