import '../lib/node-shims';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { boneLayout } from '../lib/asset-joints';
import { rigExtras, type RigExtras } from '../lib/asset-rig-extras';
import { readySurface } from '../lib/asset-surface';
import { disposeScene } from '../lib/three-world';
import { writeAsset, inspectGLB } from '../node/write-asset';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-rig-extras-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));
beforeAll(readySurface);

/** Where each leg stands, and the pivot heights every leg shares. */
const LEGS = [
  ['fl', 0.3, 0.4],
  ['fr', -0.3, 0.4],
  ['bl', 0.3, -0.4],
  ['br', -0.3, -0.4],
] as const;
const HIP = 0.6;
const KNEE = 0.35;
const ANKLE = 0.15;
/** The sole: the foot box's underside, which is where a leaf tip should land. */
const SOLE = 0;

/**
 * A four-legged walker: a body on hip → knee → ankle chains.
 *
 * Built inline rather than read from specs/, so the numbers the assertions
 * check are in front of the reader and no shipped asset can move them. `sole`
 * is where the feet stop, so a test can move the geometry under an unmoved
 * ankle and watch the tip follow it.
 */
function walker(sole = SOLE): AssetSpecInput {
  return {
    version: 1,
    name: 'Test Walker',
    kind: 'creature',
    seed: 5,
    scale: 1,
    color: '#8899aa',
    joints: LEGS.flatMap(([tag, x, z]) => [
      {
        name: `hip_${tag}`,
        at: [x, HIP, z] as [number, number, number],
        binds: [`thigh_${tag}`],
      },
      {
        name: `knee_${tag}`,
        at: [x, KNEE, z] as [number, number, number],
        parent: `hip_${tag}`,
        binds: [`shin_${tag}`],
      },
      {
        name: `ankle_${tag}`,
        at: [x, ANKLE, z] as [number, number, number],
        parent: `knee_${tag}`,
        binds: [`foot_${tag}`],
        spin: { axis: 'x', degrees: 14, seconds: 1.6, clip: 'Walk' },
      },
    ]),
    parts: [
      {
        name: 'body',
        shape: 'box',
        size: [0.6, 0.3, 0.9],
        position: [0, 0.75, 0],
      },
      ...LEGS.flatMap(([tag, x, z]) => [
        {
          name: `thigh_${tag}`,
          shape: 'box' as const,
          size: [0.1, HIP - KNEE, 0.1] as [number, number, number],
          position: [x, (HIP + KNEE) / 2, z] as [number, number, number],
        },
        {
          name: `shin_${tag}`,
          shape: 'box' as const,
          size: [0.08, KNEE - ANKLE, 0.08] as [number, number, number],
          position: [x, (KNEE + ANKLE) / 2, z] as [number, number, number],
        },
        {
          name: `foot_${tag}`,
          shape: 'box' as const,
          size: [0.12, ANKLE - sole, 0.2] as [number, number, number],
          position: [x, (ANKLE + sole) / 2, z] as [number, number, number],
        },
      ]),
    ],
  };
}

/** Build, read the rig out of it, and put the model back. */
function extrasOf(input: AssetSpecInput) {
  const spec = parseSpec(input);
  const model = buildSpec(spec);
  try {
    return { spec, extras: rigExtras(spec, model)! };
  } finally {
    disposeScene(model);
  }
}

describe('joint rigs', () => {
  test('every bone carries its pivot, parent and skeleton index', () => {
    const { spec, extras } = extrasOf(walker());
    const layout = boneLayout(spec);
    expect(extras.bones).toHaveLength(13);
    expect(extras.bones.map((bone) => bone.name)).toEqual(
      layout.map((place) => place.name),
    );
    expect(extras.bones.map((bone) => bone.parent)).toEqual(
      layout.map((place) => place.parent),
    );
    expect(extras.bones.map((bone) => bone.at)).toEqual(
      layout.map((place) => place.at),
    );
    expect(extras.bones.map((bone) => bone.index)).toEqual([
      ...Array(13).keys(),
    ]);
    // The body every chain hangs off, which the hand-written sidecars carried
    // as `body` and a game needs to place the model on the ground.
    expect(extras.root).toEqual({ name: 'Root', at: [0, 0, 0] });
    expect(extras.scale).toBe(1);
  });

  test('a chain per leg, listed root first', () => {
    const { extras } = extrasOf(walker());
    expect(extras.chains).toHaveLength(4);
    expect(extras.chains.map((chain) => chain.leaf)).toEqual(
      LEGS.map(([tag]) => `ankle_${tag}`),
    );
    for (const [tag] of LEGS)
      expect(
        extras.chains.find((chain) => chain.leaf === `ankle_${tag}`)?.bones,
      ).toEqual(['Root', `hip_${tag}`, `knee_${tag}`, `ankle_${tag}`]);
  });

  test('a leaf tip lands on the sole of the foot bound to it', () => {
    const { extras } = extrasOf(walker());
    const ends = new Map(extras.bones.map((bone) => [bone.name, bone.end]));
    for (const [tag, x, z] of LEGS) {
      // Straight down the knee → ankle chain, at the underside of the foot
      // box: derived from the geometry, not from the pivot.
      expect(ends.get(`ankle_${tag}`)).toEqual([x, SOLE, z]);
    }
    // Only leaves report a tip. A bone with a child already ends at that
    // child's pivot, and saying so twice invites the two to disagree.
    expect(ends.get('hip_fl')).toBeUndefined();
    expect(ends.get('Root')).toBeUndefined();
  });

  test('the tip follows the geometry, not the pivot', () => {
    // Same skeleton, shorter feet: the ankles have not moved, so a tip that
    // came from the pivot would not move either.
    const { extras } = extrasOf(walker(ANKLE - 0.05));
    for (const [tag] of LEGS) {
      const tip = extras.bones.find(
        (bone) => bone.name === `ankle_${tag}`,
      )!.end!;
      expect(tip[1]).toBeCloseTo(ANKLE - 0.05, 4);
    }
  });

  test('the rig survives a round trip through the GLB', async () => {
    const spec = parseSpec(walker());
    const written = await writeAsset(
      { spec },
      { outDir: join(scratch, 'walker'), formats: ['glb'] },
    );
    const loaded = await inspectGLB(written.files[0]);
    expect(loaded.extras).toEqual(extrasOf(walker()).extras);
    expect(loaded.bones).toEqual(
      (loaded.extras as RigExtras).bones.map((bone) => bone.name),
    );
  });

  test('the surface backend measures the same skeleton', () => {
    const fused = walker();
    // Coarse on purpose: the test is that a fused shell binds and measures at
    // all, and a fine one costs seconds to mesh.
    fused.surface = { blend: 0.01, detail: 64, budget: 1200 };
    const { extras } = extrasOf(fused);
    const faceted = extrasOf(walker()).extras;
    expect(extras.bones.map((bone) => bone.at)).toEqual(
      faceted.bones.map((bone) => bone.at),
    );
    for (const [tag, x, z] of LEGS) {
      const tip = extras.bones.find(
        (bone) => bone.name === `ankle_${tag}`,
      )!.end!;
      // The blended shell rounds the sole off, so it sits near the faceted
      // one rather than on it — but under the ankle, not at it.
      expect(tip[1]).toBeLessThan(ANKLE - 0.05);
      expect(tip[1]).toBeGreaterThan(SOLE - 0.06);
      expect(tip[0]).toBeCloseTo(x, 2);
      expect(tip[2]).toBeCloseTo(z, 2);
    }
  });
});

describe('humanoid rigs', () => {
  test('the wizard exports all 14 bones and five limb chains', () => {
    const wizard = JSON.parse(
      readFileSync(
        new URL('../specs/wizard.spec.json', import.meta.url),
        'utf8',
      ),
    ) as AssetSpecInput;
    // The shipped spec meshes at detail 320, which is a slow build for a test
    // that only reads the skeleton off it.
    wizard.surface = { blend: 0.014, detail: 72, budget: 1500 };
    const { spec, extras } = extrasOf(wizard);

    expect(extras.bones.map((bone) => bone.name)).toEqual(
      boneLayout(spec).map((place) => place.name),
    );
    expect(extras.bones).toHaveLength(14);
    expect(extras.bones[0]).toMatchObject({ name: 'Root', parent: null });
    expect(extras.chains.map((chain) => chain.leaf).sort()).toEqual([
      'Foot_L',
      'Foot_R',
      'Forearm_L',
      'Forearm_R',
      'Head',
    ]);
    expect(
      extras.chains.find((chain) => chain.leaf === 'Foot_L')?.bones,
    ).toEqual(['Root', 'Hips', 'Thigh_L', 'Shin_L', 'Foot_L']);

    const bone = (name: string) =>
      extras.bones.find((entry) => entry.name === name)!;
    // A head ends above its pivot and a foot below its ankle: the tips come
    // off the body, so they answer where the model touches the ground.
    expect(bone('Head').end![1]).toBeGreaterThan(bone('Head').at[1]);
    for (const foot of ['Foot_L', 'Foot_R'])
      expect(bone(foot).end![1]).toBeLessThan(bone(foot).at[1]);
  });
});
