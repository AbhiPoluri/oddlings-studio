import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { toGLB } from '../lib/asset-bundle';
import { buildSpec, parseSpec, type AssetSpec } from '../lib/asset-spec';
import {
  DEFAULT_MATERIAL,
  isPreset,
  materialOf,
  PRESETS,
  presetPaint,
} from '../lib/asset-materials';
import { isDefaultMaterial, materialKey } from '../lib/asset-uv';
import type { PaintFrame } from '../lib/asset-paint';
import { readySurface } from '../lib/asset-surface';
import { disposeScene } from '../lib/three-world';

await readySurface();

/** The JSON half of a GLB, which is where every material decision lands. */
type Gltf = {
  extensionsUsed?: string[];
  images?: { mimeType: string }[];
  textures?: unknown[];
  materials?: {
    name: string;
    emissiveFactor?: number[];
    normalTexture?: { index: number };
    emissiveTexture?: { index: number };
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number };
      metallicRoughnessTexture?: { index: number };
      roughnessFactor?: number;
      metallicFactor?: number;
    };
    extensions?: Record<string, Record<string, number>>;
  }[];
};

function readGltf(glb: ArrayBuffer): Gltf {
  const view = new DataView(glb);
  const length = view.getUint32(12, true);
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(glb, 20, length)),
  ) as Gltf;
}

function scene(parts: AssetSpec['parts']): AssetSpec {
  return parseSpec({
    version: 1,
    name: 'Material Scene',
    kind: 'prop',
    seed: 3,
    scale: 1,
    color: '#b4a894',
    surface: { blend: 0.02, detail: 60, budget: 1200, shading: 'smooth' },
    parts,
  });
}

/** The paint records the builder leaves on the fused mesh, one per part. */
function framesOfModel(model: T.Object3D) {
  let frames: PaintFrame[] = [];
  model.traverse((object) => {
    if (object instanceof T.Mesh && object.geometry.userData.surfacePaint)
      frames = object.geometry.userData.surfacePaint as PaintFrame[];
  });
  return frames;
}

describe('the preset library', () => {
  test('a preset resolves to its tuple and keeps its name', () => {
    const rust = materialOf('rust');
    expect(rust.roughness).toBe(PRESETS.rust.roughness);
    expect(rust.metalness).toBe(PRESETS.rust.metalness);
    expect(rust.preset).toBe('rust');
    // The name is part of the identity: two presets can agree on all four
    // numbers and still be different materials.
    expect(materialKey(rust)).not.toBe(materialKey(materialOf('iron')));
    expect(isDefaultMaterial(rust)).toBe(false);
  });

  test('a block may name a preset and move one field of it', () => {
    const tuned = materialOf({ preset: 'rust', roughness: 0.5 });
    expect(tuned.roughness).toBe(0.5);
    expect(tuned.metalness).toBe(PRESETS.rust.metalness);
    expect(tuned.preset).toBe('rust');
  });

  test('the four-field block still means exactly what it meant', () => {
    expect(materialOf({ roughness: 0.3, metalness: 1 })).toEqual({
      roughness: 0.3,
      metalness: 1,
      emissiveStrength: 1,
    });
    expect(materialOf({})).toEqual(DEFAULT_MATERIAL);
    expect(materialOf()).toEqual(DEFAULT_MATERIAL);
    // A tuple of pure defaults is still the material of no material at all,
    // which is what keeps an existing asset's material names unchanged.
    expect(isDefaultMaterial(materialOf({ roughness: 1, metalness: 0 }))).toBe(
      true,
    );
    expect(materialKey(materialOf({ roughness: 0.3, metalness: 1 }))).toBe(
      '0.3|1',
    );
  });

  test('every preset compiles its own paint and glows only if it says so', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(isPreset(name)).toBe(true);
      const tuple = materialOf(name);
      expect(tuple.roughness).toBeGreaterThanOrEqual(0);
      expect(tuple.roughness).toBeLessThanOrEqual(1);
      if (preset.paint) expect(presetPaint(name)).toBe(preset.paint);
      if (!preset.emissive) expect(tuple.emissive).toBeUndefined();
    }
  });

  test('a misspelt preset is refused at parse time, by name', () => {
    const bad = () =>
      parseSpec({
        version: 1,
        name: 'Bad',
        kind: 'prop',
        parts: [{ shape: 'sphere', material: 'granite' }],
      });
    expect(bad).toThrow(/not a material preset/);
    expect(bad).toThrow(/sandstone/);
  });

  test('a preset paints unless the part brought its own paint', () => {
    const model = buildSpec(
      scene([
        { shape: 'box', name: 'wall', size: [1, 1, 1], material: 'bricks' },
        {
          shape: 'box',
          name: 'lid',
          size: [1, 0.2, 1],
          position: [0, 0.6, 0],
          material: 'bricks',
          paint: "s.shade(base, 0.5)",
        },
      ]),
    );
    try {
      const frames = framesOfModel(model);
      expect(frames.length).toBe(2);
      expect(frames.map((frame) => frame.paint)).toContain(PRESETS.bricks.paint);
      expect(frames.map((frame) => frame.paint)).toContain('s.shade(base, 0.5)');
    } finally {
      disposeScene(model);
    }
  });
});

describe('presets in a GLB', () => {
  test('they export their extensions and their textures', async () => {
    const model = buildSpec(
      scene([
        { shape: 'box', name: 'slab', size: [2, 0.3, 2], material: 'stone' },
        {
          shape: 'sphere',
          name: 'orb',
          size: [0.8, 0.8, 0.8],
          position: [-0.5, 0.3, 0],
          material: 'glass',
        },
        {
          shape: 'box',
          name: 'pool',
          size: [0.8, 0.3, 0.8],
          position: [0.6, 0.15, 0],
          material: 'water',
        },
        {
          shape: 'box',
          name: 'flag',
          size: [0.6, 0.6, 0.05],
          position: [0, 0.5, 0.6],
          material: 'cloth',
        },
        {
          shape: 'octahedron',
          name: 'shard',
          size: [0.4, 0.7, 0.4],
          position: [0.6, 0.4, -0.5],
          material: 'obsidian',
        },
        {
          shape: 'cylinder',
          name: 'pit',
          size: [0.6, 0.3, 0.6],
          position: [-0.8, 0.15, 0.6],
          material: 'lava',
        },
      ]),
    );
    const gltf = readGltf(await toGLB(model));
    const named = (name: string) =>
      gltf.materials?.find((material) => material.name.includes(name));

    expect(named('glass')?.extensions?.KHR_materials_transmission?.transmissionFactor).toBe(1);
    expect(named('water')?.extensions?.KHR_materials_ior?.ior).toBeCloseTo(1.33);
    expect(named('cloth')?.extensions?.KHR_materials_sheen).toBeDefined();
    expect(named('obsidian')?.extensions?.KHR_materials_clearcoat?.clearcoatFactor).toBe(1);
    expect(named('lava')?.extensions?.KHR_materials_emissive_strength?.emissiveStrength).toBe(3);
    expect(gltf.extensionsUsed).toContain('KHR_materials_transmission');
    expect(gltf.extensionsUsed).toContain('KHR_materials_clearcoat');

    // And the maps the same expressions baked: colour, packed
    // metallic-roughness, a normal map from the presets' relief, and emission
    // from the one part that glows.
    const stone = named('stone');
    expect(stone?.pbrMetallicRoughness?.baseColorTexture).toBeDefined();
    expect(stone?.pbrMetallicRoughness?.metallicRoughnessTexture).toBeDefined();
    expect(stone?.normalTexture).toBeDefined();
    expect(named('lava')?.emissiveTexture).toBeDefined();
    // A factor the texture already carries has to be 1, or the two multiply.
    expect(stone?.pbrMetallicRoughness?.roughnessFactor).toBe(1);
    expect(gltf.images?.length).toBe(4);
    expect(gltf.images?.every((image) => image.mimeType === 'image/png')).toBe(true);
  }, 60000);

  test('a spec of plain colours embeds nothing and keeps its vertex colours', async () => {
    const model = buildSpec(
      scene([
        { shape: 'box', name: 'slab', size: [1, 0.4, 1], color: '#8899aa' },
        {
          shape: 'sphere',
          name: 'orb',
          size: [0.6, 0.6, 0.6],
          position: [0, 0.4, 0],
          color: '#aa5533',
        },
      ]),
    );
    const glb = await toGLB(model);
    const gltf = readGltf(glb);
    expect(gltf.images).toBeUndefined();
    expect(gltf.materials?.[0].pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
    // The colour still has to arrive somehow, and for an unpainted asset that
    // is the vertex colours it always was.
    const view = new DataView(glb);
    const length = view.getUint32(12, true);
    const json = new TextDecoder().decode(new Uint8Array(glb, 20, length));
    expect(json).toContain('COLOR_0');
  }, 60000);

  test('a faceted asset carries its preset on its own materials', async () => {
    // No surface block: every part is its own mesh with its own material, and
    // a preset has to reach those the same way it reaches a fused shell.
    const model = buildSpec(
      parseSpec({
        version: 1,
        name: 'Faceted Materials',
        kind: 'prop',
        seed: 2,
        scale: 1,
        color: '#b4a894',
        parts: [
          { shape: 'box', name: 'slab', size: [1, 0.3, 1], material: 'steel' },
          {
            shape: 'sphere',
            name: 'orb',
            size: [0.5, 0.5, 0.5],
            position: [0, 0.4, 0],
            material: 'glass',
          },
        ],
      }),
    );
    const gltf = readGltf(await toGLB(model));
    const steel = gltf.materials?.find((material) => material.name.includes('steel'));
    expect(steel?.pbrMetallicRoughness?.metallicFactor).toBe(1);
    expect(steel?.pbrMetallicRoughness?.roughnessFactor).toBeCloseTo(
      PRESETS.steel.roughness,
    );
    const glass = gltf.materials?.find((material) => material.name.includes('glass'));
    expect(glass?.extensions?.KHR_materials_transmission?.transmissionFactor).toBe(1);
    // Per-texel paint is a fused-surface idea; a faceted part has no atlas.
    expect(gltf.images).toBeUndefined();
  }, 60000);

  test('a custom material block exports as the plain material it is', async () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'slab',
          size: [1, 0.4, 1],
          material: { roughness: 0.2, metalness: 1 },
        },
      ]),
    );
    const gltf = readGltf(await toGLB(model));
    const material = gltf.materials?.[0];
    expect(material?.extensions).toBeUndefined();
    expect(material?.pbrMetallicRoughness?.roughnessFactor).toBeCloseTo(0.2);
    expect(material?.pbrMetallicRoughness?.metallicFactor).toBe(1);
    expect(material?.name).toContain('r0p2m1');
    expect(gltf.images).toBeUndefined();
  }, 60000);
});
