import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, parseSpec, type AssetSpecInput, type Part } from '../lib/asset-spec';
import { stats } from '../lib/asset-build';
import {
  canonicalExtent,
  distanceTo,
  primArgs,
  type Prim,
  type PrimSource,
} from '../lib/asset-sdf';

/**
 * The shape vocabulary, checked numerically.
 *
 * Every shape has to hold up twice: once as triangles and once as a distance
 * field, and the two have to agree about where the surface is. A shape that
 * fails only one of those looks right in the viewport and comes apart the
 * moment an author turns surface mode on, which is the failure this file
 * exists to catch early.
 */

const spec = (part: Part): AssetSpecInput => ({
  version: 1,
  name: 'Shape',
  kind: 'prop',
  parts: [part],
});

function meshOf(part: Part) {
  const model = buildSpec(spec(part));
  let found: T.Mesh | null = null;
  model.traverse((o) => {
    if (o instanceof T.Mesh && !found) found = o;
  });
  if (!found) throw Error('no mesh');
  return found as T.Mesh;
}

/** Triangle corners in model space, as flat triples of indices into a weld. */
function triangles(geometry: T.BufferGeometry) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const index = geometry.index;
  const out: number[] = [];
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i++) out.push(index ? index.getX(i) : i);
  return out;
}

/**
 * Weld by position, not by index.
 *
 * The finishing pass explodes every geometry into unshared vertices so the
 * normals come out flat, so an index-based test would report every model as
 * nothing but holes. Welding on the rounded position asks the question that
 * actually matters: does the surface close.
 */
function weld(geometry: T.BufferGeometry) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const ids = new Map<string, number>();
  const map = new Int32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)]
      .map((v) => Math.round(v * 1e5) / 1e5)
      .join(',');
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    map[i] = id;
  }
  return map;
}

/** Edges used by exactly one triangle: the rim of a hole. */
function boundaryEdges(geometry: T.BufferGeometry) {
  const map = weld(geometry);
  const tri = triangles(geometry);
  const uses = new Map<string, number>();
  for (let i = 0; i < tri.length; i += 3) {
    const corners = [map[tri[i]], map[tri[i + 1]], map[tri[i + 2]]];
    for (let e = 0; e < 3; e++) {
      const a = corners[e];
      const b = corners[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) if (count === 1) open++;
  return open;
}

/**
 * Six times the signed volume. Positive means every face is wound outward;
 * an inside-out solid renders as a hole in whatever is behind it.
 */
function signedVolume(geometry: T.BufferGeometry) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const tri = triangles(geometry);
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  let sum = 0;
  for (let i = 0; i < tri.length; i += 3) {
    a.fromBufferAttribute(position, tri[i]);
    b.fromBufferAttribute(position, tri[i + 1]);
    c.fromBufferAttribute(position, tri[i + 2]);
    sum += a.dot(c.clone().cross(b));
  }
  return -sum;
}

function triangleCount(part: Part) {
  return stats(buildSpec(spec(part))).triangles;
}

/**
 * What `primsOf` would hand the field for this part.
 *
 * A copy of `primFor` in lib/asset-surface.ts, which this agent does not own.
 * It is called with the whole part rather than just its taper, which is the
 * one-line change surface mode still needs before lathe, extrude and bent
 * limbs reach it; everything else here is the same arithmetic.
 */
function primOf(source: PrimSource, matrix = new T.Matrix4()): Prim {
  const shape = source.shape;
  const box = new T.Box3();
  if (shape === 'limb') {
    const from = new T.Vector3(...(source.from ?? [0, 0, 0])).applyMatrix4(matrix);
    const to = new T.Vector3(...(source.to ?? [0, 1, 0])).applyMatrix4(matrix);
    const r1 = source.radius ?? 0.1;
    const r2 = r1 * (source.taper ?? 1);
    const segment = [from.x, from.y, from.z, to.x, to.y, to.z];
    const points = [from, to];
    if (source.via) {
      const via = new T.Vector3(...source.via).applyMatrix4(matrix);
      segment.splice(3, 0, via.x, via.y, via.z);
      points.push(via);
    }
    box.setFromPoints(points).expandByScalar(Math.max(r1, r2));
    return {
      inverse: new T.Matrix4(),
      stretch: [1, 1, 1],
      lipschitz: 1,
      shape,
      args: [r1, r2],
      segment,
      box,
      color: new T.Color(),
      jitter: 0,
      seed: 1,
    };
  }
  const size = source.size ?? [1, 1, 1];
  const extent = canonicalExtent(shape);
  const stretch: [number, number, number] = [
    Math.max(size[0] / extent[0], 1e-5),
    Math.max(size[1] / extent[1], 1e-5),
    Math.max(size[2] / extent[2], 1e-5),
  ];
  box.set(
    new T.Vector3(-size[0] / 2, -size[1] / 2, -size[2] / 2),
    new T.Vector3(size[0] / 2, size[1] / 2, size[2] / 2),
  ).applyMatrix4(matrix);
  return {
    inverse: new T.Matrix4().copy(matrix).invert(),
    stretch,
    lipschitz: Math.min(stretch[0], stretch[1], stretch[2]),
    shape,
    args: primArgs(shape, source),
    box,
    color: new T.Color(),
    jitter: 0,
    seed: 1,
  };
}

/**
 * |grad d| sampled on a lattice around the part, as [smallest, largest].
 *
 * A true distance has a gradient of exactly 1. A field evaluated canonically
 * and scaled back by the smallest stretch — which is what every shape but the
 * extrude does on a part that is not a cube — is only guaranteed not to
 * overshoot, so its gradient sits somewhere in (0, 1]. Both halves are worth
 * measuring: the upper one is the guarantee the marcher relies on, and on a
 * cube the lower one says the function is a real distance rather than a rough
 * bound that happens to have the right sign.
 */
function gradientRange(prim: Prim, reach: number) {
  const h = 1e-4;
  let low = Infinity;
  let high = 0;
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++)
      for (let k = -3; k <= 3; k++) {
        const x = (i / 3) * reach + 0.0137;
        const y = (j / 3) * reach + 0.0211;
        const z = (k / 3) * reach + 0.0173;
        const gx = distanceTo(prim, x + h, y, z) - distanceTo(prim, x - h, y, z);
        const gy = distanceTo(prim, x, y + h, z) - distanceTo(prim, x, y - h, z);
        const gz = distanceTo(prim, x, y, z + h) - distanceTo(prim, x, y, z - h);
        const g = Math.hypot(gx, gy, gz) / (2 * h);
        low = Math.min(low, g);
        high = Math.max(high, g);
      }
  return [low, high] as const;
}

/** Largest deviation from 1 in |grad d|. */
function gradientError(prim: Prim, reach: number) {
  const [low, high] = gradientRange(prim, reach);
  return Math.max(Math.abs(low - 1), Math.abs(high - 1));
}

/**
 * Largest |d| over the faceted surface: how far the field's zero set has drifted.
 *
 * `skip` drops vertices that are not meant to be on the field's surface. The
 * only ones are the two fan centres of a limb's flat caps, which sit at the
 * ends of the curve — a radius inside the round cap the field draws there.
 */
function surfaceDrift(part: Part, prim: Prim, skip: number[][] = []) {
  const position = meshOf(part).geometry.attributes.position as T.BufferAttribute;
  let worst = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i),
      y = position.getY(i),
      z = position.getZ(i);
    if (skip.some((p) => Math.hypot(x - p[0], y - p[1], z - p[2]) < 1e-6))
      continue;
    worst = Math.max(worst, Math.abs(distanceTo(prim, x, y, z)));
  }
  return worst;
}

/** A hull plan: pointed at +Y, square-ish at -Y, with a waist. */
const HULL: [number, number][] = [
  [0, 0.5],
  [0.18, 0.1],
  [0.2, -0.3],
  [0.14, -0.5],
  [-0.14, -0.5],
  [-0.2, -0.3],
  [-0.18, 0.1],
];

/** A funnel: wide foot, narrow throat, flared lip. */
const FUNNEL: [number, number][] = [
  [0.3, -0.5],
  [0.26, -0.1],
  [0.2, 0.3],
  [0.26, 0.42],
  [0.26, 0.5],
];

describe('bevel on a box', () => {
  const size: [number, number, number] = [0.8, 0.4, 0.6];
  const bevelled: Part = { shape: 'box', size, bevel: 0.05 };

  test('chamfers the edges without changing the size', () => {
    const geometry = meshOf(bevelled).geometry;
    expect(boundaryEdges(geometry)).toBe(0);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    const measured = stats(buildSpec(spec(bevelled))).size;
    for (let axis = 0; axis < 3; axis++)
      expect(measured[axis]).toBeCloseTo(size[axis], 5);
  });

  test('costs 44 triangles, not a rounding', () => {
    // Six shrunken faces, twelve edge facets, eight corner triangles. The
    // number is worth pinning: `RoundedBoxGeometry` draws the same silhouette
    // in 108, and on a prop with eight bevelled boxes that difference is half
    // the triangle budget.
    expect(triangleCount(bevelled)).toBe(44);
    expect(triangleCount({ shape: 'box', size })).toBe(12);
  });

  test('rounds the same edges in the field', () => {
    const prim = primOf({ shape: 'box', size, bevel: 0.05 });
    expect(distanceTo(prim, 0, 0, 0)).toBeLessThan(-0.15);
    expect(distanceTo(prim, 0, 0.6, 0)).toBeGreaterThan(0.35);
    // The corner a bevel cuts away is outside the field but inside a sharp box.
    expect(distanceTo(prim, 0.399, 0.199, 0.299)).toBeGreaterThan(0);
    expect(gradientError(prim, 0.9)).toBeLessThan(0.02);
    // Every chamfer vertex sits exactly on the rounded field: the facet is the
    // chord of the arc the field draws, so the two meet at its ends.
    expect(surfaceDrift(bevelled, prim)).toBeLessThan(1e-6);
    // And part company in the middle of the facet by the arc's sagitta, which
    // is the whole of the difference between chamfering and rounding.
    const sagitta = 0.05 * (1 - 1 / Math.SQRT2);
    const middle = distanceTo(prim, 0.4 - 0.025, 0.2 - 0.025, 0);
    expect(middle).toBeCloseTo(-sagitta, 6);
  });

  test('is refused when it would eat the part', () => {
    expect(() => parseSpec(spec({ shape: 'box', size, bevel: 0.3 }))).toThrow(
      /shortest side/,
    );
    expect(() =>
      parseSpec(spec({ shape: 'sphere', size, bevel: 0.05 })),
    ).toThrow(/no edges to chamfer/);
  });
});

describe('lathe', () => {
  const size: [number, number, number] = [0.6, 0.4, 0.5];
  const funnel: Part = { shape: 'lathe', size, profile: FUNNEL, detail: 10 };

  test('revolves into a closed solid the declared size', () => {
    const geometry = meshOf(funnel).geometry;
    expect(boundaryEdges(geometry)).toBe(0);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    const measured = stats(buildSpec(spec(funnel))).size;
    for (let axis = 0; axis < 3; axis++)
      expect(measured[axis]).toBeCloseTo(size[axis], 5);
  });

  test('a profile written top-down is not inside out', () => {
    const geometry = meshOf({
      ...funnel,
      profile: [...FUNNEL].reverse(),
    }).geometry;
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    expect(boundaryEdges(geometry)).toBe(0);
  });

  test('with no profile it is a cylinder', () => {
    const measured = stats(
      buildSpec(spec({ shape: 'lathe', size, detail: 12 })),
    ).size;
    expect(measured[0]).toBeCloseTo(size[0], 5);
    expect(measured[1]).toBeCloseTo(size[1], 5);
  });

  test('its field agrees with its triangles', () => {
    const prim = primOf(funnel);
    expect(distanceTo(prim, 0, 0, 0)).toBeLessThan(0);
    expect(distanceTo(prim, 0.5, 0, 0)).toBeGreaterThan(0.15);
    expect(distanceTo(prim, 0, 0.35, 0)).toBeGreaterThan(0.1);
    // Revolved canonically, so a part that is not a cube gets a conservative
    // field rather than an exact one: never past the surface, sometimes short.
    expect(gradientRange(prim, 0.7)[1]).toBeLessThan(1.02);
    expect(gradientError(primOf({ ...funnel, size: [0.5, 0.5, 0.5] }), 0.7)).toBeLessThan(0.02);
    // Exact, so the only drift is the chord between the revolve's facets.
    expect(surfaceDrift(funnel, prim)).toBeLessThan(0.01);
  });

  test('refuses a profile that revolves into nothing', () => {
    expect(() =>
      parseSpec(spec({ shape: 'lathe', size, profile: [[0, -0.5], [0, 0.5]] })),
    ).toThrow(/revolves into nothing/);
    expect(() =>
      parseSpec(spec({ shape: 'lathe', size, profile: [[0.4, 0], [0.2, 0]] })),
    ).toThrow(/flat/);
    expect(() =>
      parseSpec(spec({ shape: 'lathe', size, profile: [[-0.4, 0], [0.2, 1]] })),
    ).toThrow(/cannot be negative/);
  });
});

describe('extrude', () => {
  const size: [number, number, number] = [0.6, 0.4, 0.5];
  const plate: Part = { shape: 'extrude', size, profile: HULL };

  test('sweeps a concave polygon into a closed solid', () => {
    const geometry = meshOf(plate).geometry;
    expect(boundaryEdges(geometry)).toBe(0);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    const measured = stats(buildSpec(spec(plate))).size;
    for (let axis = 0; axis < 3; axis++)
      expect(measured[axis]).toBeCloseTo(size[axis], 5);
  });

  test('keeps its declared size when tapered or bevelled', () => {
    for (const variant of [
      { ...plate, taper: 0.5 },
      { ...plate, taper: 1.6 },
      { ...plate, bevel: 0.04 },
    ] as Part[]) {
      const geometry = meshOf(variant).geometry;
      expect(boundaryEdges(geometry)).toBe(0);
      expect(signedVolume(geometry)).toBeGreaterThan(0);
      const measured = stats(buildSpec(spec(variant))).size;
      for (let axis = 0; axis < 3; axis++)
        expect(measured[axis]).toBeCloseTo(size[axis], 5);
    }
  });

  test('with no profile it is a box', () => {
    const measured = stats(buildSpec(spec({ shape: 'extrude', size }))).size;
    for (let axis = 0; axis < 3; axis++)
      expect(measured[axis]).toBeCloseTo(size[axis], 5);
  });

  test('its field agrees with its triangles', () => {
    const prim = primOf(plate);
    expect(distanceTo(prim, 0, -0.1, 0)).toBeLessThan(0);
    // Off the pointed end of the plan, and off the side.
    expect(distanceTo(prim, 0, 0.35, 0)).toBeGreaterThan(0.05);
    expect(distanceTo(prim, 0, 0, 0.4)).toBeGreaterThan(0.1);
    expect(gradientError(prim, 0.7)).toBeLessThan(0.02);
    expect(surfaceDrift(plate, prim)).toBeLessThan(1e-6);
  });

  test('a tapered field still tracks its triangles', () => {
    const flared: Part = { ...plate, taper: 1.6 };
    const prim = primOf(flared);
    expect(distanceTo(prim, 0, -0.1, 0)).toBeLessThan(0);
    // The taper opens towards +Z, so the top is wider than the bottom.
    expect(distanceTo(prim, 0.22, 0, 0.24)).toBeLessThan(0);
    expect(distanceTo(prim, 0.22, 0, -0.24)).toBeGreaterThan(0);
    // Conservative rather than exact on a slanted wall: never past the surface.
    expect(surfaceDrift(flared, prim)).toBeLessThan(0.01);
  });

  test('refuses a profile that is not a polygon', () => {
    expect(() =>
      parseSpec(spec({ shape: 'extrude', size, profile: [[0, 0], [1, 1]] })),
    ).toThrow(/at least 3 points/);
    expect(() =>
      parseSpec(
        spec({
          shape: 'extrude',
          size,
          profile: [[0, 0], [1, 1], [2, 2]],
        }),
      ),
    ).toThrow(/encloses no area/);
    expect(() =>
      parseSpec(spec({ shape: 'sphere', size, profile: HULL })),
    ).toThrow(/belongs to lathe and extrude/);
    expect(() =>
      parseSpec(
        spec({ shape: 'extrude', size, profile: HULL, taper: 0.6, bevel: 0.03 }),
      ),
    ).toThrow(/tapered or bevelled/);
  });
});

describe('a limb bent through a point', () => {
  const cable: Part = {
    shape: 'limb',
    from: [-0.4, 0.5, 0],
    via: [0, 0.1, 0],
    to: [0.4, 0.5, 0],
    radius: 0.05,
    taper: 0.8,
    detail: 6,
  };

  test('is a closed tube that follows the bend', () => {
    const geometry = meshOf(cable).geometry;
    expect(boundaryEdges(geometry)).toBe(0);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    const box = new T.Box3().setFromObject(buildSpec(spec(cable)));
    // A straight cable would hang at y 0.5; this one sags most of the way to
    // the control point, which is what makes it read as a cable at all.
    expect(box.min.y).toBeLessThan(0.3);
    expect(box.min.y).toBeGreaterThan(0.2);
    expect(box.max.x).toBeCloseTo(0.4, 1);
  });

  test('its field follows the same curve', () => {
    const prim = primOf(cable);
    // On the curve at its lowest point, and clear of it above.
    expect(distanceTo(prim, 0, 0.3, 0)).toBeLessThan(0);
    expect(distanceTo(prim, 0, 0.5, 0)).toBeGreaterThan(0.1);
    expect(distanceTo(prim, -0.4, 0.5, 0)).toBeLessThan(0);
    expect(gradientError(prim, 0.8)).toBeLessThan(0.05);
    // Sampled cones rather than a closed form, so the drift is the chord.
    expect(
      surfaceDrift(cable, prim, [
        [-0.4, 0.5, 0],
        [0.4, 0.5, 0],
      ]),
    ).toBeLessThan(0.006);
  });

  test('mirrors the bend with the ends', () => {
    const model = buildSpec(
      spec({ ...cable, from: [0.1, 0.5, 0], via: [0.3, 0.1, 0.2], mirror: 'x' }),
    );
    const boxes: T.Box3[] = [];
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (o instanceof T.Mesh) boxes.push(new T.Box3().setFromObject(o));
    });
    expect(boxes.length).toBe(2);
    // Mirrored in x, identical in y and z: a via left behind would leave the
    // second copy sagging somewhere else entirely.
    expect(boxes[0].min.y).toBeCloseTo(boxes[1].min.y, 6);
    expect(boxes[0].min.z).toBeCloseTo(boxes[1].min.z, 6);
    expect(boxes[0].min.x).toBeCloseTo(-boxes[1].max.x, 6);
  });

  test('is refused on a shape with no ends', () => {
    expect(() =>
      parseSpec(spec({ shape: 'box', size: [1, 1, 1], via: [0, 1, 0] })),
    ).toThrow(/bends a limb/);
  });
});

describe('the fields fill the size they were given', () => {
  /**
   * Where the field is negative, measured on a grid.
   *
   * This is what surface mode will extract once `primFor` passes the whole part
   * to `primArgs` instead of just its taper: a shape whose field does not fill
   * its declared box comes out of the marcher the wrong size, and `size` would
   * stop meaning the same thing in the two backends.
   */
  function solidExtent(source: PrimSource) {
    const prim = primOf(source);
    const size = source.size ?? [1, 1, 1];
    const steps = 60;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= steps; i++)
      for (let j = 0; j <= steps; j++)
        for (let k = 0; k <= steps; k++) {
          const p = [i, j, k].map(
            (n, axis) => (n / steps - 0.5) * size[axis] * 1.4,
          );
          if (distanceTo(prim, p[0], p[1], p[2]) >= 0) continue;
          for (let axis = 0; axis < 3; axis++) {
            low[axis] = Math.min(low[axis], p[axis]);
            high[axis] = Math.max(high[axis], p[axis]);
          }
        }
    return low.map((v, axis) => high[axis] - v);
  }

  const size: [number, number, number] = [0.6, 0.4, 0.5];
  const cases: [string, PrimSource][] = [
    ['a bevelled box', { shape: 'box', size, bevel: 0.05 }],
    ['a lathe', { shape: 'lathe', size, profile: FUNNEL }],
    ['an extrude', { shape: 'extrude', size, profile: HULL }],
    ['a tapered extrude', { shape: 'extrude', size, profile: HULL, taper: 1.6 }],
    ['a bevelled extrude', { shape: 'extrude', size, profile: HULL, bevel: 0.04 }],
  ];

  test.each(cases)('%s fills its box', (_name, source) => {
    const measured = solidExtent(source);
    // One grid step of slack: the sample nearest the surface is inside it.
    const step = Math.max(...size) * 1.4 / 60;
    for (let axis = 0; axis < 3; axis++) {
      expect(measured[axis]).toBeGreaterThan(size[axis] - 2.5 * step);
      expect(measured[axis]).toBeLessThanOrEqual(size[axis] + 1e-9);
    }
  });
});

describe('the new shapes are deterministic', () => {
  const parts: Part[] = [
    { shape: 'box', size: [0.8, 0.4, 0.6], bevel: 0.05 },
    { shape: 'lathe', size: [0.6, 0.4, 0.5], profile: FUNNEL, jitter: 0.2 },
    { shape: 'extrude', size: [0.6, 0.4, 0.5], profile: HULL, taper: 0.7 },
    {
      shape: 'limb',
      from: [-0.4, 0.5, 0],
      via: [0, 0.1, 0],
      to: [0.4, 0.5, 0],
      radius: 0.05,
    },
  ];

  test.each(parts.map((part) => [part.shape, part] as const))(
    '%s builds the same geometry twice',
    (_shape, part) => {
      const first = meshOf(part).geometry.attributes.position.array;
      const second = meshOf(part).geometry.attributes.position.array;
      expect(Array.from(first)).toStrictEqual(Array.from(second));
    },
  );
});
