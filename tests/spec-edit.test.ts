import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import {
  flatten,
  partAt,
  updatePart,
  deletePart,
  duplicatePart,
  samePath,
  copiesOf,
  frameOf,
  frameIsExact,
  transformPatch,
  applyTransform,
} from '../lib/spec-edit';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { stats } from '../lib/asset-build';

const source: AssetSpecInput = {
  version: 1,
  name: 'Editable',
  kind: 'prop',
  parts: [
    {
      name: 'body',
      shape: 'box',
      size: [1, 1, 1],
      children: [
        { name: 'knob', shape: 'sphere', size: [0.2, 0.2, 0.2] },
        { name: 'fin', shape: 'cone', size: [0.2, 0.3, 0.2], mirror: 'x' },
      ],
    },
    {
      name: 'ring',
      shape: 'torus',
      size: [0.5, 0.5, 0.2],
      repeat: { count: 3, mode: 'linear', offset: [0, 0.3, 0] },
    },
  ],
};
const spec = parseSpec(source);

describe('addressing', () => {
  test('flatten walks the tree depth-first with paths and depths', () => {
    expect(flatten(spec).map((r) => [r.path.join('.'), r.depth])).toEqual([
      ['0', 0],
      ['0.0', 1],
      ['0.1', 1],
      ['1', 0],
    ]);
  });

  test('reports how many meshes each authored part becomes', () => {
    const rows = flatten(spec);
    expect(rows.find((r) => r.part.name === 'fin')!.copies).toBe(2);
    expect(rows.find((r) => r.part.name === 'ring')!.copies).toBe(3);
    expect(rows.find((r) => r.part.name === 'body')!.copies).toBe(1);
    expect(copiesOf({ repeat: { count: 4 }, mirror: 'x' })).toBe(8);
  });

  test('partAt resolves nested paths and misses cleanly', () => {
    expect(partAt(spec, [0, 1])?.name).toBe('fin');
    expect(partAt(spec, [9])).toBeUndefined();
    expect(partAt(spec, [0, 0, 0])).toBeUndefined();
  });

  test('samePath compares by value', () => {
    expect(samePath([0, 1], [0, 1])).toBe(true);
    expect(samePath([0, 1], [0, 2])).toBe(false);
    expect(samePath(null, null)).toBe(true);
    expect(samePath([0], null)).toBe(false);
  });

  test('the mesh path matches the authored path', () => {
    const model = buildSpec(spec);
    const paths = new Set<string>();
    model.traverse((o) => {
      if (o instanceof T.Mesh)
        paths.add(JSON.stringify(o.userData.specPath));
    });
    expect(paths).toEqual(
      new Set(['[0]', '[0,0]', '[0,1]', '[1]'].map((p) => p)),
    );
  });
});

describe('editing', () => {
  test('updates a nested part without touching its siblings', () => {
    const next = updatePart(spec, [0, 1], { size: [0.4, 0.6, 0.4] });
    expect(partAt(next, [0, 1])?.size).toEqual([0.4, 0.6, 0.4]);
    expect(partAt(next, [0, 0])).toEqual(partAt(spec, [0, 0]));
    expect(spec.parts[0].children![1].size).toEqual([0.2, 0.3, 0.2]);
  });

  test('clears a field when the patch value is undefined', () => {
    const coloured = updatePart(spec, [1], { color: '#ff0000' });
    expect(partAt(coloured, [1])?.color).toBe('#ff0000');
    const cleared = updatePart(coloured, [1], { color: undefined });
    expect('color' in (partAt(cleared, [1]) as object)).toBe(false);
  });

  test('rejects an edit the builder could not honour', () => {
    expect(() => updatePart(spec, [1], { detail: 999 })).toThrow(
      /Invalid asset spec/,
    );
    expect(() => updatePart(spec, [1], { color: 'red' as never })).toThrow();
  });

  test('deletes a part and renumbers the paths after it', () => {
    const next = deletePart(spec, [0, 0]);
    expect(partAt(next, [0, 0])?.name).toBe('fin');
    expect(flatten(next)).toHaveLength(3);
  });

  test('refuses to delete the only top-level part', () => {
    const single = parseSpec({
      ...source,
      parts: [{ shape: 'box', size: [1, 1, 1] }],
    });
    expect(() => deletePart(single, [0])).toThrow(/at least one part/);
  });

  test('duplicate inserts a deep copy after the original and returns its path', () => {
    const { spec: next, path } = duplicatePart(spec, [0]);
    expect(path).toEqual([1]);
    expect(next.parts).toHaveLength(3);
    expect(partAt(next, [1])?.children).toHaveLength(2);
    // A deep copy, not a shared reference.
    const edited = updatePart(next, [1, 0], { size: [9, 9, 9] });
    expect(partAt(edited, [0, 0])?.size).toEqual([0.2, 0.2, 0.2]);
  });

  test('a duplicated branch doubles the meshes it contributes', () => {
    const before = stats(buildSpec(spec)).meshes;
    const { spec: next } = duplicatePart(spec, [0]);
    // body + knob + two fins = four meshes added.
    expect(stats(buildSpec(next)).meshes).toBe(before + 4);
  });

  test('edits survive a round trip through the builder', () => {
    const next = updatePart(spec, [1], {
      repeat: { count: 6, mode: 'linear', offset: [0, 0.3, 0] },
    });
    expect(stats(buildSpec(next)).meshes).toBe(
      stats(buildSpec(spec)).meshes + 3,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Direct manipulation
 * ------------------------------------------------------------------------ */

/**
 * A part under a parent that is both moved and turned, at a spec scale that is
 * not 1 — the arrangement where every world-to-local mistake shows up.
 */
const posed = parseSpec({
  version: 1,
  name: 'Posed',
  kind: 'prop',
  scale: 2,
  parts: [
    {
      name: 'arm',
      shape: 'box',
      size: [0.4, 0.4, 0.4],
      position: [0.5, 0.25, -0.1],
      rotation: [0, 90, 0],
      children: [
        {
          name: 'hand',
          shape: 'box',
          size: [0.2, 0.2, 0.2],
          position: [0.3, 0, 0],
          rotation: [0, 0, 30],
        },
        {
          name: 'bone',
          shape: 'limb',
          from: [0, 0, 0],
          to: [0.4, 0.1, 0],
          radius: 0.05,
        },
      ],
    },
  ],
} satisfies AssetSpecInput);

/** Meshes are what the user sees, so every assertion measures those. */
function boxOf(model: T.Object3D, path: number[]) {
  const box = new T.Box3();
  model.traverse((o) => {
    if (o instanceof T.Mesh && samePath(o.userData.specPath ?? null, path))
      box.expandByObject(o);
  });
  return box;
}
const centreOf = (model: T.Object3D, path: number[]) =>
  boxOf(model, path).getCenter(new T.Vector3());
const sizeOf = (model: T.Object3D, path: number[]) =>
  boxOf(model, path).getSize(new T.Vector3());

/** The world rotation of the holder the builder made for a path. */
function holderTurnOf(model: T.Object3D, path: number[]) {
  let found = new T.Quaternion();
  model.traverse((o) => {
    if (o instanceof T.Mesh && samePath(o.userData.specPath ?? null, path))
      found = o.parent!.getWorldQuaternion(new T.Quaternion());
  });
  return found;
}

describe('frames', () => {
  test('frameOf reproduces the holder the builder actually creates', () => {
    const model = buildSpec(posed);
    let mesh: T.Mesh | undefined;
    model.traverse((o) => {
      if (o instanceof T.Mesh && samePath(o.userData.specPath ?? null, [0, 0]))
        mesh = o;
    });
    const frame = frameOf(posed, [0, 0]);
    expect(
      frame.parent.elements.map((n) => Number(n.toFixed(6))),
    ).toEqual(mesh!.parent!.parent!.matrixWorld.elements.map((n) => Number(n.toFixed(6))));
    expect(
      frame.holder.elements.map((n) => Number(n.toFixed(6))),
    ).toEqual(mesh!.parent!.matrixWorld.elements.map((n) => Number(n.toFixed(6))));
  });

  test('frameIsExact flags the ancestors that expand into many copies', () => {
    expect(frameIsExact(posed, [0, 0])).toBe(true);
    expect(frameIsExact(spec, [0, 1])).toBe(true);
    const scattered = updatePart(spec, [0], {
      repeat: { count: 3, mode: 'linear', offset: [0, 0.2, 0] },
    });
    expect(frameIsExact(scattered, [0, 0])).toBe(false);
    // The part's own repeat does not make its own frame inexact.
    expect(frameIsExact(scattered, [0])).toBe(true);
  });
});

describe('gizmo transforms', () => {
  test('translating a nested child moves it by exactly the world delta', () => {
    const before = centreOf(buildSpec(posed), [0, 0]);
    const next = applyTransform(posed, [0, 0], {
      pivot: [before.x, before.y, before.z],
      move: [0.25, 0, 0],
    });
    // The parent is turned a quarter turn about Y, so world X is the parent's
    // local Z, and the spec scale halves it again.
    expect(partAt(next, [0, 0])?.position).toEqual([0.3, 0, 0.125]);
    const after = centreOf(buildSpec(next), [0, 0]);
    expect(after.clone().sub(before).toArray().map((n) => Number(n.toFixed(6)))).toEqual([0.25, 0, 0]);
  });

  test('translating a limb moves both of its endpoints', () => {
    const before = centreOf(buildSpec(posed), [0, 1]);
    const next = applyTransform(posed, [0, 1], {
      pivot: [before.x, before.y, before.z],
      move: [0, 0.5, 0.25],
    });
    expect(partAt(next, [0, 1])?.from).toEqual([-0.125, 0.25, 0]);
    expect(partAt(next, [0, 1])?.to).toEqual([0.275, 0.35, 0]);
    const after = centreOf(buildSpec(next), [0, 1]);
    expect(after.clone().sub(before).toArray().map((n) => Number(n.toFixed(6)))).toEqual([0, 0.5, 0.25]);
  });

  test('scaling a box stretches it along its own axes', () => {
    const before = centreOf(buildSpec(posed), [0]);
    const next = applyTransform(posed, [0], {
      pivot: [before.x, before.y, before.z],
      grow: [2, 1, 1],
    });
    expect(partAt(next, [0])?.size).toEqual([0.8, 0.4, 0.4]);
    // Scaling about the gizmo, which sits on the part's own centre, leaves it
    // where it was rather than shoving it off its parent.
    expect(centreOf(buildSpec(next), [0]).distanceTo(before)).toBeLessThan(1e-9);
    const size = sizeOf(buildSpec(next), [0]);
    // The part's local X points down world -Z after the quarter turn.
    expect(Number(size.z.toFixed(6))).toBe(1.6);
    expect(Number(size.x.toFixed(6))).toBe(0.8);
  });

  test('scaling a limb changes its thickness and keeps it uniform', () => {
    const next = applyTransform(posed, [0, 1], {
      pivot: [0, 0, 0],
      grow: [3, 3, 3],
    });
    expect(partAt(next, [0, 1])?.radius).toBe(0.15);
    expect(partAt(next, [0, 1])?.from).toEqual([0, 0, 0]);
  });

  test('a world rotation lands on the built holder unchanged', () => {
    const before = centreOf(buildSpec(posed), [0, 0]);
    const turn = new T.Quaternion().setFromAxisAngle(
      new T.Vector3(0, 1, 0),
      Math.PI / 4,
    );
    const next = applyTransform(posed, [0, 0], {
      pivot: [before.x, before.y, before.z],
      turn: [turn.x, turn.y, turn.z, turn.w],
    });
    const wanted = turn.clone().multiply(holderTurnOf(buildSpec(posed), [0, 0]));
    expect(holderTurnOf(buildSpec(next), [0, 0]).angleTo(wanted)).toBeLessThan(
      1e-4,
    );
    // Turning about the part's own centre must not slide it sideways.
    expect(
      centreOf(buildSpec(next), [0, 0]).distanceTo(before),
    ).toBeLessThan(1e-6);
  });

  test('rotating a limb swings its endpoints about the gizmo', () => {
    const before = centreOf(buildSpec(posed), [0, 1]);
    const turn = new T.Quaternion().setFromAxisAngle(
      new T.Vector3(0, 0, 1),
      Math.PI / 3,
    );
    const next = applyTransform(posed, [0, 1], {
      pivot: [before.x, before.y, before.z],
      turn: [turn.x, turn.y, turn.z, turn.w],
    });
    const part = partAt(next, [0, 1])!;
    // The endpoints moved, the holder's own rotation did not.
    expect(part.rotation).toBeUndefined();
    expect(part.from).not.toEqual([0, 0, 0]);
    expect(centreOf(buildSpec(next), [0, 1]).distanceTo(before)).toBeLessThan(
      1e-6,
    );
    const length = new T.Vector3(...part.to!).distanceTo(
      new T.Vector3(...part.from!),
    );
    expect(length).toBeCloseTo(Math.hypot(0.4, 0.1), 3);
  });

  test('a rotation and its inverse cancel out', () => {
    const pivot: [number, number, number] = [0.4, 0.2, 0.1];
    const turn = new T.Quaternion().setFromAxisAngle(
      new T.Vector3(1, 2, 3).normalize(),
      0.7,
    );
    const there = applyTransform(posed, [0, 0], {
      pivot,
      turn: [turn.x, turn.y, turn.z, turn.w],
    });
    const back = turn.clone().invert();
    const home = applyTransform(there, [0, 0], {
      pivot,
      turn: [back.x, back.y, back.z, back.w],
    });
    expect(holderTurnOf(buildSpec(home), [0, 0]).angleTo(
      holderTurnOf(buildSpec(posed), [0, 0]),
    )).toBeLessThan(1e-4);
    expect(
      centreOf(buildSpec(home), [0, 0]).distanceTo(
        centreOf(buildSpec(posed), [0, 0]),
      ),
    ).toBeLessThan(1e-3);
  });

  test('a surface-scattered part takes size and rotation but not position', () => {
    const scattered = parseSpec({
      version: 1,
      name: 'Scattered',
      kind: 'prop',
      parts: [
        { name: 'body', shape: 'sphere', size: [1, 1, 1] },
        {
          name: 'stud',
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          repeat: { count: 4, mode: 'surface' },
        },
      ],
    } satisfies AssetSpecInput);
    const moved = transformPatch(scattered, [1], {
      pivot: [0, 0, 0],
      move: [1, 1, 1],
    });
    expect(moved.position).toBeUndefined();
    const grown = transformPatch(scattered, [1], {
      pivot: [0, 0, 0],
      grow: [2, 2, 2],
    });
    expect(grown.size).toEqual([0.2, 0.2, 0.2]);
    expect(grown.position).toBeUndefined();
  });

  test('committed numbers stay readable', () => {
    const next = applyTransform(posed, [0, 0], {
      pivot: [0, 0, 0],
      move: [0.1234567, 0, 0],
    });
    for (const n of partAt(next, [0, 0])!.position!)
      expect(String(n).replace(/^-?\d*\.?/, '').length).toBeLessThanOrEqual(3);
  });
});
