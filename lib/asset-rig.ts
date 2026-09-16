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
export type RigSettings = {
  hipHeight: number;
  headPivot: number;
  shoulderWidth: number;
};
export const defaultRig: RigSettings = {
  hipHeight: 0.48,
  headPivot: 0.9,
  shoulderWidth: 0.28,
};
export function rigCreature(
  source: T.Group,
  settings: RigSettings = defaultRig,
) {
  const model = new T.Group();
  model.name = source.name;
  model.userData = source.userData;
  const bones = JOINTS.map((name) => {
    const b = new T.Bone();
    b.name = name;
    return b;
  });
  function joint(i: number, parent: number, x: number, y: number, z = 0) {
    bones[i].position.set(x, y, z);
    bones[parent].add(bones[i]);
  }
  joint(1, 0, 0, settings.hipHeight);
  joint(2, 1, 0, 0.1);
  joint(3, 2, 0, settings.headPivot - settings.hipHeight - 0.1);
  for (const [side, arm, thigh] of [
    [-1, 4, 8],
    [1, 6, 11],
  ]) {
    joint(arm, 2, side * settings.shoulderWidth, 0);
    joint(arm + 1, arm, side * 0.09, -0.12, 0.025);
    joint(thigh, 1, side * 0.16, 0.34 - settings.hipHeight);
    joint(thigh + 1, thigh, side * 0.015, -0.15, 0.015);
    joint(thigh + 2, thigh + 1, side * 0.015, -0.14, 0.055);
  }
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
    const partCenter = new T.Box3()
      .setFromBufferAttribute(position as T.BufferAttribute)
      .getCenter(new T.Vector3());
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
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
      const explicit = named[String(object.userData.rigPart)];
      if (explicit !== undefined) {
        a = explicit;
        b = explicit;
      } else if (partCenter.y > 0.82) {
        a = 3;
        b = 3;
      } else if (partCenter.y < 0.36) {
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
      } else if (Math.abs(partCenter.x) > 0.28) {
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
