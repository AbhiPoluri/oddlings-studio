import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';

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

/** A tall ellipsoid body with a generous cylinder wrapped round its middle. */
const belted: AssetSpecInput = {
  version: 1,
  name: 'Belted',
  kind: 'prop',
  surface: { blend: 0.01, detail: 128, budget: 6000, shading: 'flat' },
  parts: [
    { name: 'body', shape: 'sphere', size: [0.5, 1.0, 0.3], position: [0, 0.5, 0], color: '#60a040' },
    { name: 'belt', shape: 'cylinder', size: [1.2, 0.12, 1.2], position: [0, 0.5, 0], color: '#5a3a20', detail: 24,
      wrap: { on: 'body', thickness: 0.03 } },
  ],
};

describe('wrap', () => {
  test('a wrapped belt hugs the body it names, at its thickness, and nothing pokes through', () => {
    const geometry = meshOf(buildSpec(belted)).geometry;
    const position = geometry.attributes.position as T.BufferAttribute;
    const color = geometry.attributes.color as T.BufferAttribute;
    // Belt vertices (brown) sit between 0 and thickness off the ellipsoid.
    const ellipsoid = (x: number, y: number, z: number) => {
      // Radial scale factor from the centre: 1 on the surface.
      const k = Math.sqrt((x / 0.25) ** 2 + ((y - 0.5) / 0.5) ** 2 + (z / 0.15) ** 2);
      return k;
    };
    let belt = 0, bodyInBand = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      const brown = color.getX(i) < 0.5;
      if (brown) {
        belt++;
        const k = ellipsoid(x, y, z);
        // Outside the body, but not by more than the thickness (plus a cell).
        expect(k).toBeGreaterThan(0.98);
        expect((k - 1) * 0.15).toBeLessThan(0.03 + 0.012);
      } else if (Math.abs(y - 0.5) < 0.05) {
        // A green vertex at belt height would be the body poking through.
        bodyInBand++;
      }
    }
    expect(belt).toBeGreaterThan(200);
    expect(bodyInBand).toBe(0);
  });

  test('the belt is not a ring: its width follows the body', () => {
    const geometry = meshOf(buildSpec(belted)).geometry;
    const position = geometry.attributes.position as T.BufferAttribute;
    const color = geometry.attributes.color as T.BufferAttribute;
    let xMax = 0, zMax = 0;
    for (let i = 0; i < position.count; i++) {
      if (color.getX(i) >= 0.5) continue;
      xMax = Math.max(xMax, Math.abs(position.getX(i)));
      zMax = Math.max(zMax, Math.abs(position.getZ(i)));
    }
    expect(xMax).toBeGreaterThan(0.26);
    expect(xMax).toBeLessThan(0.3);
    expect(zMax).toBeGreaterThan(0.16);
    expect(zMax).toBeLessThan(0.2);
  });

  test('an unknown target is refused, and the faceted builder warns', () => {
    expect(() => buildSpec({
      ...belted,
      parts: [belted.parts[0], { ...(belted.parts[1] as object), wrap: { on: 'nobody', thickness: 0.03 } } as never],
    })).toThrow(/no part is called that/);
    const faceted = buildSpec({ ...belted, surface: undefined });
    expect(auditModel(faceted).findings.map((f) => f.code)).toContain('field-needs-surface');
  });
});
