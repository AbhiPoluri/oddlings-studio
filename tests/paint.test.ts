import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';
import { compilePaint, paintTools } from '../lib/asset-paint';

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

const surface = { blend: 0.02, detail: 96, budget: 3000, shading: 'flat' as const };

/** A red ball sunk into a blue slab: one clean seam between two colours. */
const twoTone: AssetSpecInput = {
  version: 1,
  name: 'Two tone',
  kind: 'prop',
  surface,
  parts: [
    { name: 'slab', shape: 'box', size: [0.8, 0.3, 0.6], position: [0, 0.15, 0], color: '#2040c0' },
    { name: 'ball', shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0, 0.35, 0], color: '#c02020' },
  ],
};

describe('seams', () => {
  test('no triangle blends two colours across itself', () => {
    const geometry = meshOf(buildSpec(twoTone)).geometry;
    const color = geometry.attributes.color as T.BufferAttribute;
    const index = geometry.index!;
    let mixed = 0;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      const key = (v: number) => `${color.getX(v).toFixed(3)},${color.getY(v).toFixed(3)},${color.getZ(v).toFixed(3)}`;
      if (key(a) !== key(b) || key(b) !== key(c)) mixed++;
    }
    // Only a triangle with three different owners is left blended, and this
    // asset has two parts, so there are none.
    expect(mixed).toBe(0);
    expect(geometry.userData.rigParts).toHaveLength(color.count);
    const owners = geometry.userData.surfaceOwners as { index: Uint16Array };
    expect(owners.index.length).toBe(color.count);
  });

  test('the seam is watertight and the audit still reads one shell', () => {
    const model = buildSpec(twoTone);
    const codes = auditModel(model).findings.map((f) => f.code);
    expect(codes).toContain('one-shell');
    expect(codes).not.toContain('open-shell');
  });

  test('parts that look the same are not cut', () => {
    const plain = buildSpec({
      ...twoTone,
      parts: twoTone.parts.map((p) => Object.assign({}, p, { color: '#808080' })),
    });
    const two = buildSpec(twoTone);
    expect(meshOf(plain).geometry.attributes.position.count).toBeLessThan(
      meshOf(two).geometry.attributes.position.count,
    );
  });

  test('the seam sits where the fields cross, not on a triangle corner', () => {
    // Every seam vertex lies within a cell of the ball's surface, which is
    // where the ball's distance and the slab's distance are equal.
    const geometry = meshOf(buildSpec(twoTone)).geometry;
    const position = geometry.attributes.position as T.BufferAttribute;
    const color = geometry.attributes.color as T.BufferAttribute;
    const red = new Set<string>();
    const blue = new Set<string>();
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
      (color.getX(i) > 0.5 ? red : blue).add(key);
    }
    let seam = 0;
    let off = 0;
    for (const key of red) {
      if (!blue.has(key)) continue;
      seam++;
      const [x, y, z] = key.split(',').map(Number);
      // The ball meets the slab top (y = 0.3) on a circle of radius sqrt(0.2² - 0.05²).
      const r = Math.hypot(x, z);
      if (Math.abs(r - Math.sqrt(0.2 * 0.2 - 0.05 * 0.05)) > 0.03 || Math.abs(y - 0.3) > 0.03) off++;
    }
    expect(seam).toBeGreaterThan(10);
    expect(off / seam).toBeLessThan(0.15);
  });
});

describe('paint expressions', () => {
  test('stripes paint more than one colour on one part', () => {
    const geometry = meshOf(buildSpec({
      version: 1, name: 'Striped', kind: 'prop', surface,
      parts: [{ shape: 'sphere', size: [0.5, 0.5, 0.5], position: [0, 0.25, 0], color: '#ffffff',
        paint: "M.sin(y * 40) > 0 ? base : s.shade(base, 0.5)" }],
    })).geometry;
    const color = geometry.attributes.color as T.BufferAttribute;
    const seen = new Set<string>();
    for (let i = 0; i < color.count; i++) seen.add(color.getX(i).toFixed(2));
    expect(seen.size).toBe(2);
  });

  test('a hex string and an array both work, and the toolkit blends', () => {
    const s = paintTools(0);
    expect(s.rgb('#ff0000')).toEqual([1, 0, 0]);
    expect(s.blend([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(s.step(0, 1, 0.5)).toBeCloseTo(0.5);
    const hex = compilePaint("'#00ff00'");
    expect(hex(0, 0, 0, s, Math, [0, 0, 0], [1, 1, 1])).toBe('#00ff00');
  });

  test('a bad paint is refused at parse time', () => {
    expect(() => parseSpec({
      version: 1, name: 'Bad', kind: 'prop',
      parts: [{ shape: 'sphere', paint: 'x +' }],
    } as never)).toThrow(/does not compile/);
    expect(() => parseSpec({
      version: 1, name: 'Bad', kind: 'prop',
      parts: [{ shape: 'sphere', paint: '42' }],
    } as never)).toThrow(/must return a colour/);
  });
});
