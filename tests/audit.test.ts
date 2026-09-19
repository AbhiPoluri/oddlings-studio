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

describe('fix hints', () => {
  // A finding says what is wrong; a hint says which way and how far. These
  // cover the three that carry one. The first is asserted end to end: apply
  // the vector the audit handed back, rebuild, and the error is gone.
  const floater = (scale: number, at: [number, number, number]): AssetSpecInput => ({
    version: 1,
    name: 'Floater',
    kind: 'prop',
    scale,
    parts: [
      { name: 'hull', shape: 'box', size: [1, 1, 1] },
      { name: 'ghost', shape: 'sphere', size: [0.2, 0.2, 0.2], position: at },
    ],
  });
  const named = (...names: string[]) =>
    new Map(names.map((name, index) => [String(index), name]));

  test('a floating part gets a move that actually fixes it', () => {
    for (const scale of [1, 2]) {
      const start: [number, number, number] = [0, 1.2, 0];
      const audit = auditModel(buildSpec(floater(scale, start)), {
        scale,
        labels: named('hull', 'ghost'),
      });
      const hint = audit.findings.find((f) => f.code === 'detached-part')!.hint!;
      expect(hint.toward).toBe('hull');
      // Straight down onto the top of the box, and in spec units: the same
      // move whatever the display scale, because scale is not geometry.
      expect(hint.move![1]).toBeLessThan(0);
      expect(hint.move![1]).toBeCloseTo(-0.6, 2);

      const moved = floater(scale, [
        start[0] + hint.move![0],
        start[1] + hint.move![1],
        start[2] + hint.move![2],
      ]);
      expect(auditModel(buildSpec(moved), { scale }).ok).toBe(true);
    }
  });

  test('a part sideways off the body is moved sideways, not down', () => {
    const audit = auditModel(buildSpec(floater(1, [1.4, 0, 0])), {
      labels: named('hull', 'ghost'),
    });
    const hint = audit.findings.find((f) => f.code === 'detached-part')!.hint!;
    expect(hint.move![0]).toBeLessThan(0);
    expect(Math.abs(hint.move![1])).toBeLessThan(0.01);
  });

  test('a buried part is pushed out along its neighbour', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const spec: AssetSpecInput = {
      version: 1,
      name: 'Buried',
      kind: 'prop',
      surface: { blend: 0.02, detail: 64, budget: 1500, shading: 'flat' },
      parts: [
        { name: 'body', shape: 'sphere', size: [0.6, 0.6, 0.6], position: [0, 0.3, 0] },
        { name: 'gem', shape: 'sphere', size: [0.1, 0.1, 0.1], position: [0, 0.3, 0.2] },
      ],
    };
    const audit = auditModel(buildSpec(spec), { labels: named('body', 'gem') });
    const hint = audit.findings.find((f) => f.code === 'no-surface')!.hint!;
    expect(hint.toward).toBe('body');
    // Out through the front of the sphere, far enough to clear the shell plus
    // one grid cell, and not sideways.
    expect(hint.move![2]).toBeGreaterThan(0.05);
    expect(Math.abs(hint.move![0])).toBeLessThan(0.01);
    expect(Math.abs(hint.move![1])).toBeLessThan(0.01);
  });

  test('a detached shell names what to fuse with and the blend that would do it', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const spec: AssetSpecInput = {
      version: 1,
      name: 'Split',
      kind: 'prop',
      surface: { blend: 0.01, detail: 64, budget: 2000, shading: 'flat' },
      parts: [
        { name: 'body', shape: 'box', size: [0.5, 0.5, 0.5] },
        { name: 'lump', shape: 'box', size: [0.2, 0.2, 0.2], position: [0, 0.5, 0] },
      ],
    };
    const audit = auditModel(buildSpec(spec), { labels: named('body', 'lump') });
    const finding = audit.findings.find((f) => f.code === 'detached-shell')!;
    expect(finding.hint!.toward).toBe('body');
    // The lump floats 0.15 above the body, and blend closes half its width.
    expect(finding.threshold).toBeCloseTo(0.15, 2);
    expect(finding.hint!.grow).toBeCloseTo(0.3, 2);
    expect(finding.hint!.move).toBeUndefined();
  });

  test('a clean model carries no hints at all', () => {
    const audit = auditModel(
      buildSpec({
        ...base,
        parts: [
          { shape: 'box', size: [1, 1, 1] },
          { shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0.5, 0, 0] },
        ],
      }),
    );
    expect(audit.findings.every((f) => f.hint === undefined)).toBe(true);
  });
});

describe('cuts', () => {
  const wall = {
    name: 'wall',
    shape: 'box' as const,
    size: [0.8, 0.8, 0.4] as [number, number, number],
  };
  const window_ = {
    name: 'window',
    shape: 'cylinder' as const,
    size: [0.3, 0.8, 0.3] as [number, number, number],
    rotation: [90, 0, 0] as [number, number, number],
    subtract: true,
  };

  test('says so when a cut was asked for and stacked solids were built', () => {
    // The faceted builder has no CSG. It puts the window-shaped block where
    // the window should be and nothing about the geometry looks wrong, so the
    // only place this can be caught is against the authored intent.
    const audit = auditModel(
      buildSpec({ ...base, parts: [wall, window_] }),
      { labels: new Map([['0', 'wall'], ['1', 'window']]) },
    );
    const finding = audit.findings.find(
      (f) => f.code === 'subtract-needs-surface',
    );
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toContain('window');
    expect(finding?.part).toEqual([1]);
    // A warning, not an error: the asset still builds and still exports.
    expect(audit.ok).toBe(true);
  });

  test('counts the copies of a cut that was not made', () => {
    const audit = auditModel(
      buildSpec({
        ...base,
        parts: [
          wall,
          {
            ...window_,
            position: [-0.2, 0, 0] as [number, number, number],
            repeat: { count: 3, mode: 'linear' as const, offset: [0.2, 0, 0] as [number, number, number] },
          },
        ],
      }),
    );
    expect(
      audit.findings.find((f) => f.code === 'subtract-needs-surface')?.value,
    ).toBe(3);
  });

  test('says nothing at all once the spec asks for a surface', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const audit = auditModel(
      buildSpec({
        ...base,
        surface: { blend: 0.02, detail: 64, budget: 4000, shading: 'flat' as const },
        parts: [wall, window_],
      }),
    );
    expect(audit.findings.map((f) => f.code)).not.toContain(
      'subtract-needs-surface',
    );
    // And the cut's own walls are surface, so nothing reports it missing.
    expect(audit.findings.map((f) => f.code)).not.toContain('no-surface');
  });

  test('does not ask an author to expose a cut that removed nothing', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const audit = auditModel(
      buildSpec({
        ...base,
        surface: { blend: 0.02, detail: 64, budget: 4000, shading: 'flat' as const },
        parts: [
          wall,
          // Sunk entirely inside the wall's own bulk would still cut; this one
          // is nowhere near it, so it carves nothing and owns nothing.
          {
            name: 'missed',
            shape: 'sphere' as const,
            size: [0.1, 0.1, 0.1] as [number, number, number],
            position: [2, 0, 0] as [number, number, number],
            subtract: true,
          },
        ],
      }),
      { labels: new Map([['0', 'wall'], ['1', 'missed']]) },
    );
    expect(audit.findings.map((f) => f.code)).not.toContain('no-surface');
  });
});
