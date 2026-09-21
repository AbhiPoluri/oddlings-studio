import '../lib/node-shims';
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as T from 'three';
import { unzipSync } from 'fflate';
import { generateBlueprint } from '../lib/procedural-director';
import { unityPack } from '../lib/asset-bundle';
import { writeAsset, inspectGLB } from '../node/write-asset';
import { EXAMPLE_SPEC } from '../mcp/spec-guide';
import { buildSpec, parseSpec } from '../lib/asset-spec';
import { fileName } from '../lib/asset-recipe';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/**
 * A GLB's JSON chunk, both parsed and raw.
 *
 * The raw text matters as much as the tree: a claim that some block is not in
 * the file is only worth making against the bytes, wherever they happened to
 * be attached.
 */
function glbChunks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw Error('not a GLB');
  const length = view.getUint32(12, true);
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { json: JSON.parse(text) as any, text };
}

describe('unity pack', () => {
  test('contains the glb, obj, mtl, recipe and notes', async () => {
    const recipe = generateBlueprint('villager', 12);
    const { zip, base } = await unityPack(recipe);
    const entries = Object.keys(unzipSync(zip)).map((p) => basename(p)).sort();
    expect(entries).toEqual(
      [`${base}.glb`, `${base}.obj`, `${base}.mtl`, 'recipe.json', 'README.txt'].sort(),
    );
  });
});

describe('writeAsset', () => {
  test('writes every requested format for a recipe', async () => {
    const recipe = generateBlueprint('hut', 3);
    const result = await writeAsset(
      { recipe },
      { outDir: join(scratch, 'recipe'), formats: ['glb', 'obj', 'json', 'unity'] },
    );
    const base = fileName(recipe.name);
    expect(result.files.map((f) => basename(f)).sort()).toEqual(
      [
        `${base}.recipe.json`,
        `${base}.obj`,
        `${base}.mtl`,
        `${base}-unity.zip`,
        `${base}.glb`,
      ].sort(),
    );
    expect(result.stats.triangles).toBeGreaterThan(0);
  });

  test('defaults to glb only', async () => {
    const result = await writeAsset(
      { recipe: generateBlueprint('boulder', 4) },
      { outDir: join(scratch, 'default') },
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0].endsWith('.glb')).toBe(true);
  });

  test('a written GLB loads back with its bones and clips intact', async () => {
    const result = await writeAsset(
      { spec: parseSpec(EXAMPLE_SPEC) },
      { outDir: join(scratch, 'spec'), formats: ['glb'] },
    );
    const loaded = await inspectGLB(result.files[0]);
    expect(loaded.bones).toHaveLength(14);
    expect(loaded.bones[0]).toBe('Root');
    expect(loaded.animations.map((a) => a.name).sort()).toEqual([
      'Attack',
      'Idle',
      'Jump',
      'Walk',
      'Wave',
    ]);
    expect(loaded.stats.triangles).toBe(result.stats.triangles);
  });

  /**
   * A fused body in two finishes, so the shell is split into more than one
   * primitive. That split is what used to multiply the authoring data: the
   * exporter writes `geometry.userData` into every primitive it emits.
   */
  const fused = {
    version: 1 as const,
    name: 'Fused',
    kind: 'creature' as const,
    surface: { blend: 0.03, detail: 48, budget: 1200 },
    rig: { hipHeight: 0.48, headPivot: 0.9, shoulderWidth: 0.28 },
    parts: [
      {
        name: 'torso',
        shape: 'capsule' as const,
        size: [0.34, 0.52, 0.28] as [number, number, number],
        position: [0, 0.68, 0] as [number, number, number],
        color: '#7a8b6e',
      },
      {
        name: 'head',
        shape: 'sphere' as const,
        size: [0.26, 0.26, 0.26] as [number, number, number],
        position: [0, 1.02, 0] as [number, number, number],
        color: '#cbb894',
        material: { roughness: 0.2, metalness: 0.85 },
      },
      {
        name: 'leg',
        shape: 'cylinder' as const,
        size: [0.13, 0.42, 0.13] as [number, number, number],
        position: [0.1, 0.22, 0] as [number, number, number],
        color: '#7a8b6e',
        mirror: 'x' as const,
      },
    ],
  };

  test('a surface GLB carries its skeleton, not the studio build notes', async () => {
    const result = await writeAsset(
      { spec: parseSpec(fused) },
      { outDir: join(scratch, 'notes'), formats: ['glb'] },
    );
    const path = result.files.find((f) => f.endsWith('.glb'))!;
    const bytes = new Uint8Array(await readFile(path));
    const { json, text } = glbChunks(bytes);

    // The split that used to do the damage: more than one primitive, each of
    // which the exporter would have handed its own copy of the block.
    const primitives = (json.meshes as { primitives: { extras?: unknown }[] }[])
      .flatMap((mesh) => mesh.primitives);
    expect(primitives.length).toBeGreaterThan(1);
    for (const primitive of primitives) expect(primitive.extras).toBeUndefined();
    // Not once, not once per primitive: the notes are not in the file at all.
    for (const note of [
      'surfacePaint',
      'surfaceOwners',
      'rigParts',
      'creaseSource',
      'uvSource',
      'uvAtlas',
      'uvLayout',
      'surfaceMaterials',
      'bakedMaps',
    ])
      expect(text, note).not.toContain(note);

    // And the one block that is documented to be there still is, whole.
    const handOff = json.scenes[0].extras.oddlings;
    expect(handOff.version).toBe(1);
    expect(handOff.units).toBe('m');
    expect(handOff.bones).toHaveLength(14);
    expect(handOff.chains.map((c: { leaf: string }) => c.leaf).sort()).toEqual([
      'Foot_L',
      'Foot_R',
      'Forearm_L',
      'Forearm_R',
      'Head',
    ]);

    // Loading it back still works, and still answers the same questions.
    const loaded = await inspectGLB(path);
    expect(loaded.bones).toHaveLength(14);
    expect(loaded.stats.triangles).toBe(result.stats.triangles);
    expect(loaded.extras.bones).toHaveLength(14);
  });

  test('exporting twice in a row leaves the second file whole', async () => {
    // `writeAsset` builds one model and exports it for the zip and again for
    // the loose GLB, so the notes have to come back between the two passes.
    const result = await writeAsset(
      { spec: parseSpec(fused) },
      { outDir: join(scratch, 'twice'), formats: ['unity', 'glb'] },
    );
    const loose = new Uint8Array(
      await readFile(result.files.find((f) => f.endsWith('.glb'))!),
    );
    const zipped = unzipSync(
      await readFile(result.files.find((f) => f.endsWith('.zip'))!),
    );
    const inZip = zipped[Object.keys(zipped).find((p) => p.endsWith('.glb'))!];
    for (const bytes of [loose, inZip]) {
      const { json, text } = glbChunks(bytes);
      expect(text).not.toContain('surfacePaint');
      expect(json.scenes[0].extras.oddlings.bones).toHaveLength(14);
    }
  });

  /**
   * The part nodes the spec guide and the pack README promise.
   *
   * A game hinges a hatch or indexes a revolver cylinder by turning one of
   * these, so their names, their transforms and the fact that the geometry is
   * centred on them are a contract, not an implementation detail.
   */
  test('a faceted prop exports one node per part, at the part', async () => {
    const prop = {
      version: 1 as const,
      name: 'Revolver',
      kind: 'prop' as const,
      parts: [
        {
          name: 'frame',
          shape: 'box' as const,
          size: [0.04, 0.09, 0.2] as [number, number, number],
          color: '#404448',
          children: [
            {
              name: 'hammer',
              shape: 'box' as const,
              size: [0.012, 0.03, 0.02] as [number, number, number],
              position: [0, 0.055, -0.08] as [number, number, number],
              color: '#8a8f94',
            },
          ],
        },
        {
          name: 'cylinder',
          shape: 'cylinder' as const,
          size: [0.05, 0.06, 0.05] as [number, number, number],
          position: [0, 0.02, 0.01] as [number, number, number],
          rotation: [90, 0, 0] as [number, number, number],
          color: '#6b7076',
        },
      ],
    };
    const result = await writeAsset(
      { spec: parseSpec(prop) },
      { outDir: join(scratch, 'nodes'), formats: ['glb'] },
    );
    const { json } = glbChunks(
      new Uint8Array(await readFile(result.files[0])),
    );
    const nodes = json.nodes as {
      name: string;
      mesh?: number;
      translation?: number[];
      children?: number[];
    }[];
    const byName = new Map(nodes.map((node, at) => [node.name, at]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(['frame', 'hammer', 'cylinder']),
    );

    // The node stands where the part does, and its mesh is the part's.
    const cylinder = nodes[byName.get('cylinder')!];
    expect(cylinder.translation).toEqual([0, 0.02, 0.01]);
    const under = (cylinder.children ?? []).map((at) => nodes[at]);
    expect(under).toHaveLength(1);
    expect(under[0].name).toMatch(/^prop_part_\d{3}$/);
    // Centred on the node: no offset between the node and its geometry, which
    // is what makes turning the node turn the part about its own axis.
    expect(under[0].translation).toBeUndefined();
    expect(under[0].mesh).toBeTypeOf('number');

    // And a child part is a node under its parent's node, so one rotation on
    // the parent carries the whole group.
    expect(cylinder.children).not.toContain(byName.get('hammer'));
    expect(nodes[byName.get('frame')!].children).toContain(
      byName.get('hammer'),
    );
  });

  test('a skeleton or a fused surface leaves no part nodes behind', async () => {
    // Both are documented as the limits of the feature above, so both are
    // worth a check: a rigged or fused asset moves on bones instead.
    const result = await writeAsset(
      { spec: parseSpec(fused) },
      { outDir: join(scratch, 'no-nodes'), formats: ['glb'] },
    );
    const { json } = glbChunks(
      new Uint8Array(await readFile(result.files[0])),
    );
    const names = (json.nodes as { name: string }[]).map((node) => node.name);
    expect(names).not.toContain('torso');
    expect(names).not.toContain('head');
    expect(names).toContain('Hips');
  });

  test('the static OBJ carries no skinning and names its materials', async () => {
    const result = await writeAsset(
      { recipe: generateBlueprint('scout', 9) },
      { outDir: join(scratch, 'obj'), formats: ['obj'] },
    );
    const obj = await readFile(
      result.files.find((f) => f.endsWith('.obj'))!,
      'utf8',
    );
    const mtl = await readFile(
      result.files.find((f) => f.endsWith('.mtl'))!,
      'utf8',
    );
    expect(obj).toMatch(/^mtllib /);
    expect(obj).toContain('usemtl paint_');
    expect(mtl).toContain('newmtl paint_');
  });
});

/**
 * Materials on the way out.
 *
 * A material that reads correctly in the studio and arrives in an engine as
 * flat grey is worth nothing, so every assertion here is made against a GLB
 * that has been written and loaded back, not against the model that made it.
 */
describe('materials survive the export', () => {
  const lamp = {
    version: 1 as const,
    name: 'Lamp',
    kind: 'prop' as const,
    parts: [
      {
        name: 'base',
        shape: 'box' as const,
        size: [0.4, 0.1, 0.4] as [number, number, number],
        color: '#404040',
        material: { roughness: 0.2, metalness: 0.9 },
      },
      {
        name: 'bulb',
        shape: 'sphere' as const,
        size: [0.2, 0.2, 0.2] as [number, number, number],
        position: [-0.1, 0.12, 0] as [number, number, number],
        color: '#ffeeaa',
        material: { emissive: '#ffcc55', emissiveStrength: 3 },
      },
      {
        name: 'twin',
        shape: 'sphere' as const,
        size: [0.2, 0.2, 0.2] as [number, number, number],
        position: [0.1, 0.12, 0] as [number, number, number],
        color: '#ffeeaa',
        material: { emissive: '#ffcc55', emissiveStrength: 3 },
      },
    ],
  };

  /** Every distinct material in a written GLB, by name. */
  async function materialsIn(path: string) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const buffer = await readFile(path);
    const gltf = await new GLTFLoader().parseAsync(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
      '',
    );
    const found = new Map<string, T.MeshStandardMaterial>();
    gltf.scene.traverse((o: T.Object3D) => {
      if (!(o instanceof T.Mesh)) return;
      for (const material of (Array.isArray(o.material)
        ? o.material
        : [o.material]) as T.MeshStandardMaterial[])
        found.set(material.name, material);
    });
    return found;
  }

  test('roughness, metalness and emission all arrive', async () => {
    const result = await writeAsset(
      { spec: parseSpec(lamp) },
      { outDir: join(scratch, 'lamp'), formats: ['glb'] },
    );
    const materials = await materialsIn(result.files[0]);
    const metal = [...materials.values()].find((m) => m.metalness > 0.5)!;
    expect(metal.roughness).toBeCloseTo(0.2, 5);
    expect(metal.metalness).toBeCloseTo(0.9, 5);
    const glowing = [...materials.values()].filter(
      (m) => m.emissive.getHexString() !== '000000',
    );
    // The bulb and its twin are the same colour with the same finish, so they
    // share one material rather than carrying a copy each.
    expect(glowing).toHaveLength(1);
    expect(glowing[0].emissive.getHexString()).toBe('ffcc55');
    // Strength rides out through KHR_materials_emissive_strength; without it
    // a lamp authored at 3 comes back clamped to 1.
    expect(glowing[0].emissiveIntensity).toBeCloseTo(3, 5);
    expect(materials.size).toBe(2);
  });

  test('a material of pure defaults is the material of no material at all', () => {
    // Every number here is what zod fills in when the block is absent, so the
    // two specs describe the same asset and have to produce the same material:
    // the same `paint_<hex>` name every asset had before `material` existed,
    // and the same values on it. The two GLBs are not byte for byte equal only
    // because the exporter writes the authored spec into the file's extras,
    // and the two specs are different text.
    const plain = {
      version: 1 as const,
      name: 'Plain',
      kind: 'prop' as const,
      parts: [
        { shape: 'box' as const, size: [0.4, 0.4, 0.4] as [number, number, number], color: '#884422' },
        {
          shape: 'sphere' as const,
          size: [0.3, 0.3, 0.3] as [number, number, number],
          position: [0.2, 0, 0] as [number, number, number],
          color: '#884422',
        },
      ],
    };
    const spelled = {
      ...plain,
      parts: plain.parts.map((part) => ({
        ...part,
        material: { roughness: 1, metalness: 0 },
      })),
    };
    const describe_ = (spec: unknown) => {
      const model = buildSpec(parseSpec(spec));
      const found: string[] = [];
      model.traverse((o) => {
        if (!(o instanceof T.Mesh)) return;
        const material = o.material as T.MeshStandardMaterial;
        found.push(
          [
            material.name,
            material.color.getHexString(),
            material.roughness,
            material.metalness,
            material.emissive.getHexString(),
            material.emissiveIntensity,
          ].join('|'),
        );
      });
      return found;
    };
    expect(describe_(plain)).toStrictEqual([
      'paint_884422|884422|1|0|000000|1',
      'paint_884422|884422|1|0|000000|1',
    ]);
    expect(describe_(spelled)).toStrictEqual(describe_(plain));
  });

  test('a spec with no material still exports byte for byte the same twice', async () => {
    const spec = parseSpec({
      version: 1,
      name: 'Repeatable',
      kind: 'prop',
      parts: [
        { shape: 'box', size: [0.4, 0.4, 0.4], color: '#884422' },
        { shape: 'sphere', size: [0.3, 0.3, 0.3], position: [0.2, 0, 0], color: '#22cc88' },
      ],
    });
    const hash = async (dir: string) => {
      const result = await writeAsset(
        { spec },
        { outDir: join(scratch, dir), formats: ['glb'] },
      );
      return createHash('sha256')
        .update(await readFile(result.files[0]))
        .digest('hex');
    };
    expect(await hash('twice-a')).toBe(await hash('twice-b'));
  });

  test('a fused surface splits into one primitive per material', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const spec = parseSpec({
      ...lamp,
      name: 'Fused Lamp',
      surface: { blend: 0.02, detail: 72, budget: 4000, shading: 'flat' as const },
      parts: [
        ...lamp.parts,
        // No material block at all, so this one lands in the default group and
        // proves the split is by tuple rather than by part.
        {
          name: 'shade',
          shape: 'cylinder' as const,
          size: [0.3, 0.14, 0.3] as [number, number, number],
          position: [0, 0.2, 0] as [number, number, number],
          color: '#cc8844',
        },
      ],
    });
    const result = await writeAsset(
      { spec },
      { outDir: join(scratch, 'fused-lamp'), formats: ['glb'] },
    );
    const materials = await materialsIn(result.files[0]);
    // Matte for everything the author said nothing about, one for the metal
    // base, one for the glowing pair — carried by three groups over a single
    // vertex buffer, which is still one mesh.
    expect(materials.size).toBe(3);
    const glowing = [...materials.values()].filter(
      (m) => m.emissive.getHexString() === 'ffcc55',
    );
    expect(glowing).toHaveLength(1);
    expect(glowing[0].emissiveIntensity).toBeCloseTo(3, 5);
    expect([...materials.values()].every((m) => m.vertexColors)).toBe(true);
  });

  test('a fused surface with no materials is still one material', async () => {
    await (await import('../lib/asset-surface')).readySurface();
    const spec = parseSpec({
      version: 1,
      name: 'Fused Plain',
      kind: 'prop',
      surface: { blend: 0.02, detail: 72, budget: 4000, shading: 'flat' },
      parts: [
        { shape: 'box', size: [0.4, 0.4, 0.4], color: '#884422' },
        {
          shape: 'sphere',
          size: [0.3, 0.3, 0.3],
          position: [0.2, 0, 0],
          color: '#22cc88',
        },
      ],
    });
    const result = await writeAsset(
      { spec },
      { outDir: join(scratch, 'fused-plain'), formats: ['glb'] },
    );
    expect((await materialsIn(result.files[0])).size).toBe(1);
  });
});

describe('the readme describes the skeleton the GLB carries', () => {
  const readmeOf = async (source: Parameters<typeof writeAsset>[0], dir: string) => {
    const result = await writeAsset(source, { outDir: join(scratch, dir), formats: ['unity'] });
    const zip = result.files.find((f) => f.endsWith('-unity.zip'))!;
    const entries = unzipSync(new Uint8Array(await readFile(zip)));
    const key = Object.keys(entries).find((p) => p.endsWith('README.txt'))!;
    return new TextDecoder().decode(entries[key]);
  };

  test('a creature rig names its bones and clips', async () => {
    const readme = await readmeOf({ spec: parseSpec(EXAMPLE_SPEC) }, 'readme-rig');
    expect(readme).toContain('14-bone skinned Generic rig');
    expect(readme).toContain('Attack');
    expect(readme).toContain('extras.oddlings');
  });

  test('a mechanism is described as one, with its own clip names', async () => {
    const spec = parseSpec({
      version: 1,
      name: 'Lever',
      kind: 'prop',
      parts: [
        { name: 'base', shape: 'box', size: [0.4, 0.1, 0.4], position: [0, 0.05, 0] },
        { name: 'arm', shape: 'box', size: [0.05, 0.5, 0.05], position: [0, 0.35, 0] },
      ],
      joints: [
        { name: 'Pivot', at: [0, 0.1, 0], binds: ['arm'], spin: { axis: 'x', mode: 'swing', degrees: 20, seconds: 2, clip: 'Pull' } },
      ],
    });
    const readme = await readmeOf({ spec }, 'readme-joints');
    expect(readme).toContain('mechanism of 1 joints');
    expect(readme).toContain('the clip Pull');
    expect(readme).not.toContain('14-bone');
    expect(readme).not.toContain('starter body rig');
  });

  test('a prop says it has no skeleton', async () => {
    const spec = parseSpec({
      version: 1,
      name: 'Crate',
      kind: 'prop',
      parts: [{ name: 'box', shape: 'box', size: [0.5, 0.5, 0.5], position: [0, 0.25, 0] }],
    });
    const readme = await readmeOf({ spec }, 'readme-static');
    expect(readme).toContain('no skeleton');
    expect(readme).not.toContain('Generic');
  });

  test('inspect reads a textured GLB back without a browser', async () => {
    const spec = parseSpec({
      version: 1,
      name: 'Painted Post',
      kind: 'prop',
      surface: { blend: 0.02, detail: 48, budget: 2000 },
      parts: [{ name: 'post', shape: 'box', size: [0.3, 1, 0.3], position: [0, 0.5, 0], paint: "s.stripes(y * 10, 1, 0.5) > 0.5 ? s.rgb('#c03028') : base" }],
    });
    const result = await writeAsset({ spec }, { outDir: join(scratch, 'inspect-painted'), formats: ['glb'] });
    const loaded = await inspectGLB(result.files.find((f) => f.endsWith('.glb'))!);
    expect(loaded.stats.triangles).toBeGreaterThan(0);
    expect(loaded.extras).toBeNull();
  });
});
