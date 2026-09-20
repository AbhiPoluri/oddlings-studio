import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';
import { stats } from '../lib/asset-build';

beforeAll(async () => {
  await readySurface();
});

function meshOf(model: T.Object3D) {
  let found: T.Mesh | undefined;
  model.traverse((o) => {
    if (!found && o instanceof T.Mesh) found = o;
  });
  if (!found) throw Error('no mesh');
  return found;
}

/** A ball studded with small bumps: fine detail the eye does not need at a distance. */
const studded: AssetSpecInput = {
  version: 1,
  name: 'Studded',
  kind: 'prop',
  surface: { blend: 0.01, detail: 128, budget: 1500, shading: 'flat' },
  parts: [
    { name: 'ball', shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0] },
    { name: 'stud', shape: 'sphere', size: [0.05, 0.05, 0.05], position: [0, 0.5, 0.5], color: '#ff0000',
      repeat: { count: 60, mode: 'surface', embed: 0.4 } },
  ],
};

function ripple(model: T.Object3D) {
  const position = meshOf(model).geometry.attributes.position as T.BufferAttribute;
  const centre = new T.Vector3(0, 0.5, 0), v = new T.Vector3();
  const r: number[] = [];
  for (let i = 0; i < position.count; i++) r.push(v.fromBufferAttribute(position, i).distanceTo(centre));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / r.length);
}

describe('surface.feature', () => {
  test('a feature size lets small bumps flatten at the same budget', () => {
    const tight = buildSpec(studded);
    const loose = buildSpec({ ...studded, surface: { ...studded.surface!, feature: 0.06 } });
    expect(stats(tight).triangles).toBeLessThanOrEqual(1500 * 1.02);
    expect(stats(loose).triangles).toBeLessThanOrEqual(1500 * 1.02);
    // With bumps allowed to flatten the shell is rounder: less radius spread.
    expect(ripple(loose)).toBeLessThan(ripple(tight));
  });

  test('the audit says where the triangles went', () => {
    const audit = auditModel(buildSpec(studded), { labels: new Map([['0', 'ball'], ['1', 'stud']]) });
    const budget = audit.findings.find((f) => f.code === 'budget');
    expect(budget).toBeDefined();
    expect(budget!.message).toMatch(/Triangles by part/);
    expect(budget!.message).toMatch(/stud/);
  });
});
