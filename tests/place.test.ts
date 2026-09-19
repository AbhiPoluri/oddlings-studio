import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, type AssetSpecInput } from '../lib/asset-spec';

/**
 * Placement is measured off the built mesh, never off the spec.
 *
 * The whole point of `rest` and `along` is that the numbers in the spec no
 * longer say where a part ends up — the builder works that out against real
 * geometry. A test that read the spec back would pass on a builder that did
 * nothing at all.
 */

const base = {
  version: 1 as const,
  name: 'Place Test',
  kind: 'prop' as const,
};

/** Every mesh built from the authored part at `path`, in build order. */
function copies(model: T.Object3D, path: number[]) {
  const found: T.Mesh[] = [];
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const from = object.userData.specPath as number[] | undefined;
    if (from?.length === path.length && path.every((step, at) => from[at] === step))
      found.push(object);
  });
  return found;
}

const boxOf = (mesh: T.Mesh) => new T.Box3().setFromObject(mesh);
const centreOf = (mesh: T.Mesh) => boxOf(mesh).getCenter(new T.Vector3());

const ball = {
  name: 'ball',
  shape: 'sphere' as const,
  size: [1, 1, 1] as [number, number, number],
  position: [0, 0, 0] as [number, number, number],
};

describe('rest', () => {
  test('a box dropped onto a sphere lands on its pole', () => {
    const model = buildSpec({
      ...base,
      parts: [
        ball,
        {
          name: 'lid',
          shape: 'box',
          size: [0.4, 0.2, 0.4],
          position: [0, 3, 0],
          rest: { on: 'ball' },
        },
      ],
    } satisfies AssetSpecInput);
    const lid = boxOf(copies(model, [1])[0]);
    // The sphere is fitted to a 1 m box, so its pole is at 0.5 exactly.
    expect(lid.min.y).toBeCloseTo(0.5, 3);
    expect(lid.max.y).toBeCloseTo(0.7, 3);
  });

  test('from "+x" travels in from the side', () => {
    const model = buildSpec({
      ...base,
      parts: [
        ball,
        {
          name: 'lid',
          shape: 'box',
          size: [0.2, 0.4, 0.4],
          position: [3, 0, 0],
          rest: { on: 'ball', from: '+x' },
        },
      ],
    } satisfies AssetSpecInput);
    const lid = boxOf(copies(model, [1])[0]);
    expect(lid.min.x).toBeCloseTo(0.5, 3);
    // Nothing moves it off the line it fell along.
    expect(lid.getCenter(new T.Vector3()).y).toBeCloseTo(0, 6);
  });

  test('sink embeds by exactly what it says', () => {
    const drop = (sink: number) => {
      const model = buildSpec({
        ...base,
        parts: [
          ball,
          {
            name: 'lid',
            shape: 'box',
            size: [0.4, 0.2, 0.4],
            position: [0, 3, 0],
            rest: { on: 'ball', sink },
          },
        ],
      } satisfies AssetSpecInput);
      return boxOf(copies(model, [1])[0]).min.y;
    };
    expect(drop(0.1)).toBeCloseTo(drop(0) - 0.1, 6);
    expect(drop(0.1)).toBeCloseTo(0.4, 3);
  });

  test('"any" lands on the first thing under it', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'ground', shape: 'box', size: [6, 0.5, 6], position: [0, 0, 0] },
        { name: 'pillar', shape: 'box', size: [0.6, 2, 0.6], position: [0, 1, 0] },
        {
          name: 'cap',
          shape: 'box',
          size: [0.4, 0.2, 0.4],
          position: [0, 5, 0],
          rest: { on: 'any' },
        },
      ],
    } satisfies AssetSpecInput);
    const cap = boxOf(copies(model, [2])[0]);
    // The pillar's top, not the ground it stands on.
    expect(cap.min.y).toBeCloseTo(2, 6);
  });

  test('every copy of a repeat finds its own step', () => {
    const step = (x: number, height: number) => ({
      name: `step-${x}`,
      shape: 'box' as const,
      size: [1, height, 1] as [number, number, number],
      position: [x, height / 2, 0] as [number, number, number],
    });
    const model = buildSpec({
      ...base,
      parts: [
        step(-1, 0.3),
        step(0, 0.7),
        step(1, 0.5),
        {
          name: 'bead',
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          position: [-0.8, 3, 0],
          rest: { on: 'any' },
          repeat: { count: 5, mode: 'linear', offset: [0.4, 0, 0] },
        },
      ],
    } satisfies AssetSpecInput);
    const beads = copies(model, [3]);
    expect(beads).toHaveLength(5);
    const landed = beads.map((mesh) => Number(boxOf(mesh).min.y.toFixed(4)));
    expect(landed).toEqual([0.3, 0.7, 0.7, 0.7, 0.5]);
  });

  test('a rested child of a turned parent still falls straight down', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'ground', shape: 'box', size: [6, 0.5, 6], position: [0, 0, 0] },
        {
          name: 'arm',
          shape: 'box',
          size: [0.3, 0.3, 0.3],
          position: [1, 2, 0],
          rotation: [0, 0, 90],
          children: [
            {
              name: 'bead',
              shape: 'box',
              size: [0.2, 0.2, 0.2],
              // A quarter turn about z sends the parent's +y to world -x, so
              // this hangs at world [0, 2, 0] before it falls.
              position: [0, 1, 0],
              rest: { on: 'ground' },
            },
          ],
        },
      ],
    } satisfies AssetSpecInput);
    const bead = boxOf(copies(model, [1, 0])[0]);
    expect(bead.min.y).toBeCloseTo(0.25, 6);
    expect(bead.getCenter(new T.Vector3()).x).toBeCloseTo(0, 6);
  });

  test('nothing underneath is an error naming both parts', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [
          ball,
          {
            name: 'lid',
            shape: 'box',
            size: [0.4, 0.2, 0.4],
            position: [10, 3, 0],
            rest: { on: 'ball' },
          },
        ],
      } satisfies AssetSpecInput),
    ).toThrow(/"lid" rests on "ball" from above/);
  });

  test('a shared name is an error rather than a guess', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [
          ball,
          { ...ball, position: [2, 0, 0] },
          {
            name: 'lid',
            shape: 'box',
            size: [0.4, 0.2, 0.4],
            position: [0, 3, 0],
            rest: { on: 'ball' },
          },
        ],
      } satisfies AssetSpecInput),
    ).toThrow(/"lid" rests on "ball", but 2 parts share that name/);
  });

  test('a part that is not built yet is an error', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [
          {
            name: 'lid',
            shape: 'box',
            size: [0.4, 0.2, 0.4],
            position: [0, 3, 0],
            rest: { on: 'ball' },
          },
          ball,
        ],
      } satisfies AssetSpecInput),
    ).toThrow(/"ball" is not built before it/);
  });
});

const bentTail = {
  name: 'tail',
  shape: 'limb' as const,
  from: [0, 0, 0] as [number, number, number],
  to: [0, 0, -3] as [number, number, number],
  via: [0, 1, -1.5] as [number, number, number],
  radius: 0.3,
};

const tailCurve = new T.QuadraticBezierCurve3(
  new T.Vector3(...bentTail.from),
  new T.Vector3(...bentTail.via),
  new T.Vector3(...bentTail.to),
);

const scute = {
  name: 'scute',
  shape: 'box' as const,
  size: [0.1, 0.1, 0.1] as [number, number, number],
};

describe('repeat along', () => {
  test('copies ride a bent limb at its own radius', () => {
    const model = buildSpec({
      ...base,
      parts: [bentTail, { ...scute, repeat: { count: 10, mode: 'along', path: 'tail' } }],
    } satisfies AssetSpecInput);
    const row = copies(model, [1]);
    expect(row).toHaveLength(10);
    row.forEach((mesh, i) => {
      const at = i / 9;
      const spine = tailCurve.getPointAt(at);
      expect(centreOf(mesh).distanceTo(spine)).toBeCloseTo(bentTail.radius, 6);
      // Turned to the path: the copy's own +z runs along the curve.
      const facing = new T.Vector3(0, 0, 1).applyQuaternion(
        mesh.getWorldQuaternion(new T.Quaternion()),
      );
      expect(facing.distanceTo(tailCurve.getTangentAt(at))).toBeLessThan(1e-6);
    });
  });

  test('side picks which way round the path the row sits', () => {
    const rowAt = (side: 'up' | 'down' | number) => {
      const model = buildSpec({
        ...base,
        parts: [
          {
            name: 'spar',
            shape: 'limb',
            from: [0, 0, 0],
            to: [0, 0, 2],
            radius: 0.5,
          },
          { ...scute, repeat: { count: 3, mode: 'along', path: 'spar', side } },
        ],
      } satisfies AssetSpecInput);
      return copies(model, [1]).map((mesh) => centreOf(mesh));
    };
    for (const point of rowAt('up')) expect(point.y).toBeCloseTo(0.5, 6);
    for (const point of rowAt('down')) expect(point.y).toBeCloseTo(-0.5, 6);
    // Ninety degrees round the tangent from up is the path's own right hand,
    // which for a spar running along +z is -x.
    for (const point of rowAt(90)) {
      expect(point.x).toBeCloseTo(-0.5, 6);
      expect(point.y).toBeCloseTo(0, 6);
    }
  });

  test('span keeps the row between its ends', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'spar', shape: 'limb', from: [0, 0, 0], to: [0, 0, 2], radius: 0.5 },
        {
          ...scute,
          repeat: { count: 3, mode: 'along', path: 'spar', span: [0.25, 0.75] },
        },
      ],
    } satisfies AssetSpecInput);
    const along = copies(model, [1]).map((mesh) => centreOf(mesh).z);
    expect(along.map((z) => Number(z.toFixed(6)))).toEqual([0.5, 1, 1.5]);
  });

  test('anything else is read as its longest axis', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'beam', shape: 'box', size: [0.4, 0.4, 3], position: [0, 1, 0] },
        { ...scute, repeat: { count: 4, mode: 'along', path: 'beam' } },
      ],
    } satisfies AssetSpecInput);
    const row = copies(model, [1]).map((mesh) => centreOf(mesh));
    // On top of the beam, spread over its 3 m length.
    for (const point of row) expect(point.y).toBeCloseTo(1.2, 6);
    expect(row.map((point) => Number(point.z.toFixed(6)))).toEqual([-1.5, -0.5, 0.5, 1.5]);
  });

  test('mirror gives the row a twin on the far side', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'spar', shape: 'limb', from: [0, 0, 0], to: [0, 0, 2], radius: 0.5 },
        {
          ...scute,
          mirror: 'x',
          repeat: { count: 3, mode: 'along', path: 'spar', side: 90 },
        },
      ],
    } satisfies AssetSpecInput);
    const row = copies(model, [1]);
    expect(row).toHaveLength(6);
    const sides = row.map((mesh) => Number(centreOf(mesh).x.toFixed(6)));
    expect(sides.filter((x) => x === -0.5)).toHaveLength(3);
    expect(sides.filter((x) => x === 0.5)).toHaveLength(3);
  });

  test('along with rest lands the row on the real surface', () => {
    const model = buildSpec({
      ...base,
      parts: [
        { name: 'ball', shape: 'sphere', size: [2, 2, 2], position: [0, 0, 0] },
        {
          name: 'beam',
          shape: 'box',
          size: [0.2, 0.2, 2],
          position: [0, 0.9, 0],
        },
        {
          ...scute,
          // The beam's own surface line is flat; the ball underneath is not.
          rest: { on: 'ball' },
          repeat: { count: 3, mode: 'along', path: 'beam' },
        },
      ],
    } satisfies AssetSpecInput);
    const row = copies(model, [2]);
    expect(row).toHaveLength(3);
    // Each copy sits on the sphere below it, so the ends drop further than
    // the middle one does.
    const feet = row.map((mesh) => boxOf(mesh).min.y);
    expect(feet[1]).toBeCloseTo(1, 3);
    expect(feet[0]).toBeLessThan(feet[1] - 0.1);
    expect(feet[0]).toBeCloseTo(feet[2], 6);
  });

  test('along without a path is refused at parse time', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [{ ...scute, repeat: { count: 3, mode: 'along' } }],
      }),
    ).toThrow(/mode "along" needs "path"/);
  });

  test('a path that names nothing is a build error', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [{ ...scute, repeat: { count: 3, mode: 'along', path: 'nope' } }],
      } satisfies AssetSpecInput),
    ).toThrow(/"scute" repeats along "nope", but no part is called that/);
  });

  test('a path built after the row is a build error', () => {
    expect(() =>
      buildSpec({
        ...base,
        parts: [
          { ...scute, repeat: { count: 3, mode: 'along', path: 'spar' } },
          { name: 'spar', shape: 'limb', from: [0, 0, 0], to: [0, 0, 2], radius: 0.5 },
        ],
      } satisfies AssetSpecInput),
    ).toThrow(/"spar" is not built before it/);
  });
});
