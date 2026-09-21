import '../lib/node-shims';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import {
  parseSpec,
  buildSpec,
  specJSONSchema,
  type AssetSpecInput,
} from '../lib/asset-spec';
import { boneLayout, clipsOf, jointBinder, specClips } from '../lib/asset-joints';
import { QUAD_JOINTS, skeletonOf } from '../lib/asset-rig';
import { readySurface } from '../lib/asset-surface';
import { writeAsset, inspectGLB } from '../node/write-asset';
import { disposeScene } from '../lib/three-world';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-joints-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));
beforeAll(readySurface);

/** A post with a crossbar and a hanging sign: the smallest real mechanism. */
const SIGN: AssetSpecInput = {
  version: 1,
  name: 'Swinging Sign',
  kind: 'prop',
  seed: 3,
  scale: 1,
  color: '#8a6a45',
  joints: [
    {
      name: 'Swing',
      at: [0.3, 1, 0],
      binds: ['board'],
      spin: { axis: 'x', degrees: 20, seconds: 2 },
    },
  ],
  parts: [
    {
      name: 'post',
      shape: 'box',
      size: [0.1, 1, 0.1],
      position: [0, 0.5, 0],
    },
    {
      name: 'arm',
      shape: 'box',
      size: [0.6, 0.08, 0.08],
      position: [0.3, 0.98, 0],
    },
    {
      name: 'board',
      shape: 'box',
      size: [0.4, 0.3, 0.05],
      position: [0.3, 0.75, 0],
      children: [
        { name: 'trim', shape: 'box', size: [0.44, 0.04, 0.06], position: [0, 0.15, 0] },
      ],
    },
  ],
};

/** A rope off a bough and a tire off the rope: the smallest real chain. */
const CHAIN: AssetSpecInput = {
  ...SIGN,
  name: 'Chained Sign',
  joints: [
    {
      name: 'Swing',
      at: [0.3, 1, 0],
      binds: ['board'],
      spin: { axis: 'x', degrees: 20, seconds: 2, clip: 'Swing' },
    },
    {
      name: 'Trim',
      parent: 'Swing',
      at: [0.3, 0.9, 0],
      binds: ['trim'],
      spin: { axis: 'x', degrees: 6, seconds: 2, clip: 'Swing', phase: 90 },
    },
  ],
};

/** A body on the humanoid rig, for the per-bone override tests. */
/** The humanoid measurements `FIGURE` is built from, kept nameable so a test
 * that adds bone overrides does not have to spread a union back apart. */
const BODY = {
  kind: 'humanoid',
  hipHeight: 0.48,
  headPivot: 0.9,
  shoulderWidth: 0.28,
} as const;

const FIGURE: AssetSpecInput = {
  version: 1,
  name: 'Stubby',
  kind: 'creature',
  seed: 5,
  scale: 1,
  color: '#93cec8',
  rig: { ...BODY },
  parts: [
    { name: 'torso', shape: 'capsule', size: [0.4, 0.5, 0.3], position: [0, 0.6, 0] },
    { name: 'head', shape: 'sphere', size: [0.34, 0.34, 0.34], position: [0, 0.98, 0] },
    { name: 'leg', shape: 'box', size: [0.12, 0.34, 0.14], position: [0.14, 0.18, 0], mirror: 'x' },
  ],
};

function bind(input: AssetSpecInput) {
  return jointBinder(parseSpec(input));
}

/** Every bone in a built model, by name, with its world position. */
function builtBones(model: T.Object3D) {
  model.updateMatrixWorld(true);
  const found = new Map<string, T.Bone>();
  model.traverse((o) => {
    if (o instanceof T.Bone) found.set(o.name, o);
  });
  return found;
}

/**
 * The layout has to say where the bones actually ended up, because a hand
 * editor draws its handles from the layout and never rebuilds the model to
 * check. Layout positions are model space, so world is that times the scale.
 */
function expectLayoutMatchesBones(input: AssetSpecInput) {
  const spec = parseSpec(input);
  const model = buildSpec(spec);
  const bones = builtBones(model);
  const layout = boneLayout(spec);
  expect(layout.length).toBe(bones.size);
  for (const place of layout) {
    const bone = bones.get(place.name);
    expect(bone, `no bone called ${place.name}`).toBeDefined();
    const world = bone!.getWorldPosition(new T.Vector3());
    const wanted = new T.Vector3(...place.at).multiplyScalar(spec.scale);
    expect(world.distanceTo(wanted)).toBeLessThan(1e-6);
    const parent = bone!.parent;
    expect(parent instanceof T.Bone ? parent.name : null).toBe(place.parent);
  }
  disposeScene(model);
  return layout;
}

/** Every vertex in the model, grouped by the bone it is weighted to. */
function byBone(model: T.Object3D) {
  const counts = new Map<number, number>();
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const index = o.geometry.attributes.skinIndex;
    if (!index) return;
    for (let i = 0; i < index.count; i++)
      counts.set(index.getX(i), (counts.get(index.getX(i)) ?? 0) + 1);
  });
  return counts;
}

/** Where the vertices on one bone sit once the clip has been applied. */
function boneCentre(model: T.Object3D, bone: number) {
  model.updateMatrixWorld(true);
  const box = new T.Box3();
  const point = new T.Vector3();
  model.traverse((o) => {
    if (!(o instanceof T.SkinnedMesh)) return;
    const index = o.geometry.attributes.skinIndex;
    for (let i = 0; i < index.count; i++) {
      if (index.getX(i) !== bone) continue;
      o.getVertexPosition(i, point);
      box.expandByPoint(o.localToWorld(point.clone()));
    }
  });
  return box.isEmpty() ? null : box.getCenter(new T.Vector3());
}

describe('binding parts to joints', () => {
  test('a bound part and its children follow the joint', () => {
    const boneFor = bind(SIGN);
    expect(boneFor([2])).toBe(1); // board
    expect(boneFor([2, 0])).toBe(1); // trim, a child of board
    expect(boneFor([0])).toBe(0); // post
    expect(boneFor([1])).toBe(0); // arm
    expect(boneFor(undefined)).toBe(0);
  });

  test('a deeper binding wins over a shallower one', () => {
    const boneFor = bind({
      ...SIGN,
      joints: [
        { name: 'Board', at: [0.3, 1, 0], binds: ['board'] },
        { name: 'Trim', at: [0.3, 0.9, 0], binds: ['trim'] },
      ],
    });
    expect(boneFor([2])).toBe(1);
    expect(boneFor([2, 0])).toBe(2);
  });

  test('binding a name no part has fails loudly', () => {
    expect(() => bind({ ...SIGN, joints: [{ name: 'Swing', at: [0, 0, 0], binds: ['plank'] }] }))
      .toThrow(/no part is called that/);
  });

  test('an ambiguous name fails rather than picking one', () => {
    expect(() =>
      bind({
        ...SIGN,
        parts: [...SIGN.parts, { name: 'board', shape: 'box', size: [0.1, 0.1, 0.1] }],
      }),
    ).toThrow(/2 parts share that name/);
  });

  test('a body rig and joints can share one skeleton', () => {
    // They used to be mutually exclusive. A cape, a tail or a swinging sign a
    // character carries is one asset, not two, so the joints are appended to
    // the rig's own bones rather than replacing them.
    const both = parseSpec({ ...SIGN, rig: { hipHeight: 0.5 } });
    expect(both.joints).toHaveLength(SIGN.joints!.length);
    expect(both.rig?.kind).toBe('humanoid');
  });
});

describe('the built rig', () => {
  test('one bone per joint, plus a root, and the bound parts on it', () => {
    const model = buildSpec(SIGN);
    const bones: string[] = [];
    model.traverse((o) => {
      if (o instanceof T.Bone) bones.push(o.name);
    });
    expect(bones).toEqual(['Root', 'Swing']);
    const counts = byBone(model);
    expect(counts.get(0)).toBeGreaterThan(0);
    expect(counts.get(1)).toBeGreaterThan(0);
    disposeScene(model);
  });

  test('the joint actually moves what is bound to it, and nothing else', () => {
    const model = buildSpec(SIGN);
    const clip = specClips(parseSpec(SIGN))[0];
    const mixer = new T.AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(0);
    const boardRest = boneCentre(model, 1)!;
    const postRest = boneCentre(model, 0)!;
    mixer.setTime(clip.duration * 0.25);
    const boardSwung = boneCentre(model, 1)!;
    const postSwung = boneCentre(model, 0)!;
    // The board hangs ~0.25 below a pivot 20 degrees off vertical, so it has
    // to travel several centimetres. Anything less means it is welded to root.
    expect(boardRest.distanceTo(boardSwung)).toBeGreaterThan(0.05);
    expect(postRest.distanceTo(postSwung)).toBeLessThan(1e-6);
    disposeScene(model);
  });

  test('the clip starts at the bind pose so the first frame is the rest pose', () => {
    const clip = specClips(parseSpec(SIGN))[0];
    const values = (clip.tracks[0] as T.QuaternionKeyframeTrack).values;
    const first = new T.Quaternion(values[0], values[1], values[2], values[3]);
    expect(first.angleTo(new T.Quaternion())).toBeLessThan(0.02);
  });

  test('a joint with no spin gives a posable bone and no clip', () => {
    const still = { ...SIGN, joints: [{ name: 'Hinge', at: [0, 1, 0], binds: ['board'] }] };
    expect(specClips(parseSpec(still))).toHaveLength(0);
    const model = buildSpec(still);
    expect(byBone(model).get(1)).toBeGreaterThan(0);
    disposeScene(model);
  });

  test('surface mode binds per vertex, and every source shape is attributed', () => {
    const fused = { ...SIGN, surface: { blend: 0.02, detail: 96, budget: 3000 } };
    const model = buildSpec(fused);
    let meshes = 0;
    let unattributed = 0;
    model.traverse((o) => {
      if (!(o instanceof T.Mesh)) return;
      meshes++;
      // Surface mode fuses everything into one mesh, so the binding is read
      // per vertex off the owner table. A shape with no path there binds to
      // root without complaining, which shows up only as a part that
      // mysteriously refuses to move.
      const owners = o.geometry.userData.surfaceOwners as {
        paths: (number[] | undefined)[];
      };
      unattributed += owners.paths.filter((path) => !path).length;
    });
    expect(meshes).toBe(1);
    expect(unattributed).toBe(0);
    const counts = byBone(model);
    expect(counts.get(0)).toBeGreaterThan(0);
    expect(counts.get(1)).toBeGreaterThan(0);
    disposeScene(model);
  });
});

describe('clips reaching the outside world', () => {
  test('a written GLB carries the joint bones and the named clip', async () => {
    const result = await writeAsset(
      { spec: parseSpec(SIGN) },
      { outDir: join(scratch, 'sign'), formats: ['glb'] },
    );
    const loaded = await inspectGLB(result.files[0]);
    expect(loaded.bones).toEqual(['Root', 'Swing']);
    expect(loaded.animations.map((a) => a.name)).toEqual(['Swing']);
  });

  test('joint specs are not measured against the humanoid rig checks', async () => {
    const result = await writeAsset(
      { spec: parseSpec(SIGN) },
      { outDir: join(scratch, 'audit'), formats: ['glb'] },
    );
    expect(result.audit.findings.filter((f) => f.code.startsWith('rig-'))).toEqual([]);
  });

  test('the clip picker offers exactly what the asset exports', () => {
    expect(clipsOf(parseSpec(SIGN)).map((c) => c.name)).toEqual(['Swing']);
    expect(clipsOf(parseSpec({ ...SIGN, joints: undefined }))).toEqual([]);
  });
});

describe('the tire swing', () => {
  const tree = parseSpec(
    JSON.parse(readFileSync('specs/tire-swing-tree-leafy.spec.json', 'utf8')),
  );

  test('the rope and the tire are one clip on two chained bones', () => {
    const clips = specClips(tree);
    expect(clips.map((c) => c.name)).toEqual(['Swing']);
    expect(clips[0].tracks.map((t) => t.name)).toEqual([
      'Swing.quaternion',
      'Tire.quaternion',
    ]);
    expect(boneLayout(tree).map((b) => `${b.name}<-${b.parent}`)).toEqual([
      'Root<-null',
      'Swing<-Root',
      'Tire<-Swing',
    ]);
  });

  test('the swing carries the rope and the tire swings clear of its own width', () => {
    const model = buildSpec(tree);
    const clip = specClips(tree)[0];
    const mixer = new T.AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(clip.duration * 0.25);
    const ropeOut = boneCentre(model, 1)!;
    const tireOut = boneCentre(model, 2)!;
    mixer.setTime(clip.duration * 0.75);
    const ropeBack = boneCentre(model, 1)!;
    const tireBack = boneCentre(model, 2)!;
    // The tire is 1m across at this scale, so half a metre of travel is the
    // floor for something that reads as swinging rather than trembling.
    expect(tireOut.distanceTo(tireBack)).toBeGreaterThan(0.5);
    // And it hangs below the rope's own middle, so it has to travel further
    // than the rope does — which it only can if it rides the rope's bone.
    expect(tireOut.distanceTo(tireBack)).toBeGreaterThan(
      ropeOut.distanceTo(ropeBack),
    );
    disposeScene(model);
  });
});

describe('hand-built bone chains', () => {
  test('a parented joint becomes a bone under the joint it names', () => {
    const model = buildSpec(CHAIN);
    const bones = builtBones(model);
    expect([...bones.keys()]).toEqual(['Root', 'Swing', 'Trim']);
    expect(bones.get('Trim')!.parent).toBe(bones.get('Swing'));
    // `at` is authored absolute, so the bone's own offset is what is left
    // after its parent's: 1 - 0.9 down the post.
    expect(bones.get('Trim')!.position.y).toBeCloseTo(-0.1, 10);
    expect(bones.get('Trim')!.getWorldPosition(new T.Vector3()).y).toBeCloseTo(
      0.9,
      10,
    );
    disposeScene(model);
  });

  test('the bone order stays root-first and authored, so bindings still land', () => {
    const boneFor = bind(CHAIN);
    expect(boneFor([2])).toBe(1); // board, on Swing
    expect(boneFor([2, 0])).toBe(2); // trim, on Trim, the deeper binding
    expect(boneFor([0])).toBe(0); // post, on the static root
  });

  test('a joint may name a parent authored after it', () => {
    const backwards = { ...CHAIN, joints: [CHAIN.joints![1], CHAIN.joints![0]] };
    const model = buildSpec(backwards);
    const bones = builtBones(model);
    expect(bones.get('Trim')!.parent).toBe(bones.get('Swing'));
    // Bone numbers follow the authored order, not the tree, so the binder
    // still answers with index + 1 whichever way round the chain is written.
    const boneFor = bind(backwards);
    expect(boneFor([2, 0])).toBe(1); // trim, on Trim, authored first
    expect(boneFor([2])).toBe(2); // board, on Swing, authored second
    disposeScene(model);
    expectLayoutMatchesBones(backwards);
  });

  test('a child joint rides its parent even with no spin of its own', () => {
    const still = {
      ...CHAIN,
      joints: [
        { ...CHAIN.joints![0], spin: { axis: 'x' as const, degrees: 20, seconds: 2 } },
        { name: 'Trim', parent: 'Swing', at: [0.3, 0.9, 0] as [number, number, number], binds: ['trim'] },
      ],
    };
    const spec = parseSpec(still);
    const model = buildSpec(spec);
    const clip = specClips(spec)[0];
    expect(clip.tracks).toHaveLength(1);
    const mixer = new T.AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.setTime(0);
    const rest = boneCentre(model, 2)!;
    const postRest = boneCentre(model, 0)!;
    mixer.setTime(clip.duration * 0.25);
    const swung = boneCentre(model, 2)!;
    // Nothing keys Trim, so any movement at all is its parent carrying it.
    // The trim sits 0.1 under the pivot, so 20 degrees is ~3 centimetres.
    expect(rest.distanceTo(swung)).toBeGreaterThan(0.02);
    // And the post, on the static root, has not stirred.
    expect(postRest.distanceTo(boneCentre(model, 0)!)).toBeLessThan(1e-6);
    disposeScene(model);
  });

  test('a parent no joint answers to fails by name', () => {
    expect(() =>
      parseSpec({
        ...CHAIN,
        joints: [CHAIN.joints![0], { ...CHAIN.joints![1], parent: 'Swng' }],
      }),
    ).toThrow(/Joint "Trim" has parent "Swng", but no joint is called that/);
  });

  test('a joint cannot be its own parent', () => {
    expect(() =>
      parseSpec({
        ...CHAIN,
        joints: [{ ...CHAIN.joints![0], parent: 'Swing' }, CHAIN.joints![1]],
      }),
    ).toThrow(/Joint "Swing" is its own parent/);
  });

  test('a cycle is refused rather than hung', () => {
    expect(() =>
      parseSpec({
        ...CHAIN,
        joints: [
          { ...CHAIN.joints![0], parent: 'Trim' },
          { ...CHAIN.joints![1], parent: 'Swing' },
        ],
      }),
    ).toThrow(/hangs off itself: Swing → Trim → Swing/);
  });

  test('two joints cannot share a name, and none may be called Root', () => {
    expect(() =>
      parseSpec({ ...CHAIN, joints: [CHAIN.joints![0], { ...CHAIN.joints![1], name: 'Swing' }] }),
    ).toThrow(/Two joints are called "Swing"/);
    expect(() =>
      parseSpec({ ...CHAIN, joints: [{ ...CHAIN.joints![0], name: 'Root' }] }),
    ).toThrow(/"Root" is the static bone/);
  });

  test('parenting to Root says to omit the field instead', () => {
    expect(() =>
      parseSpec({ ...CHAIN, joints: [{ ...CHAIN.joints![0], parent: 'Root' }] }),
    ).toThrow(/Omit "parent" instead/);
  });
});

describe('clips shared across joints', () => {
  test('joints naming one clip merge into it, a track each', () => {
    const clips = specClips(parseSpec(CHAIN));
    expect(clips).toHaveLength(1);
    expect(clips[0].name).toBe('Swing');
    expect(clips[0].duration).toBe(2);
    expect(clips[0].tracks.map((t) => t.name)).toEqual([
      'Swing.quaternion',
      'Trim.quaternion',
    ]);
  });

  test('a joint that names no clip still gets one of its own', () => {
    const apart = {
      ...CHAIN,
      joints: [
        { ...CHAIN.joints![0], spin: { axis: 'x' as const, degrees: 20, seconds: 2 } },
        { ...CHAIN.joints![1], spin: { axis: 'x' as const, degrees: 6, seconds: 1 } },
      ],
    };
    expect(specClips(parseSpec(apart)).map((c) => c.name)).toEqual([
      'Swing',
      'Trim',
    ]);
  });

  test('one clip cannot be two lengths', () => {
    expect(() =>
      parseSpec({
        ...CHAIN,
        joints: [
          CHAIN.joints![0],
          { ...CHAIN.joints![1], spin: { clip: 'Swing', seconds: 1.5 } },
        ],
      }),
    ).toThrow(/Clip "Swing" runs 2s on joint "Swing" but 1.5s on joint "Trim"/);
  });

  test('phase makes a joint trail the one it hangs from', () => {
    const clip = specClips(parseSpec(CHAIN))[0];
    const [lead, lag] = clip.tracks as T.QuaternionKeyframeTrack[];
    const first = (track: T.QuaternionKeyframeTrack) =>
      new T.Quaternion(...track.values.slice(0, 4));
    // The leader starts at rest; a quarter cycle of lag means the follower is
    // at its extreme when the leader is at rest, and back at rest a quarter
    // cycle later.
    expect(first(lead).angleTo(new T.Quaternion())).toBeLessThan(0.02);
    expect(first(lag).angleTo(new T.Quaternion())).toBeGreaterThan(0.08);
    const quarter = lag.values.slice(24, 28); // sample 6 of 24, a quarter in
    expect(new T.Quaternion(...quarter).angleTo(new T.Quaternion())).toBeLessThan(
      0.02,
    );
    // Both tracks still close their loop, so the clip can repeat seamlessly.
    // Compared component by component: `angleTo` is an acos near 1 and loses
    // most of its digits exactly where two quaternions are nearly equal.
    for (const track of [lead, lag])
      for (let i = 0; i < 4; i++)
        expect(track.values[i]).toBeCloseTo(
          track.values[track.values.length - 4 + i],
          6,
        );
  });
});

describe('per-bone overrides on the humanoid rig', () => {
  const moved: AssetSpecInput = {
    ...FIGURE,
    rig: {
      ...BODY,
      bones: { Arm_L: [0.42, 0.7, 0.05], Head: [0, 1.05, 0.06] },
    },
  };

  test('an override places the bone exactly where it says', () => {
    const bones = builtBones(buildSpec(moved));
    const arm = bones.get('Arm_L')!.getWorldPosition(new T.Vector3());
    expect([arm.x, arm.y, arm.z]).toEqual([0.42, 0.7, 0.05]);
    const head = bones.get('Head')!.getWorldPosition(new T.Vector3());
    expect([head.x, head.y, head.z]).toEqual([0, 1.05, 0.06]);
  });

  test('a moved bone carries its children instead of stretching away', () => {
    const before = builtBones(buildSpec(FIGURE))
      .get('Forearm_L')!
      .getWorldPosition(new T.Vector3());
    const after = builtBones(buildSpec(moved))
      .get('Forearm_L')!
      .getWorldPosition(new T.Vector3());
    // Arm_L moved by (0.14, 0.7 - 0.58, 0.05); the forearm hangs off it, so
    // it has to move by exactly the same amount.
    expect(after.clone().sub(before).x).toBeCloseTo(0.14, 10);
    expect(after.clone().sub(before).y).toBeCloseTo(0.12, 10);
    expect(after.clone().sub(before).z).toBeCloseTo(0.05, 10);
  });

  test('moving bones leaves the automatic skin weighting alone', () => {
    const plain = byBone(buildSpec(FIGURE));
    const shifted = byBone(buildSpec(moved));
    expect([...shifted.entries()].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).toEqual([...plain.entries()].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)));
  });

  test('an unknown bone name is refused', () => {
    expect(() =>
      parseSpec({ ...FIGURE, rig: { ...FIGURE.rig, bones: { Elbow_L: [0, 1, 0] } } }),
    ).toThrow(/Invalid asset spec at rig.bones/);
  });
});

describe('the layout a hand editor draws from', () => {
  test('it matches the built bones of a humanoid rig, overrides and all', () => {
    const layout = expectLayoutMatchesBones({
      ...FIGURE,
      scale: 2.5,
      rig: { ...BODY, bones: { Head: [0, 1.05, 0.06] } },
    });
    expect(layout[0]).toEqual({ name: 'Root', parent: null, at: [0, 0, 0] });
    expect(layout.map((b) => b.name)).toContain('Foot_R');
  });

  test('it matches the built bones of a joint chain', () => {
    expectLayoutMatchesBones({ ...CHAIN, scale: 3 });
    expectLayoutMatchesBones(
      JSON.parse(readFileSync('specs/tire-swing-tree-leafy.spec.json', 'utf8')),
    );
  });

  test('a spec with no rig has no bones to draw', () => {
    expect(boneLayout(parseSpec({ ...SIGN, joints: undefined }))).toEqual([]);
  });
});

describe('the schema agents author against', () => {
  test('it still emits, and advertises the new rigging fields', () => {
    type Node = {
      properties?: Record<string, Node>;
      items?: Node;
      anyOf?: Node[];
      propertyNames?: { enum?: string[] };
    };
    const schema = specJSONSchema() as unknown as Node;
    const joint = schema.properties?.joints?.items?.properties;
    expect(joint?.parent).toBeDefined();
    expect(joint?.spin?.properties?.clip).toBeDefined();
    expect(joint?.spin?.properties?.phase).toBeDefined();
    // `rig` is one of two shapes now, so an agent reading the schema is
    // offered both: the humanoid's bones and the quadruped's.
    const rigs = schema.properties?.rig?.anyOf ?? [];
    const bones = rigs.flatMap(
      (one) => one.properties?.bones?.propertyNames?.enum ?? [],
    );
    expect(rigs).toHaveLength(2);
    expect(bones).toContain('Forearm_R');
    expect(bones).toContain('Ankle_BR');
    expect(
      rigs.flatMap((one) => Object.keys(one.properties ?? {})),
    ).toContain('bodyHeight');
  });
});


describe('a joint that turns', () => {
  const wheel = (spin: Record<string, unknown>) =>
    parseSpec({
      version: 1,
      name: 'Wheel',
      kind: 'prop',
      seed: 1,
      parts: [
        { name: 'axle', shape: 'cylinder', size: [0.1, 0.4, 0.1], position: [0, 0.2, 0] },
        { name: 'rim', shape: 'torus', size: [0.6, 0.6, 0.1], position: [0, 0.5, 0.1] },
      ],
      joints: [{ name: 'Spin', at: [0, 0.5, 0.1], binds: ['rim'], spin: { axis: 'z', seconds: 2, ...spin } }],
    });

  function angles(spec: ReturnType<typeof parseSpec>, axis: T.Vector3) {
    const track = specClips(spec)[0].tracks[0] as T.QuaternionKeyframeTrack;
    const out: { about: number; off: number }[] = [];
    const q = new T.Quaternion();
    const probe = new T.Vector3();
    for (let i = 0; i < track.times.length; i++) {
      q.fromArray(track.values, i * 4);
      // Rotate a vector that lies across the axis and read how far it turned,
      // and how far it left the plane it should stay in.
      probe.set(1, 0, 0).applyQuaternion(q);
      out.push({ about: Math.atan2(probe.y, probe.x), off: Math.abs(probe.dot(axis)) });
    }
    return out;
  }

  test('turn mode makes one full linear revolution and closes the loop', () => {
    const seen = angles(wheel({ mode: 'turn', degrees: 90 }), new T.Vector3(0, 0, 1));
    // Unwrapped, the angle should climb steadily to 2π.
    let total = 0;
    for (let i = 1; i < seen.length; i++) {
      let step = seen[i].about - seen[i - 1].about;
      if (step < -Math.PI) step += Math.PI * 2;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeCloseTo((Math.PI * 2) / 24, 6);
      total += step;
    }
    expect(total).toBeCloseTo(Math.PI * 2, 6);
    expect(seen[0].about).toBeCloseTo(0, 10);
    // A wheel does not wobble.
    for (const { off } of seen) expect(off).toBeLessThan(1e-12);
  });

  test('a negative degrees turns the other way', () => {
    const seen = angles(wheel({ mode: 'turn', degrees: -90 }), new T.Vector3(0, 0, 1));
    let step = seen[1].about - seen[0].about;
    if (step > Math.PI) step -= Math.PI * 2;
    expect(step).toBeLessThan(0);
  });

  test('drift 0 keeps a swing in its plane', () => {
    const seen = angles(wheel({ degrees: 40, drift: 0 }), new T.Vector3(0, 0, 1));
    for (const { off } of seen) expect(off).toBeLessThan(1e-12);
    const wobbly = angles(wheel({ degrees: 40 }), new T.Vector3(0, 0, 1));
    expect(Math.max(...wobbly.map((w) => w.off))).toBeGreaterThan(0.01);
  });
});

/* ------------------------------------------------- joints alongside a rig */

/**
 * A mannequin in a three-ring cape.
 *
 * The rings are the point: they hang off `Spine` through a joint chain the
 * humanoid has no bones for, and `ring-1` sits above the head band on purpose,
 * so a build that forgot the binding would weight it to `Head` and the test
 * would say so. Faceted rather than fused, because faceted binds a mesh at a
 * time and that is the path an assertion can name a part in.
 */
const CAPED: AssetSpecInput = {
  version: 1,
  name: 'Caped',
  kind: 'person',
  seed: 2,
  scale: 1,
  color: '#5c6b8a',
  rig: { ...BODY },
  joints: [
    { name: 'Cape0', parent: 'Spine', at: [0, 0.9, 0], binds: ['ring-1'] },
    { name: 'Cape1', parent: 'Cape0', at: [0, 0.7, 0], binds: ['ring-2'] },
    {
      name: 'Cape2',
      parent: 'Cape1',
      at: [0, 0.5, 0],
      binds: ['ring-3'],
      spin: { axis: 'x', degrees: 6, seconds: 3, clip: 'Cape' },
    },
  ],
  parts: [
    { name: 'torso', shape: 'capsule', size: [0.4, 0.5, 0.3], position: [0, 0.6, 0], rigPart: 'spine' },
    { name: 'head', shape: 'sphere', size: [0.34, 0.34, 0.34], position: [0, 0.98, 0], rigPart: 'head' },
    { name: 'ring-1', shape: 'cone', size: [0.5, 0.2, 0.4], position: [0, 0.92, 0], taper: 0.6 },
    { name: 'ring-2', shape: 'cone', size: [0.56, 0.2, 0.44], position: [0, 0.7, 0], taper: 0.9 },
    { name: 'ring-3', shape: 'cone', size: [0.6, 0.2, 0.48], position: [0, 0.5, 0], taper: 0.92 },
    { name: 'leg', shape: 'box', size: [0.12, 0.34, 0.14], position: [0.14, 0.18, 0], mirror: 'x', rigPart: 'thigh_l' },
  ],
};

/** The same spec with its first part pinned to a bone that may not exist. */
function pinFirst(spec: AssetSpecInput, rigPart: string) {
  const copy = structuredClone(spec) as unknown as {
    parts: Record<string, unknown>[];
  };
  copy.parts[0].rigPart = rigPart;
  return copy;
}

/** Which bones each authored part's vertices are most strongly weighted to. */
function bonesPerPart(model: T.Object3D) {
  const skeleton = skeletonOf(model);
  if (!skeleton) throw Error('not skinned');
  const out = new Map<string, Set<string>>();
  model.traverse((o) => {
    if (!(o instanceof T.SkinnedMesh)) return;
    const key = (o.userData.specPath as number[] | undefined)?.join('.') ?? o.name;
    const { skinIndex, skinWeight } = o.geometry.attributes;
    const names = out.get(key) ?? new Set<string>();
    for (let i = 0; i < skinIndex.count; i++) {
      let best = -1;
      let weight = -1;
      for (const slot of ['getX', 'getY', 'getZ', 'getW'] as const)
        if (skinWeight[slot](i) > weight) {
          weight = skinWeight[slot](i);
          best = skinIndex[slot](i);
        }
      names.add(skeleton.bones[best].name);
    }
    out.set(key, names);
  });
  return out;
}

describe('joints riding on a rig', () => {
  test('a joint may hang off a rig bone, and both skeletons parse', () => {
    const spec = parseSpec(CAPED);
    expect(spec.rig?.kind).toBe('humanoid');
    expect(spec.joints).toHaveLength(3);
    expect(spec.joints![0].parent).toBe('Spine');
  });

  test('a parent that is neither a joint nor a rig bone is refused by name', () => {
    expect(() =>
      parseSpec({
        ...CAPED,
        joints: [{ ...CAPED.joints![0], parent: 'Spien' }, ...CAPED.joints!.slice(1)],
      }),
    ).toThrow(/parent "Spien"/);
    // And with no rig in the spec the message stays the one it always was.
    expect(() =>
      parseSpec({ ...SIGN, joints: [{ ...SIGN.joints![0], parent: 'Nope' }] }),
    ).toThrow(/no joint is called that/);
  });

  test('a joint cannot take a clip name the rig already exports', () => {
    expect(() =>
      parseSpec({
        ...CAPED,
        joints: [
          ...CAPED.joints!.slice(0, 2),
          { ...CAPED.joints![2], spin: { axis: 'x', seconds: 3, clip: 'Walk' } },
        ],
      }),
    ).toThrow(/Clip "Walk" is one this humanoid rig already exports/);
  });

  test('the joints become bones after the rig, at the pivots they name', () => {
    const spec = parseSpec(CAPED);
    const model = buildSpec(spec);
    try {
      const bones = builtBones(model);
      expect(bones.size).toBe(17);
      const layout = boneLayout(spec);
      expect(layout.map((b) => b.name).slice(0, 14)).toEqual(
        boneLayout(parseSpec({ ...CAPED, joints: undefined })).map((b) => b.name),
      );
      expect(layout.slice(14).map((b) => b.name)).toEqual([
        'Cape0',
        'Cape1',
        'Cape2',
      ]);
      // The bind pose is the `at` the author wrote, and the chain really
      // hangs off the spine rather than off the root.
      const cape0 = bones.get('Cape0')!;
      expect(cape0.parent?.name).toBe('Spine');
      const at = cape0.getWorldPosition(new T.Vector3());
      expect([at.x, at.y, at.z]).toEqual([0, 0.9, 0]);
      expect(bones.get('Cape1')!.parent?.name).toBe('Cape0');
      expect(bones.get('Cape2')!.parent?.name).toBe('Cape1');
    } finally {
      disposeScene(model);
    }
  });

  test('the binder numbers joints after the rig own bones', () => {
    const binder = bind(CAPED);
    // ring-1, ring-2 and ring-3 are parts 2, 3 and 4.
    expect(binder([2])).toBe(14);
    expect(binder([3])).toBe(15);
    expect(binder([4])).toBe(16);
    expect(binder([0])).toBe(0);
    // And with no rig in front of them the numbering is what it always was.
    expect(bind(SIGN)([2])).toBe(1);
  });

  test('a bound part is not auto-weighted, however high it sits', () => {
    const model = buildSpec(parseSpec(CAPED));
    try {
      const bound = bonesPerPart(model);
      expect([...bound.get('2')!]).toEqual(['Cape0']);
      expect([...bound.get('3')!]).toEqual(['Cape1']);
      expect([...bound.get('4')!]).toEqual(['Cape2']);
    } finally {
      disposeScene(model);
    }
    // The control: the same ring with nothing binding it lands on the head
    // band, which is exactly what the binding is there to prevent.
    const loose = buildSpec(
      parseSpec({
        ...CAPED,
        joints: [{ ...CAPED.joints![0], binds: ['ring-2'] }],
      }),
    );
    try {
      expect([...bonesPerPart(loose).get('2')!]).toEqual(['Head']);
    } finally {
      disposeScene(loose);
    }
  });

  test('a bound part in surface mode is bound vertex by vertex', () => {
    const model = buildSpec(
      parseSpec({ ...CAPED, surface: { detail: 64, budget: 1200 } }),
    );
    try {
      const names = [...bonesPerPart(model).values()][0];
      // One fused mesh, so the assertion is that the cape bones are in it at
      // all: a fused build that ignored the bindings would carry none.
      expect([...names]).toEqual(
        expect.arrayContaining(['Cape0', 'Cape1', 'Cape2']),
      );
    } finally {
      disposeScene(model);
    }
  });

  test('both sets of clips ship, and the joint clip still swings', () => {
    const clips = specClips(parseSpec(CAPED));
    expect(clips.map((c) => c.name)).toEqual([
      'Idle',
      'Walk',
      'Jump',
      'Wave',
      'Attack',
      'Cape',
    ]);
    const cape = clips.find((c) => c.name === 'Cape')!;
    expect(cape.duration).toBe(3);
    expect(cape.tracks.map((t) => t.name)).toEqual(['Cape2.quaternion']);
  });

  test('the GLB extras list the cape among the bones and its chain', async () => {
    const { files } = await writeAsset(
      { spec: parseSpec(CAPED) },
      { outDir: join(scratch, 'caped'), formats: ['glb'] },
    );
    const seen = await inspectGLB(files[0]);
    expect(seen.bones).toHaveLength(17);
    const extras = seen.extras as {
      bones: { name: string; index: number; parent: string | null }[];
      chains: { leaf: string; bones: string[] }[];
    };
    expect(extras.bones.map((b) => b.name)).toContain('Cape2');
    expect(extras.bones.find((b) => b.name === 'Cape0')).toMatchObject({
      index: 14,
      parent: 'Spine',
    });
    expect(extras.chains.find((c) => c.leaf === 'Cape2')?.bones).toEqual([
      'Root',
      'Hips',
      'Spine',
      'Cape0',
      'Cape1',
      'Cape2',
    ]);
    // The humanoid's own leaves are all still there; nothing was replaced.
    expect(extras.chains.map((c) => c.leaf)).toEqual(
      expect.arrayContaining(['Head', 'Forearm_L', 'Foot_R']),
    );
  }, 60000);
});

/* --------------------------------------------------------- quadruped rig */

/** A blunt four-legged walker: a body and a hip → knee → ankle chain per corner. */
const BEAST: AssetSpecInput = {
  version: 1,
  name: 'Beast',
  kind: 'creature',
  seed: 6,
  scale: 1,
  color: '#7f8f6a',
  rig: {
    kind: 'quadruped',
    bodyHeight: 0.6,
    bones: {
      Body: [0, 0.6, 0],
      Hip_FL: [0.2, 0.58, 0.3],
      Knee_FL: [0.22, 0.34, 0.31],
      Ankle_FL: [0.22, 0.1, 0.31],
      Hip_FR: [-0.2, 0.58, 0.3],
      Knee_FR: [-0.22, 0.34, 0.31],
      Ankle_FR: [-0.22, 0.1, 0.31],
      Hip_BL: [0.2, 0.58, -0.3],
      Knee_BL: [0.22, 0.34, -0.31],
      Ankle_BL: [0.22, 0.1, -0.31],
      Hip_BR: [-0.2, 0.58, -0.3],
      Knee_BR: [-0.22, 0.34, -0.31],
      Ankle_BR: [-0.22, 0.1, -0.31],
    },
  },
  parts: [
    { name: 'body', shape: 'capsule', size: [0.46, 0.4, 0.9], position: [0, 0.6, 0], rigPart: 'body' },
    { name: 'thigh', shape: 'limb', from: [0.2, 0.58, 0.3], to: [0.22, 0.34, 0.31], radius: 0.08, rigPart: 'hip_fl', mirror: 'x' },
    { name: 'shank', shape: 'limb', from: [0.22, 0.34, 0.31], to: [0.22, 0.1, 0.31], radius: 0.07, rigPart: 'knee_fl', mirror: 'x' },
    { name: 'paw', shape: 'box', size: [0.14, 0.08, 0.18], position: [0.22, 0.04, 0.33], rigPart: 'ankle_fl', mirror: 'x' },
    { name: 'hind-thigh', shape: 'limb', from: [0.2, 0.58, -0.3], to: [0.22, 0.34, -0.31], radius: 0.08, rigPart: 'hip_bl', mirror: 'x' },
    { name: 'hind-shank', shape: 'limb', from: [0.22, 0.34, -0.31], to: [0.22, 0.1, -0.31], radius: 0.07, rigPart: 'knee_bl', mirror: 'x' },
    { name: 'hind-paw', shape: 'box', size: [0.14, 0.08, 0.18], position: [0.22, 0.04, -0.33], rigPart: 'ankle_bl', mirror: 'x' },
  ],
};

describe('the quadruped rig', () => {
  test('fourteen bones: a body and four hip-knee-ankle chains', () => {
    const spec = parseSpec(BEAST);
    const model = buildSpec(spec);
    try {
      const bones = builtBones(model);
      expect(bones.size).toBe(14);
      expect([...bones.keys()].sort()).toEqual([...QUAD_JOINTS].sort());
      expect(bones.get('Body')!.parent?.name).toBe('Root');
      expect(bones.get('Hip_BR')!.parent?.name).toBe('Body');
      expect(bones.get('Knee_BR')!.parent?.name).toBe('Hip_BR');
      expect(bones.get('Ankle_BR')!.parent?.name).toBe('Knee_BR');
      const knee = bones.get('Knee_FL')!.getWorldPosition(new T.Vector3());
      expect([knee.x, knee.y, knee.z]).toEqual([0.22, 0.34, 0.31]);
    } finally {
      disposeScene(model);
    }
  });

  test('bodyHeight alone derives a pose that stands on the ground', () => {
    const layout = boneLayout(
      parseSpec({ ...BEAST, rig: { kind: 'quadruped', bodyHeight: 0.8 } }),
    );
    expect(layout.map((b) => b.name)).toEqual([...QUAD_JOINTS]);
    expect(layout[1].at).toEqual([0, 0.8, 0]);
    // Legs at the four corners, ankles near the floor, left on +x and front
    // on +z — the same convention the humanoid uses.
    const by = new Map(layout.map((b) => [b.name, b.at]));
    expect(by.get('Hip_FL')![0]).toBeGreaterThan(0);
    expect(by.get('Hip_FL')![2]).toBeGreaterThan(0);
    expect(by.get('Hip_BR')![0]).toBeLessThan(0);
    expect(by.get('Hip_BR')![2]).toBeLessThan(0);
    expect(by.get('Ankle_FL')![1]).toBeLessThan(0.2);
  });

  test('rigPart pins each part to its own bone, and a mirror swaps the corner', () => {
    const model = buildSpec(parseSpec(BEAST));
    try {
      const bound = bonesPerPart(model);
      expect([...bound.get('0')!]).toEqual(['Body']);
      // `thigh` is part 1, authored on +x and mirrored to -x: one copy on the
      // front-left chain, one on the front-right.
      expect([...bound.get('1')!].sort()).toEqual(['Hip_FL', 'Hip_FR']);
      expect([...bound.get('3')!].sort()).toEqual(['Ankle_FL', 'Ankle_FR']);
      expect([...bound.get('4')!].sort()).toEqual(['Hip_BL', 'Hip_BR']);
    } finally {
      disposeScene(model);
    }
  });

  test('a rigPart from the other rig is refused rather than ignored', () => {
    expect(() => parseSpec(pinFirst(BEAST, 'spine'))).toThrow(
      /rigPart "spine" is not a bone of this quadruped rig/,
    );
    expect(() => parseSpec(pinFirst(CAPED, 'knee_bl'))).toThrow(
      /rigPart "knee_bl" is not a bone of this humanoid rig/,
    );
  });

  test('an unpinned part rides the leg it stands next to, or the body', () => {
    const loose = structuredClone(BEAST) as unknown as {
      parts: Record<string, unknown>[];
    };
    for (const part of loose.parts)
      if (part.name === 'shank' || part.name === 'body') delete part.rigPart;
    const model = buildSpec(parseSpec(loose));
    try {
      const bound = bonesPerPart(model);
      // The shank runs down the front legs' tibia, so it lands on the knee
      // that drives it rather than on the body.
      expect([...bound.get('2')!].sort()).toEqual(['Knee_FL', 'Knee_FR']);
      // And the torso is nowhere near a leg chain, so it stays on Body.
      expect([...bound.get('0')!]).toEqual(['Body']);
    } finally {
      disposeScene(model);
    }
  });

  test('it exports a gait of its own, not the humanoid clips', () => {
    const clips = specClips(parseSpec(BEAST));
    expect(clips.map((c) => c.name)).toEqual(['Idle', 'Walk']);
    const walk = clips.find((c) => c.name === 'Walk')!;
    expect(walk.tracks.map((t) => t.name)).toContain('Hip_BR.quaternion');
    expect(walk.tracks.map((t) => t.name)).not.toContain('Thigh_L.quaternion');
  });

  test('the extras give one chain per ankle, each ending at its sole', async () => {
    const { files } = await writeAsset(
      { spec: parseSpec(BEAST) },
      { outDir: join(scratch, 'beast'), formats: ['glb'] },
    );
    const seen = await inspectGLB(files[0]);
    expect(seen.bones).toHaveLength(14);
    const extras = seen.extras as {
      bones: { name: string; end?: [number, number, number] | null }[];
      chains: { leaf: string; bones: string[] }[];
    };
    expect(extras.chains.map((c) => c.leaf)).toEqual([
      'Ankle_FL',
      'Ankle_FR',
      'Ankle_BL',
      'Ankle_BR',
    ]);
    expect(extras.chains[0].bones).toEqual([
      'Root',
      'Body',
      'Hip_FL',
      'Knee_FL',
      'Ankle_FL',
    ]);
    // The sole is measured off the paw, which stops at y 0.
    for (const leaf of extras.chains.map((c) => c.leaf)) {
      const end = extras.bones.find((b) => b.name === leaf)?.end;
      expect(end, leaf).toBeTruthy();
      expect(end![1]).toBeCloseTo(0, 2);
    }
  }, 60000);
});

/**
 * The two shipped drafts these features were built for.
 *
 * Read off disk rather than inlined: they are what a reader copies, and a
 * skeleton that quietly stopped matching the file would be the one thing this
 * file could not otherwise catch. The assertions are on the skeleton only, so
 * neither has to be re-meshed here — the CLI does that, and the worked-spec
 * sweep does it for everything under specs/.
 */
describe('the shipped drafts', () => {
  const draft = (name: string) =>
    parseSpec(
      JSON.parse(readFileSync(`specs/drafts/${name}.spec.json`, 'utf8')),
    );

  test('the caped mannequin carries 14 rig bones and a 3-bone cape', () => {
    const spec = draft('caped-mannequin');
    const layout = boneLayout(spec);
    expect(layout).toHaveLength(17);
    expect(layout.slice(14).map((b) => [b.name, b.parent])).toEqual([
      ['Cape0', 'Spine'],
      ['Cape1', 'Cape0'],
      ['Cape2', 'Cape1'],
    ]);
    expect(specClips(spec).map((c) => c.name)).toContain('Cape');
  });

  test('the quadruped walker is a body and twelve leg bones', () => {
    const spec = draft('walker-quadruped');
    expect(spec.rig?.kind).toBe('quadruped');
    expect(spec.joints).toBeUndefined();
    const layout = boneLayout(spec);
    expect(layout.map((b) => b.name)).toEqual([...QUAD_JOINTS]);
    expect(layout.filter((b) => b.name.startsWith('Ankle_'))).toHaveLength(4);
    // Every part pins its own bone, which is what a hand-authored joint rig
    // bought before and what `rigPart` buys now.
    for (const part of spec.parts) expect(part.rigPart).toBeTruthy();
  });
});

/**
 * A clip may only key the position of a bone that rests at the origin.
 *
 * A `VectorKeyframeTrack` on `<bone>.position` sets that bone's local position
 * outright rather than offsetting it, so keying one whose rest position is not
 * the origin teleports it — and takes every bone under it along. A quadruped's
 * `Body` sits a body-height up, so an Idle keyed on it drops the whole
 * creature through the floor on its first frame, while nothing interpenetrates
 * and no other check says a word. `Root` is the one bone that rests at the
 * origin, which is why every clip that moves the model moves that.
 */
describe('clips leave the skeleton where the bind pose put it', () => {
  test.each([
    ['quadruped', BEAST],
    ['humanoid with a cape', CAPED],
    ['bare mechanism', SIGN],
  ])('%s keys positions only on bones that rest at the origin', (_l, source) => {
    const spec = parseSpec(source);
    const restOf = new Map(boneLayout(spec).map((b) => [b.name, b.at]));
    const clips = specClips(spec);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips)
      for (const track of clip.tracks) {
        if (!track.name.endsWith('.position')) continue;
        const bone = track.name.slice(0, -'.position'.length);
        expect(restOf.get(bone), `${clip.name} keys ${track.name}`).toEqual([
          0, 0, 0,
        ]);
      }
  });

  test('and a quadruped stays standing for the length of its clips', () => {
    const spec = parseSpec(BEAST);
    const model = buildSpec(spec);
    try {
      const body = builtBones(model).get('Body')!;
      const standing = body.getWorldPosition(new T.Vector3()).y;
      expect(standing).toBeCloseTo(0.6, 6);
      const mixer = new T.AnimationMixer(model);
      for (const clip of specClips(spec)) {
        const action = mixer.clipAction(clip);
        action.play();
        for (let step = 0; step <= 8; step++) {
          mixer.setTime((clip.duration * step) / 8);
          model.updateMatrixWorld(true);
          const y = body.getWorldPosition(new T.Vector3()).y;
          expect(y, `${clip.name} at step ${step}`).toBeGreaterThan(
            standing - 0.1,
          );
        }
        action.stop();
      }
    } finally {
      disposeScene(model);
    }
  });
});
