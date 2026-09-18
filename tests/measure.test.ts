import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { measureSpec } from '../lib/asset-measure';
import { readySurface } from '../lib/asset-surface';
import type { AssetSpecInput } from '../lib/asset-spec';

const spec = async (file: string) =>
  JSON.parse(await readFile(`specs/${file}`, 'utf8'));

beforeAll(async () => {
  await readySurface();
});

describe('report shape', () => {
  test('a faceted spec reports boxes, bindings and no surface counts', async () => {
    const report = measureSpec(await spec('sniper-rifle.spec.json'));
    expect(report.mode).toBe('faceted');
    expect(report.name).toBe('Sniper Rifle');
    expect(report.parts.length).toBeGreaterThan(20);
    expect(report.sampling.measuredParts).toBe(report.parts.length);

    const receiver = report.parts.find((part) => part.name === 'receiver')!;
    expect(receiver.path).toEqual([0]);
    expect(receiver.copies).toBe(1);
    // The authored size, back out of the geometry.
    expect(receiver.bounds.size[2]).toBeCloseTo(0.3, 2);
    expect(receiver.bounds.centre[1]).toBeCloseTo(0.06, 2);
    // A faceted spec has no fused surface to own any of.
    expect(receiver.surfaceVertices).toBeNull();
    expect(receiver.ownsSurface).toBeNull();
    expect(receiver.nearest).not.toBeNull();

    // The joint binding is reported even though the rig is not a character.
    const bolt = report.parts.find((part) => part.name === 'bolt')!;
    expect(bolt.joint).toBe('Bolt');

    // A repeat is one part with many copies, not many parts.
    const teeth = report.parts.find((part) => part.name === 'rail-tooth')!;
    expect(teeth.copies).toBeGreaterThan(1);
  });

  test('a surface spec counts the vertices each part owns', async () => {
    const report = measureSpec(await spec('wizard.spec.json'));
    expect(report.mode).toBe('surface');
    expect(report.meshes).toBe(1);

    const hat = report.parts.find((part) => part.name === 'hat')!;
    expect(hat.surfaceVertices).toBeGreaterThan(0);
    expect(hat.ownsSurface).toBe(true);
    expect(hat.rigPart).toBe('head');
    // Every part's owned vertices come out of the one fused mesh, so they
    // cannot add up to more than it has.
    const owned = report.parts.reduce(
      (sum, part) => sum + (part.surfaceVertices ?? 0),
      0,
    );
    expect(owned).toBeGreaterThan(0);
    expect(owned).toBeLessThanOrEqual(report.triangles * 3);
  });

  test('skipping the surface pass keeps the boxes and drops the counts', async () => {
    const full = measureSpec(await spec('wizard.spec.json'), {
      parts: ['hat'],
    });
    const quick = measureSpec(await spec('wizard.spec.json'), {
      parts: ['hat'],
      surface: false,
    });
    expect(quick.mode).toBe('faceted');
    expect(quick.parts.find((p) => p.name === 'hat')!.surfaceVertices).toBeNull();
    // Same authored geometry either way.
    expect(quick.parts.find((p) => p.name === 'hat')!.bounds.size).toEqual(
      full.parts.find((p) => p.name === 'hat')!.bounds.size,
    );
    expect(quick.sampling.ms).toBeLessThan(full.sampling.ms);
  });

  test('naming a part that does not exist is an error, not an empty answer', async () => {
    await expect(async () =>
      measureSpec(await spec('sniper-rifle.spec.json'), { parts: ['stonk'] }),
    ).rejects.toThrow(/No part is called "stonk"/);
  });

  test('only the named parts are measured for gaps', async () => {
    const report = measureSpec(await spec('sniper-rifle.spec.json'), {
      parts: ['receiver', 'barrel'],
    });
    expect(report.sampling.measuredParts).toBe(2);
    expect(report.parts.filter((part) => part.nearest)).toHaveLength(2);
  });
});

describe('gap sign', () => {
  const pair = (gap: number): AssetSpecInput => ({
    version: 1,
    name: 'Pair',
    kind: 'prop',
    parts: [
      { name: 'left', shape: 'box', size: [0.2, 0.2, 0.2], position: [0, 0, 0] },
      {
        name: 'right',
        shape: 'box',
        size: [0.2, 0.2, 0.2],
        position: [0.2 + gap, 0, 0],
      },
    ],
  });

  test('two boxes apart report the clear distance between them', () => {
    const report = measureSpec(pair(0.05), { parts: ['left'] });
    const left = report.parts.find((part) => part.name === 'left')!;
    expect(left.nearest!.name).toBe('right');
    expect(left.nearest!.gap).toBeCloseTo(0.05, 3);
  });

  test('two boxes touching report zero', () => {
    const left = measureSpec(pair(0), { parts: ['left'] }).parts[0];
    expect(left.nearest!.gap).toBeCloseTo(0, 3);
  });

  test('two boxes overlapping report a negative depth', () => {
    const left = measureSpec(pair(-0.08), { parts: ['left'] }).parts[0];
    expect(left.nearest!.gap).toBeLessThan(0);
    // 8 cm of overlap; the deepest sample of one box inside the other is the
    // far face, so the depth is the overlap itself.
    expect(left.nearest!.gap).toBeCloseTo(-0.08, 2);
  });

  test('the display scale is carried into the gap', () => {
    const left = measureSpec(
      { ...pair(0.05), scale: 2 },
      { parts: ['left'] },
    ).parts[0];
    expect(left.nearest!.gap).toBeCloseTo(0.1, 3);
  });
});

describe('skeleton', () => {
  test('the octopod reports every joint with the vertices it carries', async () => {
    const report = measureSpec(await spec('octopod-walker.spec.json'));
    expect(report.skeleton[0].name).toBe('Root');
    expect(report.skeleton[0].parent).toBeNull();
    // One bone per joint, plus the static root.
    expect(report.skeleton).toHaveLength(26);

    const body = report.skeleton.find((bone) => bone.name === 'Body')!;
    expect(body.parent).toBe('Root');
    expect(body.at[1]).toBeCloseTo(0.72, 2);
    expect(body.vertices).toBeGreaterThan(0);

    // A chain: the knee hangs off the hip, which hangs off the body.
    const hip = report.skeleton.find((bone) => bone.name === 'Leg1_Hip')!;
    const knee = report.skeleton.find((bone) => bone.name === 'Leg1_Knee')!;
    expect(hip.parent).toBe('Body');
    expect(knee.parent).toBe('Leg1_Hip');
    expect(hip.vertices + knee.vertices).toBeGreaterThan(0);

    // Every vertex of the one fused mesh lands on exactly one bone.
    const bound = report.skeleton.reduce((sum, bone) => sum + bone.vertices, 0);
    expect(bound).toBe(report.sampling.riggedVertices);
  });

  test('an unrigged spec has no skeleton', async () => {
    const report = measureSpec(await spec('cottage.spec.json'));
    expect(report.skeleton).toEqual([]);
    expect(report.sampling.riggedVertices).toBe(0);
  });
});
