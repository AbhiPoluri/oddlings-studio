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
const FIGURE: AssetSpecInput = {
  version: 1,
  name: 'Stubby',
  kind: 'creature',
  seed: 5,
  scale: 1,
  color: '#93cec8',
  rig: { hipHeight: 0.48, headPivot: 0.9, shoulderWidth: 0.28 },
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

  test('a spec cannot declare both a body rig and joints', () => {
    expect(() => parseSpec({ ...SIGN, rig: { hipHeight: 0.5 } })).toThrow(/one skeleton/);
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
    rig: { ...FIGURE.rig, bones: { Arm_L: [0.42, 0.7, 0.05], Head: [0, 1.05, 0.06] } },
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
    expect([...shifted.entries()].sort()).toEqual([...plain.entries()].sort());
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
      rig: { ...FIGURE.rig, bones: { Head: [0, 1.05, 0.06] } },
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
      propertyNames?: { enum?: string[] };
    };
    const schema = specJSONSchema() as unknown as Node;
    const joint = schema.properties?.joints?.items?.properties;
    expect(joint?.parent).toBeDefined();
    expect(joint?.spin?.properties?.clip).toBeDefined();
    expect(joint?.spin?.properties?.phase).toBeDefined();
    expect(
      schema.properties?.rig?.properties?.bones?.propertyNames?.enum,
    ).toContain('Forearm_R');
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
