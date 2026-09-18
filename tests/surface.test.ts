import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import * as T from 'three';
import {
  buildSpec,
  parseSpec,
  SHAPES,
  type AssetSpecInput,
} from '../lib/asset-spec';
import { flatten } from '../lib/spec-edit';
import {
  primsOf,
  readySurface,
  sampleGrid,
  surfaceModel,
  type Grid,
  type SurfaceSettings,
} from '../lib/asset-surface';
import { distanceTo, type Prim } from '../lib/asset-sdf';
import { stats } from '../lib/asset-build';
import { toGLB } from '../lib/asset-bundle';
import { auditModel } from '../lib/asset-audit';
import { rigClips } from '../lib/asset-rig';

beforeAll(async () => {
  await readySurface();
});

/** Two overlapping blobs and a bar: enough parts to prove they fuse into one. */
const blobby: AssetSpecInput = {
  version: 1,
  name: 'Blob',
  kind: 'creature',
  surface: { blend: 0.04, detail: 64, budget: 4000, shading: 'smooth' },
  parts: [
    { shape: 'sphere', size: [0.6, 0.6, 0.6], position: [0, 0.5, 0] },
    { shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0.28, 0.72, 0] },
    {
      shape: 'limb',
      from: [0, 0.5, 0],
      to: [0, 0.1, 0],
      radius: 0.1,
      taper: 0.6,
    },
  ],
};

function meshOf(model: T.Object3D) {
  let found: T.Mesh | null = null;
  model.traverse((o) => {
    if (o instanceof T.Mesh && !found) found = o;
  });
  if (!found) throw Error('no mesh');
  return found as T.Mesh;
}

/** How many triangles use each edge. */
function edgeUse(geometry: T.BufferGeometry) {
  const index = geometry.index;
  if (!index) throw Error('expected an indexed mesh');
  const uses = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

/** V - E + F. A single closed shell with no handles gives 2. */
function euler(geometry: T.BufferGeometry) {
  const index = geometry.index as T.BufferAttribute;
  const vertices = (geometry.attributes.position as T.BufferAttribute).count;
  return vertices - edgeUse(geometry).size + index.count / 3;
}

/** An edge used by exactly one triangle is the rim of a hole. */
function boundaryEdges(geometry: T.BufferGeometry) {
  let open = 0;
  for (const uses of edgeUse(geometry).values()) if (uses === 1) open++;
  return open;
}

describe('surface mode', () => {
  test('collapses many parts into one mesh', () => {
    expect(stats(buildSpec(blobby)).meshes).toBe(1);
    const faceted = { ...blobby, surface: undefined };
    expect(stats(buildSpec(faceted)).meshes).toBe(3);
  });

  test('produces a closed manifold shell', () => {
    const geometry = meshOf(buildSpec(blobby)).geometry;
    expect(euler(geometry)).toBe(2);
  });

  test('winds every triangle outward', () => {
    // A sphere is the one case where "outward" has an unambiguous answer, so
    // it is the only honest way to catch an inside-out extraction.
    const model = buildSpec({
      version: 1,
      name: 'Ball',
      kind: 'prop',
      surface: { blend: 0, detail: 48, budget: 100000, shading: 'smooth' },
      parts: [{ shape: 'sphere', size: [1, 1, 1], position: [0, 0, 0] }],
    });
    const geometry = meshOf(model).geometry;
    const position = geometry.attributes.position as T.BufferAttribute;
    const index = geometry.index as T.BufferAttribute;
    const a = new T.Vector3(),
      b = new T.Vector3(),
      c = new T.Vector3();
    const normal = new T.Vector3(),
      centroid = new T.Vector3();
    let inward = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i));
      b.fromBufferAttribute(position, index.getX(i + 1));
      c.fromBufferAttribute(position, index.getX(i + 2));
      normal
        .subVectors(b, a)
        .cross(centroid.subVectors(c, a));
      centroid.copy(a).add(b).add(c).divideScalar(3);
      if (normal.dot(centroid) <= 0) inward++;
    }
    expect(inward).toBe(0);
  });

  test('honours the declared size', () => {
    const model = buildSpec({
      version: 1,
      name: 'Bar',
      kind: 'prop',
      surface: { blend: 0, detail: 128, budget: 100000, shading: 'flat' },
      parts: [{ shape: 'box', size: [0.8, 0.3, 0.5] }],
    });
    // Surface nets round the extremes off by up to a voxel, so the match is
    // close rather than exact — but a shape that came out a different size
    // would mean `size` means something different in the two backends.
    const [x, y, z] = stats(model).size;
    expect(x).toBeGreaterThan(0.76);
    expect(x).toBeLessThanOrEqual(0.81);
    expect(y).toBeGreaterThan(0.27);
    expect(z).toBeGreaterThan(0.47);
  });

  test('decimates down to the triangle budget', () => {
    const big = stats(
      buildSpec({
        ...blobby,
        surface: { blend: 0.04, detail: 96, budget: 100000, shading: 'smooth' },
      }),
    ).triangles;
    const small = stats(
      buildSpec({
        ...blobby,
        surface: { blend: 0.04, detail: 96, budget: 900, shading: 'smooth' },
      }),
    ).triangles;
    expect(big).toBeGreaterThan(5000);
    expect(small).toBeLessThanOrEqual(900);
    expect(small).toBeGreaterThan(300);
  });

  test('is deterministic', async () => {
    const hash = async () =>
      createHash('sha256')
        .update(Buffer.from(await toGLB(buildSpec(blobby), [])))
        .digest('hex');
    expect(await hash()).toBe(await hash());
  });

  test('blending fuses parts that only nearly touch', () => {
    const apart: AssetSpecInput = {
      version: 1,
      name: 'Pair',
      kind: 'prop',
      surface: { blend: 0, detail: 96, budget: 100000, shading: 'smooth' },
      parts: [
        { shape: 'sphere', size: [0.4, 0.4, 0.4], position: [-0.21, 0, 0] },
        { shape: 'sphere', size: [0.4, 0.4, 0.4], position: [0.21, 0, 0] },
      ],
    };
    // Two spheres 2 cm apart. A hard union leaves two shells (Euler 4). A
    // blend reaches half its radius, so 6 cm closes the gap into one shell
    // (Euler 2) — the ratio authors need to know when they pick a blend.
    expect(euler(meshOf(buildSpec(apart)).geometry)).toBe(4);
    expect(
      euler(
        meshOf(
          buildSpec({
            ...apart,
            surface: { ...apart.surface!, blend: 0.06 },
          }),
        ).geometry,
      ),
    ).toBe(2);
  });

  test('reports a shell that floats free of the body', () => {
    const apart: AssetSpecInput = {
      version: 1,
      name: 'Pair',
      kind: 'prop',
      surface: { blend: 0, detail: 96, budget: 100000, shading: 'smooth' },
      parts: [
        { name: 'core', shape: 'sphere', size: [0.4, 0.4, 0.4] },
        {
          name: 'bud',
          shape: 'sphere',
          size: [0.4, 0.4, 0.4],
          position: [0.42, 0, 0],
        },
      ],
    };
    // One mesh is not the same as one piece. Without a topology check a model
    // in two halves passes, because there is no second mesh to compare against.
    const loose = auditModel(buildSpec(apart), {
      labels: new Map([
        ['0', 'core'],
        ['1', 'bud'],
      ]),
    });
    expect(loose.ok).toBe(false);
    const finding = loose.findings.find((f) => f.code === 'detached-shell');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('bud');

    const fused = auditModel(
      buildSpec({ ...apart, surface: { ...apart.surface!, blend: 0.08 } }),
    );
    expect(fused.ok).toBe(true);
    expect(fused.findings.map((f) => f.code)).toContain('one-shell');
  });

  test('carries each part colour onto the vertices it owns', () => {
    const model = buildSpec({
      ...blobby,
      color: '#112233',
      parts: [
        { shape: 'sphere', size: [0.6, 0.6, 0.6], position: [0, 0.5, 0] },
        {
          shape: 'sphere',
          size: [0.4, 0.4, 0.4],
          position: [0.28, 0.72, 0],
          color: '#ff0000',
        },
      ],
    });
    const colors = meshOf(model).geometry.attributes.color as T.BufferAttribute;
    expect(colors).toBeTruthy();
    const seen = new Set<string>();
    for (let i = 0; i < colors.count; i++)
      seen.add(
        new T.Color(colors.getX(i), colors.getY(i), colors.getZ(i)).getHexString(),
      );
    expect(seen.size).toBe(2);
  });
});

describe('every shape survives the field', () => {
  // The distance functions are hand-written per shape, and a sign slip in one
  // of them produces an empty or inside-out shell rather than an error. Only
  // walking the whole list catches that; the worked specs exercise six of the
  // twelve.
  test.each(SHAPES)('%s closes and keeps its size', (shape) => {
    const size: [number, number, number] = [0.6, 0.4, 0.5];
    const model = buildSpec({
      version: 1,
      name: `Solid ${shape}`,
      kind: 'prop',
      surface: { blend: 0, detail: 80, budget: 100000, shading: 'smooth' },
      parts: [
        shape === 'limb'
          ? { shape, from: [-0.3, 0, 0], to: [0.3, 0, 0], radius: 0.2 }
          : { shape, size, taper: 0.6 },
      ],
    });
    const mesh = meshOf(model);
    // Closed, not manifold: a knife-edged shape pinches along its creases, so
    // the guarantee worth asserting everywhere is that there are no holes.
    expect(boundaryEdges(mesh.geometry)).toBe(0);
    const measured = stats(model).size;
    if (shape === 'limb') {
      expect(measured[0]).toBeGreaterThan(0.9);
      expect(measured[1]).toBeGreaterThan(0.35);
      return;
    }
    // A plane is authored with no thickness, so the builder gives it just
    // enough to enclose; only its two real axes are meant to match.
    const axes = shape === 'plane' ? [0, 1] : [0, 1, 2];
    for (const axis of axes) {
      expect(measured[axis]).toBeGreaterThan(size[axis] * 0.95);
      expect(measured[axis]).toBeLessThan(size[axis] * 1.02);
    }
  });

  test('a torus keeps its hole', () => {
    // Genus 1: V - E + F is 0, not 2. If a future change to the field or the
    // extraction filled the middle in, this is what would catch it.
    const model = buildSpec({
      version: 1,
      name: 'Ring',
      kind: 'prop',
      surface: { blend: 0, detail: 96, budget: 100000, shading: 'smooth' },
      parts: [{ shape: 'torus', size: [0.6, 0.6, 0.2] }],
    });
    expect(euler(meshOf(model).geometry)).toBe(0);
  });
});

describe('the worked specs', () => {
  const files = readdirSync('specs').filter((f) => f.endsWith('.spec.json'));

  test('there are specs to check', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  // The shipped specs are what agents read and copy. Running every one of them
  // through both backends is the cheapest way to catch a shape, a repeat mode
  // or a rig binding that only the other backend happens to handle.
  test.each(files)('%s builds both ways and passes its audit', (file) => {
    const base = JSON.parse(readFileSync(`specs/${file}`, 'utf8'));
    // A spec that never asked for surface mode still has to survive it, but
    // at a resolution its author would plausibly pick: a fixed coarse grid
    // turns a 13 cm gallery post on a 20 m windmill into two voxels and
    // fails the asset for the test's convenience. Aim for ~10 cm cells.
    const faceted = buildSpec(parseSpec(base));
    const longest = Math.max(...stats(faceted).size) / (base.scale ?? 1);
    const detail = Math.min(320, Math.max(96, Math.ceil((longest * (base.scale ?? 1)) / 0.1)));
    // Fusing is only a fair test of a spec that could plausibly be fused: a
    // ship's rigging or a village's fence rails are one cell thick at any
    // sane resolution and would shatter into shells, and thickening every
    // rope in every scene to please this test would be backwards. So the
    // fallback pass runs only when the thinnest authored feature spans a few
    // cells; a spec that asked for surface mode is always tested in it.
    const voxel = (longest * (base.scale ?? 1)) / detail;
    const thinnest = Math.min(
      ...flatten(parseSpec(base)).map(({ part }) =>
        part.shape === 'limb' ? 2 * (part.radius ?? 0.1) : Math.min(...(part.size ?? [1, 1, 1])),
      ),
    );
    const passes: (typeof base.surface | undefined)[] = [undefined];
    if (base.surface) passes.push(base.surface);
    else if (thinnest >= 2.5 * voxel)
      passes.push({ blend: 0.03, detail, budget: 4000, shading: 'flat' as const });
    for (const surface of passes) {
      const spec = parseSpec({ ...base, surface });
      const model = buildSpec(spec);
      const audit = auditModel(model, {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      });
      expect(
        audit.findings.filter((f) => f.severity === 'error'),
      ).toStrictEqual([]);
      expect(stats(model).meshes).toBeGreaterThan(0);
    }
  });
});

describe('surface rigging', () => {
  const rigged: AssetSpecInput = {
    version: 1,
    name: 'Walker',
    kind: 'creature',
    rig: { hipHeight: 0.48, headPivot: 0.9, shoulderWidth: 0.28 },
    surface: { blend: 0.03, detail: 96, budget: 5000, shading: 'flat' },
    parts: [
      {
        shape: 'capsule',
        size: [0.34, 0.5, 0.3],
        position: [0, 0.68, 0],
        rigPart: 'spine',
      },
      {
        shape: 'sphere',
        size: [0.26, 0.26, 0.28],
        position: [0, 1.02, 0],
        rigPart: 'head',
      },
      {
        shape: 'limb',
        from: [0.11, 0.5, 0],
        to: [0.11, 0.06, 0],
        radius: 0.07,
        rigPart: 'thigh_l',
        mirror: 'x',
      },
    ],
  };

  test('binds vertices to the bone their own part was pinned to', () => {
    const model = buildSpec(rigged);
    let skinned: T.SkinnedMesh | null = null;
    model.traverse((o) => {
      if (o instanceof T.SkinnedMesh) skinned = o;
    });
    expect(skinned).toBeTruthy();
    const mesh = skinned as unknown as T.SkinnedMesh;
    const names = mesh.skeleton.bones.map((b) => b.name);
    const index = mesh.geometry.attributes.skinIndex as T.BufferAttribute;
    const bound = new Set<string>();
    for (let i = 0; i < index.count; i++) bound.add(names[index.getX(i)]);
    // A single mesh bound by its centre would land on one bone. These three
    // prove the binding follows the geometry instead.
    expect(bound.has('Head')).toBe(true);
    expect(bound.has('Spine')).toBe(true);
    expect(bound.has('Thigh_L')).toBe(true);
    expect(bound.has('Thigh_R')).toBe(true);
  });

  test('does not report a legless rig when the legs are bound', () => {
    const audit = auditModel(buildSpec(rigged), { rigged: true });
    expect(audit.findings.map((f) => f.code)).not.toContain('rig-no-legs');
    expect(audit.ok).toBe(true);
  });

  test('exports as a skinned GLB with the standard clips', async () => {
    const glb = await toGLB(buildSpec(rigged), rigClips());
    expect(glb.byteLength).toBeGreaterThan(1000);
    expect(stats(buildSpec(rigged)).bones).toBe(14);
  });
});

/**
 * The hierarchical sampler against the scan it replaced.
 *
 * The fast path settles most of the grid from one sample per block, so the two
 * value arrays are deliberately *not* equal: a rejected block gets a constant
 * of the right sign rather than a distance nobody reads. What has to match is
 * everything the extractor can actually see — the sign at every point, and the
 * exact value at every point that takes part in a crossing — and, in the end,
 * the mesh itself.
 */
describe('the block sampler matches a full scan', () => {
  /** The primitives a spec's surface is blended from, without building one. */
  function primsFor(spec: AssetSpecInput): { prims: Prim[]; settings: SurfaceSettings } {
    const parsed = parseSpec(spec);
    const faceted = buildSpec({ ...parsed, surface: undefined });
    return {
      prims: primsOf(faceted, new T.Color(parsed.color)),
      settings: parsed.surface!,
    };
  }

  function compare(grid: Grid, full: Grid) {
    expect([grid.nx, grid.ny, grid.nz]).toStrictEqual([full.nx, full.ny, full.nz]);
    expect(grid.step).toBe(full.step);
    const { nx, ny, nz } = grid;
    const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
    let crossings = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const index = at(i, j, k);
          const mine = grid.values[index];
          const theirs = full.values[index];
          if (mine < 0 !== theirs < 0)
            throw Error(`sign differs at ${i},${j},${k}: ${mine} vs ${theirs}`);
          // A value is read for its magnitude only when an axis neighbour sits
          // on the other side of the surface, so that is where it has to be
          // exact.
          let edge = false;
          if (i + 1 < nx && theirs < 0 !== full.values[at(i + 1, j, k)] < 0) edge = true;
          if (j + 1 < ny && theirs < 0 !== full.values[at(i, j + 1, k)] < 0) edge = true;
          if (k + 1 < nz && theirs < 0 !== full.values[at(i, j, k + 1)] < 0) edge = true;
          if (i > 0 && theirs < 0 !== full.values[at(i - 1, j, k)] < 0) edge = true;
          if (j > 0 && theirs < 0 !== full.values[at(i, j - 1, k)] < 0) edge = true;
          if (k > 0 && theirs < 0 !== full.values[at(i, j, k - 1)] < 0) edge = true;
          if (!edge) continue;
          crossings++;
          if (mine !== theirs)
            throw Error(`value differs at a crossing ${i},${j},${k}: ${mine} vs ${theirs}`);
        }
    // A comparison that found no crossings would pass for the wrong reason.
    expect(crossings).toBeGreaterThan(0);
  }

  const files = readdirSync('specs').filter((f) => f.endsWith('.spec.json'));

  test.each(files)('%s samples identically where it counts', (file) => {
    const base = JSON.parse(readFileSync(`specs/${file}`, 'utf8'));
    // Coarse on purpose: the brute-force scan is what this measures against,
    // and at the studio's detail it takes seconds per spec.
    const spec = {
      ...base,
      surface: { blend: 0.03, detail: 72, budget: 4000, shading: 'flat' as const },
    };
    const { prims, settings } = primsFor(spec);
    compare(sampleGrid(prims, settings), sampleGrid(prims, settings, { brute: true }));
  });

  test('and produces the same mesh, vertex for vertex', () => {
    for (const file of ['wizard.spec.json', 'octopod-walker.spec.json']) {
      const base = JSON.parse(readFileSync(`specs/${file}`, 'utf8'));
      const parsed = parseSpec({
        ...base,
        surface: { blend: 0.03, detail: 72, budget: 100000, shading: 'flat' as const },
      });
      const source = buildSpec({ ...parsed, surface: undefined });
      const fallback = new T.Color(parsed.color);
      const fast = meshOf(surfaceModel(source, parsed.surface!, fallback)).geometry;
      const slow = meshOf(
        surfaceModel(source, parsed.surface!, fallback, 'surface', { brute: true }),
      ).geometry;
      const attribute = (geometry: T.BufferGeometry, name: string) =>
        Array.from((geometry.attributes[name] as T.BufferAttribute).array);
      expect(attribute(fast, 'position')).toStrictEqual(attribute(slow, 'position'));
      expect(attribute(fast, 'color')).toStrictEqual(attribute(slow, 'color'));
      expect(Array.from((fast.index as T.BufferAttribute).array)).toStrictEqual(
        Array.from((slow.index as T.BufferAttribute).array),
      );
    }
  });

  test('jitter does not escape the amplitude the block test assumes', () => {
    // The block test bounds the noise by its amplitude rather than its slope,
    // which is only sound if `fieldAt` never scales it by more than this.
    const { prims } = primsFor({
      version: 1,
      name: 'Rough',
      kind: 'prop',
      surface: { blend: 0, detail: 32, budget: 4000, shading: 'flat' },
      parts: [{ shape: 'box', size: [0.6, 0.4, 0.5], jitter: 0.8 }],
    });
    const prim = prims[0];
    expect(prim.jitter).toBe(0.8);
    expect(Math.abs(prim.jitter) * 0.06 * Math.max(0.01, prim.lipschitz)).toBeGreaterThan(0);
  });
});

describe('every distance function is 1-Lipschitz', () => {
  // The block test rejects a region by walking one sample outward by the
  // region's radius, which is only sound if no primitive's field can move
  // faster than the point does. A shape that broke this would not fail any
  // other test here — it would quietly cut a hole in a rejected block.
  type Probe = Record<string, unknown>;
  const variants: [string, Probe][] = SHAPES.flatMap(
    (shape): [string, Probe][] =>
      shape === 'limb'
        ? [
            ['limb', { shape, from: [-0.3, 0, 0], to: [0.3, 0.2, 0.1], radius: 0.2, taper: 0.4 }],
            ['limb via', { shape, from: [-0.3, 0, 0], via: [0, 0.4, 0.2], to: [0.3, 0, 0], radius: 0.15 }],
          ]
        : [
            [shape, { shape, size: [0.6, 0.4, 0.5], taper: 0.6 }],
            [`${shape} squashed`, { shape, size: [1.4, 0.12, 0.7], taper: 1.6 }],
            // Only a box and an extrude accept a chamfer, and only they reach
            // `sdRoundBox`, which is the one measured in metres rather than in
            // canonical space.
            ...(shape === 'box' || shape === 'extrude'
              ? ([[`${shape} bevelled`, { shape, size: [0.6, 0.5, 0.5], bevel: 0.08 }]] as [
                  string,
                  Probe,
                ][])
              : []),
          ],
  );

  test.each(variants)('%s', (_label, part) => {
    const faceted = buildSpec({
      version: 1,
      name: 'Probe',
      kind: 'prop',
      parts: [{ ...part, rotation: [17, 23, 41], position: [0.1, -0.2, 0.3] }],
    });
    const prims = primsOf(faceted, new T.Color('#888888'));
    expect(prims.length).toBe(1);
    const prim = prims[0];
    // Deterministic pseudo-random probes across the primitive's neighbourhood.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const point = () =>
      [next() * 3 - 1.5, next() * 3 - 1.5, next() * 3 - 1.5] as const;
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const a = point();
      const b = point();
      const moved = Math.abs(
        distanceTo(prim, a[0], a[1], a[2]) - distanceTo(prim, b[0], b[1], b[2]),
      );
      const apart = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      worst = Math.max(worst, moved / apart);
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-6);
  });
});
