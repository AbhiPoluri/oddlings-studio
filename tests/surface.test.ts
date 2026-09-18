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
import { readySurface } from '../lib/asset-surface';
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
    for (const surface of [
      undefined,
      base.surface ?? {
        blend: 0.03,
        detail,
        budget: 4000,
        shading: 'flat' as const,
      },
    ]) {
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
