import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { auditModel } from '../lib/asset-audit';
import { buildSpec, type AssetSpecInput } from '../lib/asset-spec';
import { buildAsset } from '../lib/asset-build';
import { generateBlueprint, blueprints, type Blueprint } from '../lib/procedural-director';

const codes = (spec: AssetSpecInput, rigged = false) =>
  auditModel(buildSpec(spec), { rigged, scale: spec.scale })
    .findings.filter((f) => f.severity === 'error')
    .map((f) => f.code);

const base = { version: 1 as const, name: 'T', kind: 'prop' as const };

describe('detachment', () => {
  test('passes when parts overlap', () => {
    const spec: AssetSpecInput = {
      ...base,
      parts: [
        { shape: 'box', size: [1, 1, 1] },
        { shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0.5, 0, 0] },
      ],
    };
    expect(auditModel(buildSpec(spec)).ok).toBe(true);
    expect(codes(spec)).toEqual([]);
  });

  test('flags a part hanging in mid-air', () => {
    const spec: AssetSpecInput = {
      ...base,
      parts: [
        { shape: 'box', size: [1, 1, 1] },
        { name: 'ghost', shape: 'sphere', size: [0.2, 0.2, 0.2], position: [3, 0, 0] },
      ],
    };
    const audit = auditModel(buildSpec(spec));
    expect(audit.ok).toBe(false);
    const detached = audit.findings.find((f) => f.code === 'detached-part');
    expect(detached?.message).toContain('mid-air');
    expect(detached?.part).toEqual([1]);
  });

  test('reports only the copies that float, not the whole part', () => {
    const spec: AssetSpecInput = {
      ...base,
      parts: [
        { shape: 'box', size: [2, 0.2, 0.2] },
        {
          name: 'peg',
          shape: 'box',
          size: [0.15, 0.15, 0.15],
          position: [-0.8, 0, 0],
          // Three land on the 2 m bar; the fourth steps off the end of it.
          repeat: { count: 4, mode: 'linear', offset: [0.75, 0, 0] },
        },
      ],
    };
    const finding = auditModel(buildSpec(spec)).findings.find(
      (f) => f.code === 'detached-part',
    );
    expect(finding).toBeDefined();
    expect(finding!.value).toBeLessThan(finding!.threshold!);
  });

  test('an embedded part is not called detached just because it is small', () => {
    // A window sunk into a tall tower: coarse sampling on the tower must not
    // make the window look adrift.
    const spec: AssetSpecInput = {
      ...base,
      parts: [
        { shape: 'cylinder', size: [1, 4, 1], position: [0, 2, 0], detail: 8 },
        { name: 'window', shape: 'box', size: [0.2, 0.2, 0.2], position: [0.42, 3, 0] },
      ],
    };
    expect(codes(spec)).toEqual([]);
  });
});

describe('rig weighting', () => {
  const figure = (height: number, pinned: boolean): AssetSpecInput => ({
    version: 1,
    name: 'Figure',
    kind: 'person',
    rig: {},
    parts: [
      { name: 'head', shape: 'box', size: [0.3, 0.3, 0.3], position: [0, height - 0.15, 0], ...(pinned ? { rigPart: 'head' as const } : {}) },
      // Stacked so each box meets the one above it; a gap here would be a
      // detached-part error, which is the audit working, not a rig problem.
      { name: 'torso', shape: 'box', size: [0.5, height * 0.4, 0.3], position: [0, height - 0.3 - height * 0.2, 0], ...(pinned ? { rigPart: 'spine' as const } : {}) },
      { name: 'legs', shape: 'box', size: [0.4, height * 0.45, 0.3], position: [0, height - 0.3 - height * 0.4 - height * 0.225, 0], ...(pinned ? { rigPart: 'thigh_l' as const } : {}) },
    ],
  });

  test('a figure built in the supported range passes', () => {
    expect(codes(figure(1.2, false), true)).toEqual([]);
  });

  test('a too-tall figure relying on auto-weighting is rejected', () => {
    const found = codes(figure(1.9, false), true);
    expect(found).toContain('rig-scale');
    expect(found).toContain('rig-head-heavy');
  });

  test('the same figure passes once every part pins its bone', () => {
    expect(codes(figure(1.9, true), true)).toEqual([]);
  });

  test('display scale is not mistaken for a rig-sized model', () => {
    // 1.2 m of geometry shown at 2x is still 1.2 m to the rigger.
    expect(codes({ ...figure(1.2, false), scale: 2 }, true)).toEqual([]);
  });

  test('warns when nothing will follow a leg bone', () => {
    const audit = auditModel(
      buildSpec({
        version: 1,
        name: 'Floater',
        kind: 'creature',
        rig: {},
        parts: [{ shape: 'box', size: [0.4, 0.4, 0.4], position: [0, 1.0, 0], rigPart: 'head' }],
      }),
      { rigged: true },
    );
    expect(audit.findings.map((f) => f.code)).toContain('rig-no-legs');
  });
});

describe('scope and cost', () => {
  test('every shipped spec example is checked, and the knight is clean', () => {
    const knight = auditModel(
      buildSpec({
        version: 1, name: 'K', kind: 'person', rig: { hipHeight: 0.5, headPivot: 0.88, shoulderWidth: 0.26 },
        parts: [
          { shape: 'box', size: [0.28, 0.3, 0.28], position: [0, 1.0, 0], rigPart: 'head' },
          { shape: 'box', size: [0.42, 0.4, 0.26], position: [0, 0.78, 0], rigPart: 'spine' },
          { shape: 'box', size: [0.3, 0.5, 0.24], position: [0, 0.4, 0], rigPart: 'thigh_l' },
        ],
      }),
      { rigged: true },
    );
    expect(knight.ok).toBe(true);
  });

  test('generator output is never reported on, since its meshes are hand-placed', () => {
    for (const key of Object.keys(blueprints) as Blueprint[]) {
      const recipe = generateBlueprint(key, 11);
      const audit = auditModel(buildAsset(recipe), {
        rigged: recipe.rigged && (recipe.kind === 'creature' || recipe.kind === 'person'),
        scale: recipe.scale,
      });
      expect(audit.findings.map((f) => f.code)).not.toContain('detached-part');
    }
  });

  test('a dense environment audits quickly', () => {
    const start = Date.now();
    auditModel(buildAsset(generateBlueprint('grove', 3)));
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test('an empty model is an error, not a crash', () => {
    const audit = auditModel(new T.Group());
    expect(audit.ok).toBe(false);
    expect(audit.findings[0].code).toBe('empty');
  });
});
