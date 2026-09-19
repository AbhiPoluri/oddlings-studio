import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';
import { creaseSplit, weldByPosition } from '../lib/asset-smooth';

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

/** Weld a non-indexed geometry by position. */
function mergeVertices(geometry: T.BufferGeometry) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const seen = new Map<string, number>();
  const out: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
    let v = seen.get(key);
    if (v === undefined) {
      v = out.length / 3;
      seen.set(key, v);
      out.push(position.getX(i), position.getY(i), position.getZ(i));
    }
    index.push(v);
  }
  const made = new T.BufferGeometry();
  made.setAttribute('position', new T.BufferAttribute(Float32Array.from(out), 3));
  made.setIndex(new T.BufferAttribute(Uint32Array.from(index), 1));
  return made;
}

describe('crease normals', () => {
  test('a box splits at every corner and a ball at none', () => {
    const box = mergeVertices(new T.BoxGeometry(1, 1, 1).toNonIndexed());
    expect(box.attributes.position.count).toBe(8);
    box.userData.surfaceOwners = { index: Uint16Array.from([0, 1, 2, 3, 4, 5, 6, 7]), paths: [] };
    box.userData.rigParts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const creased = creaseSplit(box, 45);
    expect(creased.attributes.position.count).toBe(24);
    expect(creased.index!.count).toBe(box.index!.count);
    // A split vertex owns what its welded source owned.
    const source = creased.userData.creaseSource as Uint32Array;
    const owners = (creased.userData.surfaceOwners as { index: Uint16Array }).index;
    const rigParts = creased.userData.rigParts as string[];
    for (let i = 0; i < 24; i++) {
      expect(owners[i]).toBe(source[i]);
      expect(rigParts[i]).toBe('abcdefgh'[source[i]]);
    }
    const normal = creased.attributes.normal as T.BufferAttribute;
    // Every split vertex's normal is one of the six face normals.
    for (let i = 0; i < normal.count; i++) {
      const n = [normal.getX(i), normal.getY(i), normal.getZ(i)].map(Math.abs);
      expect(Math.max(...n)).toBeCloseTo(1, 5);
    }
    const ball = mergeVertices(new T.IcosahedronGeometry(1, 3).toNonIndexed());
    const round = creaseSplit(ball, 45);
    expect(round.attributes.position.count).toBe(ball.attributes.position.count);
  });

  test('0 degrees is flat and 180 is smooth', () => {
    const ball = mergeVertices(new T.IcosahedronGeometry(1, 2).toNonIndexed());
    expect(creaseSplit(ball, 0).attributes.position.count).toBe(ball.index!.count);
    expect(creaseSplit(ball, 180).attributes.position.count).toBe(ball.attributes.position.count);
  });

  test('carries owners and rig parts across the split and keeps the shell closed', () => {
    const model = buildSpec({
      version: 1,
      name: 'Bar',
      kind: 'prop',
      surface: { blend: 0, detail: 64, budget: 3000, shading: 'flat', crease: 40 },
      parts: [
        { name: 'slab', shape: 'box', size: [0.8, 0.3, 0.5], position: [0, 0.15, 0] },
        { name: 'knob', shape: 'sphere', size: [0.2, 0.2, 0.2], position: [0, 0.35, 0], color: '#ff0000' },
      ],
    });
    const geometry = meshOf(model).geometry;
    const count = geometry.attributes.position.count;
    expect(geometry.attributes.normal).toBeDefined();
    const owners = geometry.userData.surfaceOwners as { index: Uint16Array };
    expect(owners.index.length).toBe(count);
    expect((geometry.userData.rigParts as unknown[]).length).toBe(count);
    const source = geometry.userData.creaseSource as Uint32Array;
    expect(source.length).toBe(count);
    const canon = weldByPosition(geometry);
    expect(new Set(canon).size).toBeLessThan(count);
    const findings = auditModel(model).findings.map((f) => f.code);
    expect(findings).toContain('one-shell');
    expect(findings).not.toContain('open-shell');
    expect((meshOf(model).material as T.MeshStandardMaterial).flatShading).toBe(false);
  });
});
