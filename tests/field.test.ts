import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, parseSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';
import { stats } from '../lib/asset-build';
import { compileField, fieldTools } from '../lib/asset-sdf';

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

function boundaryEdges(geometry: T.BufferGeometry) {
  const index = geometry.index!;
  const uses = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const t = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of uses.values()) if (n === 1) open++;
  return open;
}

const surface = { blend: 0, detail: 96, budget: 100000, shading: 'flat' as const };

describe('field parts', () => {
  test('the toolkit measures exact distances', () => {
    const s = fieldTools(1);
    expect(s.sphere(0, 0, 0, 0.5)).toBeCloseTo(-0.5);
    expect(s.sphere(1, 0, 0, 0.5)).toBeCloseTo(0.5);
    expect(s.box(0.6, 0, 0, 0.5, 0.5, 0.5)).toBeCloseTo(0.1);
    expect(s.cyl(0, 0.7, 0, 0.5, 0.5)).toBeCloseTo(0.2);
    expect(s.torus(0.5, 0, 0, 0.5, 0.1)).toBeCloseTo(-0.1);
    expect(s.rep(1.3, 1)).toBeCloseTo(0.3);
    expect(s.onion(-0.2, 0.05)).toBeCloseTo(0.15);
  });

  test('a field with no expression is a sphere that honours its size', () => {
    const model = buildSpec({
      version: 1, name: 'F', kind: 'prop', surface,
      parts: [{ shape: 'field', size: [0.6, 0.4, 0.5] }],
    });
    const [x, y, z] = stats(model).size;
    expect(x).toBeGreaterThan(0.57); expect(x).toBeLessThan(0.62);
    expect(y).toBeGreaterThan(0.38); expect(y).toBeLessThan(0.41);
    expect(z).toBeGreaterThan(0.47); expect(z).toBeLessThan(0.51);
    expect(boundaryEdges(meshOf(model).geometry)).toBe(0);
  });

  test('a displaced field builds a closed shell when its lipschitz bound is declared', () => {
    const model = buildSpec({
      version: 1, name: 'Bark', kind: 'prop', surface: { ...surface, detail: 128 },
      parts: [{
        shape: 'field', size: [0.6, 1.0, 0.6], lipschitz: 4,
        field: 's.cyl(x, y, z, 0.4, 0.45) + 0.03 * M.sin(M.atan2(z, x) * 16) + 0.03 * s.fbm(x * 8, y * 8, z * 8)',
      }],
    });
    const geometry = meshOf(model).geometry;
    expect(boundaryEdges(geometry)).toBe(0);
    expect(auditModel(model).findings.map((f) => f.code)).toContain('one-shell');
    // The ridges are there: the radius varies around the trunk.
    const position = geometry.attributes.position as T.BufferAttribute;
    let rmin = 9, rmax = 0;
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(position.getY(i)) > 0.3) continue;
      const r = Math.hypot(position.getX(i), position.getZ(i));
      rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
    }
    expect(rmax - rmin).toBeGreaterThan(0.02);
  });

  test('a multi-line body with return works and compiles once', () => {
    const fn = compileField('const d = s.sphere(x, y, z, 0.4);\nreturn s.onion(d, 0.05);');
    expect(fn).toBe(compileField('const d = s.sphere(x, y, z, 0.4);\nreturn s.onion(d, 0.05);'));
    expect(fn(0, 0, 0, fieldTools(0), Math)).toBeCloseTo(0.35);
  });

  test('a broken expression is refused at parse time, and field belongs to field', () => {
    expect(() => parseSpec({
      version: 1, name: 'Bad', kind: 'prop',
      parts: [{ shape: 'field', field: 's.sphere(x, y, z' }],
    } as never)).toThrow(/does not compile/);
    expect(() => parseSpec({
      version: 1, name: 'Bad', kind: 'prop',
      parts: [{ shape: 'field', field: 'undefined' }],
    } as never)).toThrow(/finite number/);
    expect(() => parseSpec({
      version: 1, name: 'Bad', kind: 'prop',
      parts: [{ shape: 'sphere', field: 's.sphere(x,y,z,0.5)' }],
    } as never)).toThrow(/belongs to field/);
  });

  test('the faceted builder draws the bounding box and the audit says so', () => {
    const model = buildSpec({
      version: 1, name: 'Boxed', kind: 'prop',
      parts: [{ shape: 'field', size: [0.6, 0.4, 0.5], field: 's.sphere(x, y, z, 0.5)' }],
    });
    expect(auditModel(model).findings.map((f) => f.code)).toContain('field-needs-surface');
  });
});
