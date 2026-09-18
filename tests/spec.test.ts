import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import * as T from 'three';
import {
  buildSpec,
  parseSpec,
  specJSONSchema,
  SHAPES,
  type AssetSpecInput,
} from '../lib/asset-spec';
import { stats } from '../lib/asset-build';
import { auditModel } from '../lib/asset-audit';
import { toGLB } from '../lib/asset-bundle';
import { rigClips } from '../lib/asset-rig';
import { EXAMPLE_SPEC } from '../mcp/spec-guide';
import { readySurface } from '../lib/asset-surface';

// The worked example ships with a surface block, so the decimator has to be in
// memory before anything builds it.
beforeAll(async () => {
  await readySurface();
});

const minimal: AssetSpecInput = {
  version: 1,
  name: 'Test Block',
  kind: 'prop',
  parts: [{ shape: 'box', size: [1, 1, 1] }],
};

const countMeshes = (model: T.Object3D) => stats(model).meshes;

describe('spec validation', () => {
  test('fills in defaults', () => {
    const spec = parseSpec(minimal);
    expect(spec.seed).toBe(0);
    expect(spec.scale).toBe(1);
    expect(spec.color).toBe('#93cec8');
    expect(spec.rig).toBeUndefined();
  });

  test.each([
    ['an unknown shape', { ...minimal, parts: [{ shape: 'blob' }] }],
    ['an unknown field', { ...minimal, parts: [{ shape: 'box', wat: 1 }] }],
    ['a bad color', { ...minimal, parts: [{ shape: 'box', color: 'red' }] }],
    ['no parts', { ...minimal, parts: [] }],
    ['a wrong version', { ...minimal, version: 2 }],
    ['a bad rig part', { ...minimal, parts: [{ shape: 'box', rigPart: 'tail' }] }],
    ['an over-long repeat', { ...minimal, parts: [{ shape: 'box', repeat: { count: 999 } }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpec(input)).toThrow(/Invalid asset spec/);
  });

  test('error messages point at the offending field', () => {
    expect(() =>
      parseSpec({ ...minimal, parts: [{ shape: 'box', detail: 99 }] }),
    ).toThrow(/parts\.0\.detail/);
  });

  test('every documented shape builds', () => {
    for (const shape of SHAPES) {
      const spec: AssetSpecInput = {
        ...minimal,
        parts: [
          shape === 'limb'
            ? { shape, from: [0, 0, 0], to: [0, 1, 0], radius: 0.2 }
            : { shape, size: [1, 1, 1] },
        ],
      };
      expect(countMeshes(buildSpec(spec))).toBe(1);
    }
  });

  test('every shape honours its declared size exactly', () => {
    for (const shape of SHAPES) {
      if (shape === 'limb') continue;
      const model = buildSpec({
        ...minimal,
        parts: [{ shape, size: [0.8, 0.4, 0.6] }],
      });
      const size = stats(model).size;
      expect(size[0]).toBeCloseTo(0.8, 5);
      expect(size[1]).toBeCloseTo(0.4, 5);
      // A plane is flat, so its depth stays zero rather than dividing by zero.
      expect(size[2]).toBeCloseTo(shape === 'plane' ? 0 : 0.6, 5);
    }
  });

  test('a zero-length limb is rejected', () => {
    expect(() =>
      buildSpec({
        ...minimal,
        parts: [{ shape: 'limb', from: [0, 1, 0], to: [0, 1, 0], radius: 0.2 }],
      }),
    ).toThrow(/zero length/);
  });

  test('publishes a JSON Schema agents can author against', () => {
    const schema = specJSONSchema() as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toContain('parts');
    expect(schema.required).toContain('name');
  });
});

describe('composition', () => {
  test('mirror doubles a part and swaps its rig side', () => {
    const model = buildSpec({
      ...minimal,
      rig: {},
      parts: [{ shape: 'box', size: [0.2, 0.2, 0.2], position: [0.4, 1, 0], rigPart: 'arm_l', mirror: 'x' }],
    });
    expect(countMeshes(model)).toBe(2);
    const sides = new Set<string>();
    model.traverse((o) => {
      if (o instanceof T.SkinnedMesh) {
        const index = o.geometry.attributes.skinIndex as T.BufferAttribute;
        sides.add(String(index.getX(0)));
      }
    });
    // Arm_L is bone 4 and Arm_R is bone 6 in the standard skeleton.
    expect(sides).toEqual(new Set(['4', '6']));
  });

  test('mirror reflects children too, not just the top of the branch', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          position: [0.5, 1, 0],
          mirror: 'x',
          children: [{ shape: 'box', size: [0.1, 0.1, 0.1], position: [0.3, 0, 0] }],
        },
      ],
    });
    expect(countMeshes(model)).toBe(4);
    const box = new T.Box3().setFromObject(model);
    expect(box.min.x).toBeCloseTo(-box.max.x, 6);
    expect(box.max.x).toBeCloseTo(0.85, 6);
  });

  test('a mirrored branch swaps the rig side of its children', () => {
    const model = buildSpec({
      ...minimal,
      rig: {},
      parts: [
        {
          shape: 'box',
          size: [0.2, 0.2, 0.2],
          position: [0.3, 0.8, 0],
          rigPart: 'arm_l',
          mirror: 'x',
          children: [
            {
              shape: 'box',
              size: [0.15, 0.15, 0.15],
              position: [0.12, -0.2, 0],
              rigPart: 'forearm_l',
            },
          ],
        },
      ],
    });
    const bound = new Set<string>();
    model.traverse((o) => {
      if (o instanceof T.SkinnedMesh)
        bound.add(
          String((o.geometry.attributes.skinIndex as T.BufferAttribute).getX(0)),
        );
    });
    // Arm_L/Forearm_L are bones 4/5 and Arm_R/Forearm_R are 6/7.
    expect(bound).toEqual(new Set(['4', '5', '6', '7']));
  });

  test('linear repeat steps by its offset', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          repeat: { count: 4, mode: 'linear', offset: [0.5, 0, 0] },
        },
      ],
    });
    expect(countMeshes(model)).toBe(4);
    expect(stats(model).size[0]).toBeCloseTo(1.6, 2);
  });

  test('radial repeat orbits the chosen axis', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          repeat: { count: 8, mode: 'radial', axis: 'y', radius: 1, arc: 360 },
        },
      ],
    });
    expect(countMeshes(model)).toBe(8);
    const size = stats(model).size;
    expect(size[0]).toBeCloseTo(size[2], 1);
    expect(size[0]).toBeGreaterThan(1.9);
  });

  test('mirror and repeat combine', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          position: [0.5, 0, 0],
          mirror: 'x',
          repeat: { count: 3, mode: 'linear', offset: [0, 0.2, 0] },
        },
      ],
    });
    expect(countMeshes(model)).toBe(6);
  });

  test('scatter breaks up a repeat but stays reproducible', () => {
    const base = {
      shape: 'box' as const,
      size: [0.1, 0.1, 0.1] as [number, number, number],
      repeat: { count: 8, mode: 'radial' as const, axis: 'y' as const, radius: 1, arc: 360 },
    };
    const regular = stats(buildSpec({ ...minimal, parts: [base] })).size;
    const spec: AssetSpecInput = {
      ...minimal,
      seed: 5,
      parts: [{ ...base, repeat: { ...base.repeat, scatter: [0.3, 0.3, 0.3] } }],
    };
    const scattered = stats(buildSpec(spec)).size;
    expect(scattered).not.toEqual(regular);
    // Same spec, same placement; a different seed moves everything.
    expect(stats(buildSpec(spec)).size).toEqual(scattered);
    expect(stats(buildSpec({ ...spec, seed: 6 })).size).not.toEqual(scattered);
  });

  test('scatter stays inside the offset it was given', () => {
    const spec: AssetSpecInput = {
      ...minimal,
      seed: 11,
      parts: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          position: [0, 1, 0],
          repeat: { count: 24, mode: 'linear', scatter: [0.2, 0.2, 0.2] },
        },
      ],
    };
    const size = stats(buildSpec(spec)).size;
    // One box is 0.1 across and every copy moves at most 0.2 either way.
    for (const axis of size) expect(axis).toBeLessThanOrEqual(0.1 + 0.4 + 1e-6);
  });

  test('sizeJitter varies copies without changing their count', () => {
    const parts = (sizeJitter?: number) => [
      {
        shape: 'box' as const,
        size: [0.2, 0.2, 0.2] as [number, number, number],
        repeat: { count: 6, mode: 'linear' as const, offset: [0.5, 0, 0] as [number, number, number], sizeJitter },
      },
    ];
    const plain = buildSpec({ ...minimal, parts: parts() });
    const varied = buildSpec({ ...minimal, seed: 3, parts: parts(0.5) });
    expect(countMeshes(varied)).toBe(countMeshes(plain));
    expect(stats(varied).size).not.toEqual(stats(plain).size);
  });

  test('twist rotates copies without moving them', () => {
    const spec: AssetSpecInput = {
      ...minimal,
      seed: 9,
      parts: [
        {
          shape: 'box',
          size: [0.3, 0.05, 0.05],
          repeat: { count: 6, mode: 'linear', offset: [0.4, 0, 0], twist: 60 },
        },
      ],
    };
    // Rotating flat boxes about their own centres deepens the bounding box.
    expect(stats(buildSpec(spec)).size[2]).toBeGreaterThan(0.05);
  });

  test('surface mode lands every copy on the body, whatever its shape', () => {
    const model = buildSpec({
      ...minimal,
      seed: 4,
      parts: [
        { name: 'body', shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], detail: 8 },
        {
          name: 'stud',
          shape: 'box',
          size: [0.08, 0.08, 0.08],
          repeat: { count: 10, mode: 'surface' },
        },
      ],
    });
    expect(countMeshes(model)).toBe(11);
    // Every stud should sit on the sphere's shell, roughly 0.5 from its centre.
    const centre = new T.Vector3(0, 0.5, 0);
    const distances: number[] = [];
    model.traverse((o) => {
      if (o instanceof T.Mesh && o.userData.specPath?.[0] === 1)
        distances.push(
          new T.Box3().setFromObject(o).getCenter(new T.Vector3()).distanceTo(centre),
        );
    });
    expect(distances).toHaveLength(10);
    for (const d of distances) expect(d).toBeGreaterThan(0.35);
    for (const d of distances) expect(d).toBeLessThan(0.55);
  });

  test('a band confines placement to part of the body', () => {
    const build = (band?: [number, number]) => {
      const model = buildSpec({
        ...minimal,
        seed: 4,
        parts: [
          { shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], detail: 8 },
          {
            name: 'stud',
            shape: 'box',
            size: [0.06, 0.06, 0.06],
            repeat: { count: 8, mode: 'surface', ...(band ? { band } : {}) },
          },
        ],
      });
      const ys: number[] = [];
      model.traverse((o) => {
        if (o instanceof T.Mesh && o.userData.specPath?.[0] === 1)
          ys.push(new T.Box3().setFromObject(o).getCenter(new T.Vector3()).y);
      });
      return ys;
    };
    const all = build();
    const top = build([0.7, 1]);
    expect(Math.min(...top)).toBeGreaterThan(Math.min(...all));
    // The band constrains where the ray lands; `embed` then pulls each copy a
    // little way back along the normal, so allow for that below the cut.
    for (const y of top) expect(y).toBeGreaterThan(0.65);
  });

  test('placements spread across the band instead of bunching at its edge', () => {
    const model = buildSpec({
      ...minimal,
      seed: 2,
      parts: [
        { shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], detail: 8 },
        {
          name: 'stud',
          shape: 'box',
          size: [0.06, 0.06, 0.06],
          repeat: { count: 8, mode: 'surface', band: [0.3, 1] },
        },
      ],
    });
    const ys: number[] = [];
    model.traverse((o) => {
      if (o instanceof T.Mesh && o.userData.specPath?.[0] === 1)
        ys.push(new T.Box3().setFromObject(o).getCenter(new T.Vector3()).y);
    });
    // Bunching would collapse the spread; the band covers 0.7 m of sphere.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.25);
  });

  test('surface mode is deterministic and follows the seed', () => {
    const spec = (seed: number): AssetSpecInput => ({
      ...minimal,
      seed,
      parts: [
        { shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], detail: 8 },
        { name: 'stud', shape: 'box', size: [0.07, 0.07, 0.07], repeat: { count: 6, mode: 'surface' } },
      ],
    });
    expect(stats(buildSpec(spec(1))).size).toEqual(stats(buildSpec(spec(1))).size);
    expect(stats(buildSpec(spec(2))).size).not.toEqual(stats(buildSpec(spec(1))).size);
  });

  test('surface mode needs something built before it', () => {
    expect(() =>
      buildSpec({
        ...minimal,
        parts: [
          { name: 'lonely', shape: 'box', size: [0.1, 0.1, 0.1], repeat: { count: 4, mode: 'surface' } },
        ],
      }),
    ).toThrow(/nothing is built before it/);
  });

  test('children ride along with each surface placement', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        { shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], detail: 8 },
        {
          name: 'flower',
          shape: 'box',
          size: [0.06, 0.06, 0.06],
          repeat: { count: 5, mode: 'surface' },
          children: [{ name: 'petal', shape: 'box', size: [0.04, 0.02, 0.04], position: [0.05, 0, 0] }],
        },
      ],
    });
    // One body, five flowers, one petal on each.
    expect(countMeshes(model)).toBe(11);
  });

  test('children inherit the parent transform', () => {
    const model = buildSpec({
      ...minimal,
      parts: [
        {
          shape: 'box',
          size: [0.2, 0.2, 0.2],
          position: [0, 2, 0],
          children: [{ shape: 'box', size: [0.2, 0.2, 0.2], position: [0, 1, 0] }],
        },
      ],
    });
    expect(stats(model).size[1]).toBeCloseTo(1.2, 2);
  });

  test('nesting deeper than eight levels is refused', () => {
    let part: Record<string, unknown> = { shape: 'box', size: [0.1, 0.1, 0.1] };
    for (let i = 0; i < 10; i++)
      part = { shape: 'box', size: [0.1, 0.1, 0.1], children: [part] };
    expect(() => buildSpec({ ...minimal, parts: [part] })).toThrow(/8 levels/);
  });

  test('runaway repeats hit the mesh ceiling instead of hanging', () => {
    const nested = {
      shape: 'box',
      size: [0.1, 0.1, 0.1],
      repeat: { count: 64 },
      children: [
        {
          shape: 'box',
          size: [0.1, 0.1, 0.1],
          repeat: { count: 64 },
          children: [{ shape: 'box', size: [0.1, 0.1, 0.1], repeat: { count: 64 } }],
        },
      ],
    };
    expect(() => buildSpec({ ...minimal, parts: [nested] })).toThrow(/4000 meshes/);
  });

  test('a single repeat can be large enough for foliage', () => {
    // Dense leaves need hundreds of copies from one repeat. The count cap used
    // to stop at 64, which forced a canopy to be built as a stack of identical
    // layers working around the limit rather than expressing what it wanted.
    const model = buildSpec({
      ...minimal,
      parts: [
        { name: 'leaf', shape: 'box', size: [0.02, 0.03, 0.006],
          repeat: { count: 512, mode: 'radial', axis: 'y', radius: 0.5 } },
      ],
    });
    expect(stats(model).meshes).toBe(512);
  });

  test('the mesh ceiling still catches a repeat that is simply too big', () => {
    // The cap is generous now, so `MAX_MESHES` is the only thing standing
    // between a careless spec and a model nothing can open. It has to name
    // itself clearly enough to act on.
    const wild = {
      shape: 'box',
      size: [0.05, 0.05, 0.05],
      repeat: { count: 512 },
      children: [{ shape: 'box', size: [0.05, 0.05, 0.05], repeat: { count: 512 } }],
    };
    let thrown = '';
    try {
      buildSpec({ ...minimal, parts: [wild] });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toContain('4000 meshes');
    expect(thrown).toContain('Lower a repeat count');
  });

  test('rejects a count past the new cap', () => {
    expect(() =>
      parseSpec({
        ...minimal,
        parts: [{ shape: 'box', size: [1, 1, 1], repeat: { count: 513 } }],
      }),
    ).toThrow(/repeat.count/);
  });
});

describe('jitter', () => {
  test('displaces vertices but keeps the vertex count', () => {
    const plain = buildSpec(minimal);
    const rough = buildSpec({ ...minimal, parts: [{ shape: 'box', size: [1, 1, 1], jitter: 0.5 }] });
    const count = (model: T.Object3D) => {
      let n = 0;
      model.traverse((o) => {
        if (o instanceof T.Mesh) n += o.geometry.attributes.position.count;
      });
      return n;
    };
    expect(count(rough)).toBe(count(plain));
    expect(stats(rough).size).not.toEqual(stats(plain).size);
  });

  test('is reproducible for a given spec seed', () => {
    const spec: AssetSpecInput = {
      ...minimal,
      seed: 7,
      parts: [{ shape: 'icosahedron', size: [1, 1, 1], jitter: 0.6 }],
    };
    expect(stats(buildSpec(spec)).size).toEqual(stats(buildSpec(spec)).size);
    expect(stats(buildSpec({ ...spec, seed: 8 })).size).not.toEqual(
      stats(buildSpec(spec)).size,
    );
  });
});

describe('rigging and export', () => {
  test('a rigged spec gains the standard skeleton', () => {
    expect(stats(buildSpec(EXAMPLE_SPEC)).bones).toBe(14);
  });

  test('a spec without a rig block stays static', () => {
    expect(stats(buildSpec({ ...EXAMPLE_SPEC, rig: undefined })).bones).toBe(0);
  });

  test('the example spec exports byte-identical GLB twice', async () => {
    const digest = async () =>
      createHash('sha256')
        .update(Buffer.from(await toGLB(buildSpec(EXAMPLE_SPEC), rigClips())))
        .digest('hex');
    expect(await digest()).toBe(await digest());
  });

  test('scale multiplies the exported size', () => {
    const base = stats(buildSpec(EXAMPLE_SPEC)).size;
    const doubled = stats(buildSpec({ ...EXAMPLE_SPEC, scale: 2 })).size;
    expect(doubled[1]).toBeCloseTo(base[1] * 2, 4);
  });
});

describe('surface placement under a moved parent', () => {
  /** A body well away from the origin, with copies scattered over it. */
  const spec: AssetSpecInput = {
    version: 1,
    name: 'Studded Ball',
    kind: 'prop',
    parts: [
      {
        name: 'body',
        shape: 'sphere',
        size: [1, 1, 1],
        position: [0.7, 2.4, -1.1],
        children: [
          {
            name: 'stud',
            shape: 'sphere',
            size: [0.16, 0.16, 0.16],
            repeat: { count: 10, mode: 'surface', embed: -0.3 },
          },
        ],
      },
    ],
  };

  test('lands the copies on the body, not off in space', () => {
    const model = buildSpec(spec);
    const centre = new T.Vector3(0.7, 2.4, -1.1);
    const studs: T.Vector3[] = [];
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (o instanceof T.Mesh && o.userData.specPath?.join('.') === '0.0')
        studs.push(o.getWorldPosition(new T.Vector3()));
    });
    expect(studs.length).toBe(10);
    // Raycasts return world space and a holder reads local space; when the
    // body sat at the origin those agreed, so this only broke once a part was
    // moved. A stud that had been double-offset would sit a body-width away.
    for (const stud of studs) expect(stud.distanceTo(centre)).toBeLessThan(0.6);
  });

  test('keeps the studded body in one piece', () => {
    const audit = auditModel(buildSpec(spec));
    expect(audit.findings.filter((f) => f.severity === 'error')).toStrictEqual([]);
  });
});


describe('radial repeats turn their copies the way they place them', () => {
  // An arm along the placement plane's first axis (u) with a flag on its +v
  // side: the flag tells us which way each copy was turned, which a symmetric
  // part would hide. Placing at +90° swings u onto v; a copy turned the same
  // way has its flag's across-arm offset land on -u.
  const plane = { x: [1, 2], y: [0, 2], z: [0, 1] } as const;
  const vec = (u: number, v: number, axis: 'x' | 'y' | 'z') => {
    const out: [number, number, number] = [0.05, 0.05, 0.05];
    out[plane[axis][0]] = u;
    out[plane[axis][1]] = v;
    return out;
  };
  const at = (u: number, v: number, axis: 'x' | 'y' | 'z') => {
    const out: [number, number, number] = [0, 0, 0];
    out[plane[axis][0]] = u;
    out[plane[axis][1]] = v;
    return out;
  };
  const ring = (axis: 'x' | 'y' | 'z') =>
    buildSpec({
      version: 1,
      name: 'Ring',
      kind: 'prop',
      seed: 1,
      parts: [
        { name: 'hub', shape: 'sphere', size: [0.3, 0.3, 0.3] },
        {
          name: 'arm',
          shape: 'box',
          size: vec(0.6, 0.05, axis),
          repeat: { count: 4, mode: 'radial', axis, radius: 1, arc: 360 },
          children: [{ name: 'flag', shape: 'box', size: vec(0.05, 0.3, axis), position: at(0.3, 0.15, axis) }],
        },
      ],
    });

  function flagOffsets(model: T.Object3D) {
    model.updateMatrixWorld(true);
    const flags: T.Mesh[] = [];
    const arms: T.Mesh[] = [];
    model.traverse((o) => {
      if (!(o instanceof T.Mesh)) return;
      const path = (o.userData.specPath as number[]).join('.');
      if (path === '1.0') flags.push(o);
      if (path === '1') arms.push(o);
    });
    return arms.map((arm, i) => {
      const a = new T.Box3().setFromObject(arm).getCenter(new T.Vector3());
      return new T.Box3().setFromObject(flags[i]).getCenter(new T.Vector3()).sub(a);
    });
  }

  test.each(['x', 'y', 'z'] as const)('about %s, the copy at +90° carries its flag with it', (axis) => {
    const offsets = flagOffsets(ring(axis));
    expect(offsets).toHaveLength(4);
    const [u, v] = plane[axis];
    const first = offsets[0].toArray();
    const second = offsets[1].toArray();
    expect(first[u]).toBeCloseTo(0.3, 5);
    expect(first[v]).toBeCloseTo(0.15, 5);
    expect(second[v]).toBeCloseTo(0.3, 5);
    expect(second[u]).toBeCloseTo(-0.15, 5);
  });
});
