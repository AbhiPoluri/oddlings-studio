import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildMeshField } from '../lib/asset-mesh-sdf';
import { loftMesh } from '../lib/asset-sdf';

/**
 * The distance field read off a triangle mesh, checked against arithmetic.
 *
 * Every other field in this project can be argued about on paper — a sphere's
 * distance is a subtraction. This one is a tree walk over a few hundred
 * triangles, and the only honest way to know it is right is to measure it
 * against a brute-force scan and against the handful of points whose answer a
 * reader can work out in their head.
 */

/** A closed mesh as the field wants it: flat positions and flat indices. */
function soup(geometry: T.BufferGeometry) {
  const indexed = geometry.index ? geometry : geometry.toNonIndexed();
  const position = indexed.attributes.position as T.BufferAttribute;
  const index = indexed.index;
  return {
    positions: Float64Array.from(position.array),
    indices: Uint32Array.from(
      index
        ? Array.from(index.array)
        : Array.from({ length: position.count }, (_, i) => i),
    ),
  };
}

function fieldOf(geometry: T.BufferGeometry) {
  const { positions, indices } = soup(geometry);
  return buildMeshField(positions, indices);
}

/** Deterministic pseudo-random points, so a failure is reproducible. */
function points(count: number, reach: number, seed = 20260918) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i++)
    out.push([
      (next() - 0.5) * reach,
      (next() - 0.5) * reach,
      (next() - 0.5) * reach,
    ]);
  return out;
}

/** The nearest point on any triangle, the slow way three.js already knows. */
function bruteNearest(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
) {
  const p = new T.Vector3(x, y, z);
  const q = new T.Vector3();
  const triangle = new T.Triangle();
  let best = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const corner = (k: number) => {
      const v = indices[i + k] * 3;
      return new T.Vector3(positions[v], positions[v + 1], positions[v + 2]);
    };
    triangle.set(corner(0), corner(1), corner(2));
    triangle.closestPointToPoint(p, q);
    best = Math.min(best, q.distanceTo(p));
  }
  return best;
}

/** A hull-shaped loft with twelve stations: the shape the budget is about. */
function hullField() {
  const stations = Array.from({ length: 12 }, (_, i) => {
    const at = i / 11;
    const beam = 0.2 + 0.3 * Math.sin(Math.PI * at);
    return {
      at,
      profile: [
        [0, -0.5],
        [beam, -0.4],
        [beam * 1.1, 0],
        [beam * 0.9, 0.35],
        [0, 0.5],
      ] as [number, number][],
    };
  });
  const mesh = loftMesh({ shape: 'loft', size: [1, 1, 3], stations })!;
  return buildMeshField(
    Float64Array.from(mesh.positions),
    Uint32Array.from(mesh.indices),
  );
}

describe('the mesh field measures a cube', () => {
  const field = fieldOf(new T.BoxGeometry(1, 1, 1));

  test('at points whose distance is arithmetic', () => {
    // Centre, face, corner, and a point off one edge.
    expect(field.distance(0, 0, 0)).toBeCloseTo(-0.5, 9);
    expect(field.distance(0, 0, 0.25)).toBeCloseTo(-0.25, 9);
    expect(field.distance(0.5, 0, 0)).toBeCloseTo(0, 9);
    expect(field.distance(1, 0, 0)).toBeCloseTo(0.5, 9);
    expect(field.distance(1, 1, 1)).toBeCloseTo(Math.hypot(0.5, 0.5, 0.5), 9);
    expect(field.distance(0.6, 0.6, 0)).toBeCloseTo(Math.hypot(0.1, 0.1), 9);
  });

  test('and calls the inside inside', () => {
    // The centre of a cube is equidistant from all six faces, which is exactly
    // where a sign taken from one closest triangle has to be careful: there is
    // no single closest point, and the five runners-up are somewhere else
    // entirely.
    expect(field.winding(0, 0, 0)).toBeCloseTo(1, 6);
    expect(field.winding(1, 1, 1)).toBeCloseTo(0, 6);
    expect(field.distance(0, 0, 0)).toBeLessThan(0);
    expect(field.watertight).toBe(true);
  });
});

describe('the mesh field on a thin plate', () => {
  // Two centimetres thick and a metre across: the case a ray-crossing sign test
  // gets wrong, because a ray along the plate's own plane grazes its rim.
  const field = fieldOf(new T.BoxGeometry(1, 0.02, 1));

  test('signs the inside of the plate negative', () => {
    expect(field.distance(0, 0, 0)).toBeCloseTo(-0.01, 9);
    expect(field.distance(0.3, 0.005, -0.2)).toBeLessThan(0);
    expect(field.winding(0, 0, 0)).toBeCloseTo(1, 6);
  });

  test('and everything off it positive', () => {
    expect(field.distance(0, 0.2, 0)).toBeCloseTo(0.19, 9);
    expect(field.distance(0, 0, 0.9)).toBeCloseTo(0.4, 9);
    expect(field.distance(0, 0.0101, 0)).toBeGreaterThan(0);
  });

  test('exactly on the surface it is zero, either way', () => {
    expect(Math.abs(field.distance(0, 0.01, 0))).toBeLessThan(1e-9);
    expect(Math.abs(field.distance(0.5, 0, 0))).toBeLessThan(1e-9);
  });
});

describe('the mesh field on a mesh with a hole in it', () => {
  /** A cube with one face missing: closed enough to still have an inside. */
  const open = (() => {
    const { positions, indices } = soup(new T.BoxGeometry(1, 1, 1));
    // BoxGeometry emits +x, -x, +y, -y, +z, -z in that order, two triangles
    // each, so dropping the first six indices takes the +x face off.
    return buildMeshField(positions, indices.slice(6));
  })();

  test('is not called watertight', () => {
    expect(open.watertight).toBe(false);
    expect(open.triangles).toBe(10);
  });

  test('but the winding number still knows where the inside is', () => {
    // A crossing count would answer this by whether the ray happened to leave
    // through the missing face. The winding number instead reports how much of
    // a full turn is still there: most of it, deep in the middle.
    expect(open.winding(0, 0, 0)).toBeGreaterThan(0.7);
    expect(open.distance(0, 0, 0)).toBeLessThan(0);
    // Well outside, on every side including the open one.
    expect(open.winding(2, 0, 0)).toBeLessThan(0.2);
    expect(open.winding(0, 2, 0)).toBeLessThan(0.2);
    expect(open.distance(0, 2, 0)).toBeGreaterThan(0);
  });
});

describe('the BVH agrees with a brute-force scan', () => {
  test('on two thousand points around a loft', () => {
    const stations = [
      { at: 0, profile: [[0, -0.4], [0.3, -0.2], [0.25, 0.3], [0, 0.4]] as [number, number][] },
      { at: 0.5, profile: [[0, -0.5], [0.5, -0.1], [0.4, 0.35], [0, 0.5]] as [number, number][] },
      { at: 1, profile: [[0, -0.2], [0.12, -0.1], [0.1, 0.3], [0, 0.45]] as [number, number][] },
    ];
    const mesh = loftMesh({ shape: 'loft', size: [1, 1, 1], stations })!;
    // The same doubles on both sides: rounding them into a Float32 attribute
    // first would compare the tree against a slightly different loft.
    const positions = Float64Array.from(mesh.positions);
    const indices = Uint32Array.from(mesh.indices);
    const field = buildMeshField(positions, indices);
    let worst = 0;
    for (const [x, y, z] of points(2000, 2))
      worst = Math.max(
        worst,
        Math.abs(
          field.nearest(x, y, z) - bruteNearest(positions, indices, x, y, z),
        ),
      );
    // The tree changes which triangles are tested and in what order, never
    // which one is nearest, so the two differ only by the rounding of a sum.
    expect(worst).toBeLessThan(1e-9);
  });
});

describe('the mesh field is fast enough to march a grid with', () => {
  test('a quarter of a million queries on a twelve-station loft', () => {
    const field = hullField();
    expect(field.triangles).toBeGreaterThan(100);
    const probes = points(250_000, 1.2, 4242);
    const started = performance.now();
    let sum = 0;
    for (const [x, y, z] of probes) sum += field.distance(x, y, z);
    const elapsed = performance.now() - started;
    expect(Number.isFinite(sum)).toBe(true);
    // Points drawn uniformly through the model are the worst case the field
    // ever sees: every one of them is close enough to the hull that the BVH
    // cannot reject much. It measures about 1.6 microseconds each here, and
    // about 0.6 in the distribution the hierarchical sampler actually draws —
    // where most queries sit a block's radius away from any surface. The bound
    // is loose because this runs on whatever machine CI gives it; what it is
    // guarding against is the field going quadratic, not a slow afternoon.
    expect(elapsed).toBeLessThan(900);
  });
});
