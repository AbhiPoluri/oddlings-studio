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
  /** Which skeleton this is. Absent means the humanoid, which came first. */
  kind?: 'humanoid';
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
  kind: 'humanoid',
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

/* --------------------------------------------------------------- quadruped */

/**
 * The 14 bones a four-legged rig has: a body and a hip/knee/ankle chain per
 * corner. `FL` is front-left, `BR` back-right, and left is +x for the same
 * reason it is on the humanoid — +z is the front, so the creature's own left
 * is the model's +x.
 *
 * Listed parent before child, like `JOINTS`, so one forward pass resolves
 * every absolute position.
 */
export const QUAD_JOINTS = [
  'Root',
  'Body',
  'Hip_FL',
  'Knee_FL',
  'Ankle_FL',
  'Hip_FR',
  'Knee_FR',
  'Ankle_FR',
  'Hip_BL',
  'Knee_BL',
  'Ankle_BL',
  'Hip_BR',
  'Knee_BR',
  'Ankle_BR',
] as const;
export type QuadBoneName = (typeof QUAD_JOINTS)[number];

/** The four corners, in the order `QUAD_JOINTS` lists their chains. */
export const QUAD_LEGS = ['FL', 'FR', 'BL', 'BR'] as const;

const QUAD_BONE_PARENT: readonly (number | null)[] = [
  null, 0, 1, 2, 3, 1, 5, 6, 1, 8, 9, 1, 11, 12,
];

export type QuadrupedRig = {
  kind: 'quadruped';
  /** Where the body pivot sits above the ground, in metres. */
  bodyHeight: number;
  /**
   * Absolute model-space positions per bone, replacing what `bodyHeight`
   * derived. A four-legged body has no three numbers that describe it — a
   * spider, a horse and a walking gun platform put their knees in completely
   * different places — so this is the normal way to author one, not the escape
   * hatch it is on the humanoid.
   */
  bones?: Partial<Record<QuadBoneName, [number, number, number]>>;
};

export const defaultQuadrupedRig: QuadrupedRig = {
  kind: 'quadruped',
  bodyHeight: 0.9,
};

/**
 * A plain standing quadruped derived from `bodyHeight` alone.
 *
 * Deliberately dull — straight legs at the four corners of a body about one
 * body-height long — because the only job of the derived pose is to give a
 * starter spec something that builds and audits before the author moves the
 * bones to where their creature actually bends.
 */
function quadRestPositions(height: number) {
  const half = height * 0.42;
  const spread = height * 0.34;
  const at: Record<string, [number, number, number]> = {
    Root: [0, 0, 0],
    Body: [0, height, 0],
  };
  for (const leg of QUAD_LEGS) {
    const x = leg.endsWith('L') ? spread : -spread;
    const z = leg.startsWith('F') ? half : -half;
    at[`Hip_${leg}`] = [x, height, z];
    at[`Knee_${leg}`] = [x, height * 0.55, z];
    at[`Ankle_${leg}`] = [x, height * 0.16, z];
  }
  return at;
}

export type QuadPlacement = {
  name: QuadBoneName;
  parent: QuadBoneName | null;
  at: [number, number, number];
};

/**
 * The skeleton a quadruped rig block describes, in model space.
 *
 * The same contract `rigBoneLayout` has for the humanoid: absolute positions
 * in `QUAD_JOINTS` order, so entry `i` is skeleton bone `i`.
 */
export function quadBoneLayout(
  settings: QuadrupedRig = defaultQuadrupedRig,
): QuadPlacement[] {
  const rest = quadRestPositions(settings.bodyHeight);
  return QUAD_JOINTS.map((name, index) => {
    const parent = QUAD_BONE_PARENT[index];
    const override = settings.bones?.[name];
    const at = override ?? rest[name];
    return {
      name,
      parent: parent === null ? null : QUAD_JOINTS[parent],
      at: [at[0], at[1], at[2]] as [number, number, number],
    };
  });
}

/** How automatic weighting treats a quadruped. */
export const QUAD_AUTO = {
  /**
   * How close to a leg chain an unpinned point has to be to ride it, as a
   * fraction of that leg's own length.
   *
   * Relative rather than absolute, unlike the humanoid's fixed height bands: a
   * four-legged body has no standard size, and a spider's knee is above its
   * hip, so there is no height that separates body from leg. Distance to the
   * chain is the one measure that means the same thing on a horse and on a
   * walking siege engine. Tight on purpose — a torso half a femur away from a
   * femur is a torso, and anything nearer than this that is not a leg should
   * say so with `rigPart`.
   */
  reach: 0.2,
  /** The last fraction of a bone over which weight hands off to its child. */
  blend: 0.3,
};

/** Squared distance from a point to a segment, and where along it that fell. */
function toSegment(
  point: T.Vector3,
  from: readonly number[],
  to: readonly number[],
) {
  const dx = to[0] - from[0],
    dy = to[1] - from[1],
    dz = to[2] - from[2];
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const u =
    lengthSq > 1e-12
      ? T.MathUtils.clamp(
          ((point.x - from[0]) * dx +
            (point.y - from[1]) * dy +
            (point.z - from[2]) * dz) /
            lengthSq,
          0,
          1,
        )
      : 0;
  const ex = point.x - (from[0] + dx * u),
    ey = point.y - (from[1] + dy * u),
    ez = point.z - (from[2] + dz * u);
  return { distanceSq: ex * ex + ey * ey + ez * ez, u };
}

/**
 * What a quadruped's automatic weighting binds a point to: the nearest leg
 * chain when it is close enough to one, and the body otherwise.
 *
 * Each bone of a leg drives the limb running from its own pivot to the next
 * pivot down, exactly as `Thigh_L` drives the humanoid's femur. So a point
 * beside the femur rides `Hip`, hands over to `Knee` across the last stretch
 * of it, and anything at or past the ankle rides `Ankle` outright. Returned as
 * the two bone indices to blend and how far between them, which is the shape
 * the skinner already speaks.
 */
export function quadWeightFor(point: T.Vector3, layout: QuadPlacement[]) {
  const body = 1;
  let best: { a: number; b: number; t: number } | null = null;
  let bestDistance = Infinity;
  for (let leg = 0; leg < QUAD_LEGS.length; leg++) {
    const hip = 2 + leg * 3;
    const knee = hip + 1;
    const ankle = hip + 2;
    const span =
      Math.hypot(
        layout[knee].at[0] - layout[hip].at[0],
        layout[knee].at[1] - layout[hip].at[1],
        layout[knee].at[2] - layout[hip].at[2],
      ) +
      Math.hypot(
        layout[ankle].at[0] - layout[knee].at[0],
        layout[ankle].at[1] - layout[knee].at[1],
        layout[ankle].at[2] - layout[knee].at[2],
      );
    const reach = span * QUAD_AUTO.reach;
    for (const [driver, next] of [
      [hip, knee],
      [knee, ankle],
    ]) {
      const { distanceSq, u } = toSegment(
        point,
        layout[driver].at,
        layout[next].at,
      );
      if (distanceSq > reach * reach || distanceSq >= bestDistance) continue;
      bestDistance = distanceSq;
      best = {
        a: driver,
        b: next,
        t: T.MathUtils.clamp(
          (u - (1 - QUAD_AUTO.blend)) / QUAD_AUTO.blend,
          0,
          1,
        ),
      };
    }
    // And the foot: anything hanging off the end of the chain rides the ankle
    // whole, which is what puts a sole and a claw on the bone that plants it.
    const foot = toSegment(point, layout[ankle].at, layout[ankle].at);
    if (foot.distanceSq <= reach * reach && foot.distanceSq < bestDistance) {
      bestDistance = foot.distanceSq;
      best = { a: ankle, b: ankle, t: 0 };
    }
  }
  return best ?? { a: body, b: body, t: 0 };
}

/**
 * `rigPart` values, as skeleton indices, for each kind of rig.
 *
 * These maps are how an author pins a part outright: `rigPart: "spine"` on a
 * humanoid, `rigPart: "knee_fl"` on a quadruped. Keeping them beside the bone
 * lists is what stops a rename in one silently unpinning the other.
 */
const HUMANOID_PINS: Record<string, number> = {
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

const QUADRUPED_PINS: Record<string, number> = Object.fromEntries(
  QUAD_JOINTS.slice(1).map((name, at) => [name.toLowerCase(), at + 1]),
);

/** The `rigPart` names a rig of this kind accepts. */
export function pinsFor(kind: 'humanoid' | 'quadruped') {
  return Object.keys(kind === 'quadruped' ? QUADRUPED_PINS : HUMANOID_PINS);
}

/* ---------------------------------------------------------------- skinning */

/** A bone that is not the rig's own: one of the spec's `joints`. */
export type ExtraBone = {
  name: string;
  /** A name in the rig's own list, or an earlier extra bone. */
  parent: string;
  /** Model space, absolute, like every other pivot. */
  at: [number, number, number];
};

/**
 * Joints riding along with a rig.
 *
 * A humanoid cannot wear a cape, a tail or a hair chain out of its own 14
 * bones, and the answer is not a second asset: it is the same skeleton with a
 * few more bones on the end of it. `places` are appended after the rig's own,
 * so the rig keeps the indices it has always had, and `boneFor` answers which
 * of them a part belongs to — 0 meaning "none of them, weight it normally".
 */
export type JointSkin = {
  places: ExtraBone[];
  boneFor: (path: number[] | undefined) => number;
};

/** The skeleton a rig block describes, whichever kind of rig it is. */
export function rigLayout(
  settings: RigSettings | QuadrupedRig = defaultRig,
): { name: string; parent: string | null; at: [number, number, number] }[] {
  return settings.kind === 'quadruped'
    ? quadBoneLayout(settings)
    : rigBoneLayout(settings);
}

export function rigCreature(
  source: T.Group,
  settings: RigSettings | QuadrupedRig = defaultRig,
  /** Joints hanging off this rig, appended after its own bones. */
  extra?: JointSkin,
) {
  const model = new T.Group();
  model.name = source.name;
  model.userData = source.userData;
  const own = rigLayout(settings);
  const quadLayout =
    settings.kind === 'quadruped' ? (own as QuadPlacement[]) : null;
  const pins = quadLayout ? QUADRUPED_PINS : HUMANOID_PINS;
  // One flat list: the rig's bones keep the indices they have always had, and
  // a joint is simply a bone after them, which is what lets a cape hang off a
  // spine without the humanoid noticing.
  const layout: { name: string; parent: string | null; at: [number, number, number] }[] = [
    ...own,
    ...(extra?.places ?? []),
  ];
  const index = new Map(layout.map((place, at) => [place.name, at]));
  const bones = layout.map((place) => {
    const b = new T.Bone();
    b.name = place.name;
    return b;
  });
  // The layout is absolute; a bone's `position` is relative to its parent, so
  // an override on a parent carries its children along rather than stretching
  // the limb away from them. An unknown parent cannot happen — the schema
  // resolves every joint's parent against this same list — but hanging off the
  // root is the harmless answer if one ever does.
  layout.forEach((place, at) => {
    const parent =
      place.parent === null ? null : (index.get(place.parent) ?? 0);
    const base = parent === null ? [0, 0, 0] : layout[parent].at;
    bones[at].position.set(
      place.at[0] - base[0],
      place.at[1] - base[1],
      place.at[2] - base[2],
    );
    if (parent !== null) bones[parent].add(bones[at]);
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
    // A part bound to a joint is bound to that joint and nothing else: the
    // binding is the author's own statement, so it comes before both the
    // `rigPart` pin and the automatic weighting, and a cape ring is never
    // quietly stolen by the head band it happens to sit inside.
    const owners = geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (number[] | undefined)[] }
      | undefined;
    const meshJoint = extra
      ? extra.boneFor(object.userData.specPath as number[] | undefined)
      : 0;
    // And a record of which vertices that claimed, so the audit can tell a
    // cape ring bound to a joint from a torso nobody pinned. Without it every
    // check that counts unpinned geometry would report a correctly bound cape
    // as a body about to swing with the head.
    const jointNames: (string | undefined)[] | undefined = extra
      ? Array.from<string | undefined>({ length: position.count })
      : undefined;
    const partCenter = new T.Vector3();
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (perVertex)
        partCenter.set(position.getX(i), y, position.getZ(i));
      else partCenter.copy(meshCenter);
      let a = 1,
        b = 1,
        t = 0;
      const jointBone = !extra
        ? 0
        : owners
          ? extra.boneFor(owners.paths[owners.index[i]])
          : meshJoint;
      const pinned = perVertex
        ? perVertex[i]
        : (object.userData.rigPart as string | undefined);
      const explicit = pinned === undefined ? undefined : pins[pinned];
      if (pinned !== undefined && explicit === undefined)
        throw Error(
          `A part pins rigPart "${pinned}", which is not a bone of this ${
            quadLayout ? 'quadruped' : 'humanoid'
          } rig. Use one of: ${Object.keys(pins).join(', ')}.`,
        );
      if (jointNames) jointNames[i] = jointBone > 0 ? layout[jointBone].name : undefined;
      if (jointBone > 0) {
        a = jointBone;
        b = jointBone;
      } else if (explicit !== undefined) {
        a = explicit;
        b = explicit;
      } else if (quadLayout) {
        ({ a, b, t } = quadWeightFor(partCenter, quadLayout));
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
    // A fresh object rather than a key on the shared one: `clone` hands the
    // copy the source geometry's own `userData`, so writing through it would
    // write onto the model this one was built from.
    if (jointNames?.some(Boolean))
      geometry.userData = { ...geometry.userData, jointParts: jointNames };
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
/**
 * The two clips a quadruped rig exports.
 *
 * Short of what the humanoid ships, and on purpose: Wave and Attack are
 * gestures of a body with arms, and a Jump that does not know whether the
 * creature is a horse or a siege engine is worse than no Jump. Walk is the
 * diagonal gait every four-legged animal actually uses — front-left with
 * back-right, front-right with back-left — and Idle is the body breathing over
 * legs that stay planted. Both are keyed on bone names that only this rig has,
 * so they can never be confused with the humanoid's.
 */
export function quadClips(): T.AnimationClip[] {
  const times = [0, 0.25, 0.5, 0.75, 1];
  const swing = (phase: number) =>
    times.map((t) => 0.34 * Math.sin((t + phase) * Math.PI * 2));
  const reach = (phase: number) =>
    times.map((t) => -0.26 * (1 - Math.cos((t + phase) * Math.PI * 2)) * 0.5);
  // Diagonal pairs move together; the other two are half a cycle behind.
  const gait: [string, number][] = [
    ['FL', 0],
    ['BR', 0],
    ['FR', 0.5],
    ['BL', 0.5],
  ];
  const walk = new T.AnimationClip('Walk', 1, [
    ...gait.flatMap(([leg, phase]) => [
      rotations(`Hip_${leg}`, times, swing(phase)),
      rotations(`Knee_${leg}`, times, reach(phase)),
    ]),
    new T.VectorKeyframeTrack(
      'Root.position',
      times,
      [0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0.02, 0, 0, 0, 0],
    ),
  ]);
  // The breath rides `Root`, not `Body`. A position track sets a bone's local
  // position outright rather than offsetting it, and `Body` sits at
  // `bodyHeight` above its parent — so keying it from zero would drop the body
  // to the origin on the first frame and take all four legs down with it.
  // `Root` rests at the origin, which is the whole reason the humanoid's clips
  // move the model from there too.
  const idle = new T.AnimationClip('Idle', 3, [
    new T.VectorKeyframeTrack(
      'Root.position',
      [0, 1.5, 3],
      [0, 0, 0, 0, 0.018, 0, 0, 0, 0],
    ),
    rotations('Body', [0, 1.5, 3], [0.01, -0.01, 0.01], 'z'),
  ]);
  return [idle, walk];
}

export function skeletonOf(model: T.Object3D) {
  let result: T.Skeleton | undefined;
  model.traverse((o) => {
    if (o instanceof T.SkinnedMesh) result = o.skeleton;
  });
  return result;
}
