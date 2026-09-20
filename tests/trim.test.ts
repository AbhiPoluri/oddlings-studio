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

/** A box sitting on a slab, its bottom flush with the slab's top. */
const crate: AssetSpecInput = {
  version: 1,
  name: 'Crate on slab',
  kind: 'prop',
  parts: [
    { name: 'slab', shape: 'box', size: [2, 0.2, 2], position: [0, 0.1, 0] },
    { name: 'crate', shape: 'box', size: [0.5, 0.5, 0.5], position: [0, 0.45, 0] },
    { name: 'ball', shape: 'sphere', size: [0.3, 0.3, 0.3], position: [0.6, 0.25, 0], detail: 8 },
  ],
};

function meshNamed(model: T.Object3D, spec: AssetSpecInput, name: string) {
  const index = (spec.parts as { name?: string }[]).findIndex((p) => p.name === name);
  let found: T.Mesh | undefined;
  model.traverse((o) => {
    if (o instanceof T.Mesh && (o.userData.specPath as number[])?.[0] === index) found = o;
  });
  if (!found) throw Error(`no mesh for ${name}`);
  return found;
}

describe('trimming hidden faces', () => {
  test('the crate loses its bottom and the ball its buried cap, the slab keeps its top', () => {
    const untrimmed = buildSpec({ ...crate, trim: false });
    const trimmed = buildSpec(crate);
    expect(stats(trimmed).triangles).toBeLessThan(stats(untrimmed).triangles);
    // The crate: 12 triangles minus the two on the bottom.
    expect(meshNamed(trimmed, crate, 'crate').geometry.attributes.position.count / 3).toBe(10);
    // The slab's top is bigger than the crate, so none of its faces are fully covered.
    expect(meshNamed(trimmed, crate, 'slab').geometry.attributes.position.count / 3).toBe(12);
    // The ball sinks 0.05 into the slab: the faces below the slab's top go.
    const ballMesh = meshNamed(trimmed, crate, 'ball');
    ballMesh.updateWorldMatrix(true, false);
    const ball = ballMesh.geometry.attributes.position as T.BufferAttribute;
    const v = new T.Vector3();
    let lowest = Infinity;
    for (let i = 0; i < ball.count; i++)
      lowest = Math.min(lowest, v.fromBufferAttribute(ball, i).applyMatrix4(ballMesh.matrixWorld).y);
    // Untrimmed the ball reaches y 0.10; every face below the slab's top at 0.20 is gone.
    expect(lowest).toBeGreaterThan(0.17);
    const audit = auditModel(trimmed);
    expect(audit.findings.map((f) => f.code)).toContain('trimmed');
  });

  test('parts bound to different bones do not hide each other', () => {
    const rigged: AssetSpecInput = {
      version: 1,
      name: 'Shoulder',
      kind: 'person',
      rig: { hipHeight: 0.5, headPivot: 0.9, shoulderWidth: 0.2 },
      parts: [
        { name: 'torso', shape: 'box', size: [0.4, 0.5, 0.3], position: [0, 0.7, 0], rigPart: 'spine' },
        { name: 'ball', shape: 'sphere', size: [0.2, 0.2, 0.2], position: [0.2, 0.85, 0], detail: 8, rigPart: 'arm_l' },
        { name: 'badge', shape: 'sphere', size: [0.1, 0.1, 0.1], position: [0, 0.8, 0.14], detail: 8, rigPart: 'spine' },
      ],
    };
    const model = buildSpec(rigged);
    const untrimmed = buildSpec({ ...rigged, trim: false });
    // The badge shares the spine with the torso: its buried half goes.
    expect(meshNamed(model, rigged, 'badge').geometry.attributes.position.count).toBeLessThan(
      meshNamed(untrimmed, rigged, 'badge').geometry.attributes.position.count,
    );
    // The shoulder ball is on the arm: left whole.
    expect(meshNamed(model, rigged, 'ball').geometry.attributes.position.count).toBe(
      meshNamed(untrimmed, rigged, 'ball').geometry.attributes.position.count,
    );
  });

  test('a fused build is untouched', () => {
    const fused = buildSpec({ ...crate, surface: { blend: 0.02, detail: 64, budget: 3000, shading: 'flat' } });
    expect(stats(fused).meshes).toBe(1);
    expect(auditModel(fused).findings.map((f) => f.code)).not.toContain('trimmed');
  });
});
