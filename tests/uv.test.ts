import '../lib/node-shims';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as T from 'three';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import {
  bakeColorAtlas,
  planUv,
  splitUvSeams,
  UV_DEFAULTS,
} from '../lib/asset-uv';
import { generateBlueprint } from '../lib/procedural-director';
import { buildAsset } from '../lib/asset-build';
import { writeAsset } from '../node/write-asset';
import { specUnityPack, unityPack } from '../lib/asset-bundle';
import { fileName } from '../lib/asset-recipe';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-uv-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

beforeAll(async () => {
  await readySurface();
});

function specFile(name: string) {
  return JSON.parse(
    readFileSync(new URL(`../specs/${name}.spec.json`, import.meta.url), 'utf8'),
  ) as AssetSpecInput;
}

function meshOf(model: T.Object3D) {
  let found: T.Mesh | null = null;
  model.traverse((o) => {
    if (o instanceof T.Mesh && !found) found = o;
  });
  if (!found) throw Error('no mesh');
  return found as T.Mesh;
}

function meshes(model: T.Object3D) {
  const all: T.Mesh[] = [];
  model.traverse((o) => {
    if (o instanceof T.Mesh) all.push(o);
  });
  return all;
}

/** Signed uv area of every triangle, and the world area beside it. */
function triangleAreas(geometry: T.BufferGeometry) {
  const index = geometry.index;
  if (!index) throw Error('expected an indexed mesh');
  const uv = geometry.attributes.uv as T.BufferAttribute;
  const position = geometry.attributes.position as T.BufferAttribute;
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  const rows: { uv: number; world: number }[] = [];
  const edge = new T.Vector3();
  for (let t = 0; t < index.count / 3; t++) {
    const i0 = index.getX(t * 3),
      i1 = index.getX(t * 3 + 1),
      i2 = index.getX(t * 3 + 2);
    rows.push({
      uv:
        Math.abs(
          (uv.getX(i1) - uv.getX(i0)) * (uv.getY(i2) - uv.getY(i0)) -
            (uv.getY(i1) - uv.getY(i0)) * (uv.getX(i2) - uv.getX(i0)),
        ) / 2,
      world: edge
        .subVectors(
          a.fromBufferAttribute(position, i1),
          c.fromBufferAttribute(position, i0),
        )
        .cross(
          b.fromBufferAttribute(position, i2).sub(c),
        )
        .length(),
    });
  }
  return rows;
}

/** Build a surface spec and cut its seams, as an exporter would. */
function unwrapped(name: string) {
  const model = buildSpec(parseSpec(specFile(name)));
  const welded = meshOf(model).geometry;
  const layout = welded.userData.uvLayout as ReturnType<typeof planUv>;
  const wound = {
    vertices: (welded.attributes.position as T.BufferAttribute).count,
    skin: (welded.attributes.skinIndex as T.BufferAttribute | undefined)?.clone(),
    layout,
  };
  splitUvSeams(model);
  return { model, mesh: meshOf(model), welded: wound };
}

// --- faceted ------------------------------------------------------------
// Measured before writing any code: three's primitive geometries all carry a
// uv channel and `toNonIndexed` copies it through, so faceted mode needed no
// new code at all. These tests exist to keep that true.

describe('faceted uvs', () => {
  test('every spec mesh already carries a uv channel', () => {
    const flat = { ...specFile('lantern-keeper') };
    delete flat.surface;
    const model = buildSpec(parseSpec(flat));
    const parts = meshes(model);
    expect(parts.length).toBeGreaterThan(10);
    for (const part of parts) {
      const uv = part.geometry.attributes.uv as T.BufferAttribute | undefined;
      expect(uv, part.name).toBeDefined();
      expect(uv!.itemSize).toBe(2);
      expect(uv!.count).toBe(
        (part.geometry.attributes.position as T.BufferAttribute).count,
      );
      for (let i = 0; i < uv!.count; i++) {
        expect(Number.isFinite(uv!.getX(i))).toBe(true);
        expect(Number.isFinite(uv!.getY(i))).toBe(true);
      }
    }
  });

  test('a blueprint recipe carries one too, through the rig', () => {
    for (const mesh of meshes(buildAsset(generateBlueprint('villager', 12)))) {
      const uv = mesh.geometry.attributes.uv as T.BufferAttribute | undefined;
      expect(uv, mesh.name).toBeDefined();
      expect(uv!.count).toBe(
        (mesh.geometry.attributes.position as T.BufferAttribute).count,
      );
    }
  });

  test('splitting seams leaves a faceted model alone', () => {
    const flat = { ...specFile('lantern-keeper') };
    delete flat.surface;
    const model = buildSpec(parseSpec(flat));
    const before = meshes(model).map((m) => m.geometry);
    splitUvSeams(model);
    expect(meshes(model).map((m) => m.geometry)).toEqual(before);
  });
});

// --- surface ------------------------------------------------------------

describe('surface uvs', () => {
  for (const name of ['lich', 'godzilla']) {
    test(`${name} unwraps into a packed atlas`, () => {
      const started = performance.now();
      const { mesh, welded } = unwrapped(name);
      const geometry = mesh.geometry;
      const uv = geometry.attributes.uv as T.BufferAttribute;
      const position = geometry.attributes.position as T.BufferAttribute;

      expect(uv.count).toBe(position.count);
      // Seams cost vertices, but a box projection should not double the mesh
      // more than once over; a runaway chart count would show up here first.
      expect(position.count).toBeGreaterThan(welded.vertices);
      expect(position.count).toBeLessThan(welded.vertices * 3);

      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i),
          v = uv.getY(i);
        expect(Number.isFinite(u) && Number.isFinite(v)).toBe(true);
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }

      const atlas = geometry.userData.uvAtlas as {
        charts: number;
        efficiency: number;
      };
      // One chart per direction per part is the floor; far past that means the
      // chart merge stopped working and the gutters are eating the atlas.
      expect(atlas.charts).toBeGreaterThan(0);
      expect(atlas.charts).toBeLessThan(geometry.index!.count / 3 / 8);
      expect(atlas.efficiency).toBeGreaterThan(0.6);
      expect(atlas.efficiency).toBeLessThanOrEqual(1);
      expect(performance.now() - started).toBeLessThan(10000);
    });

    test(`${name} gives every real triangle a uv triangle`, () => {
      const { mesh } = unwrapped(name);
      const rows = triangleAreas(mesh.geometry);
      const real = rows.filter((row) => row.world > 1e-12);
      // Surface nets and the decimator leave no zero-area triangles today.
      // Tolerate a handful rather than pinning that, but never a uv triangle
      // that has collapsed under a real one.
      expect(rows.length - real.length).toBeLessThan(rows.length * 0.001);
      expect(real.every((row) => row.uv > 0)).toBe(true);
    });

    test(`${name} keeps every per-vertex array in lockstep`, () => {
      const { mesh } = unwrapped(name);
      const geometry = mesh.geometry;
      const count = (geometry.attributes.position as T.BufferAttribute).count;
      const owners = geometry.userData.surfaceOwners as { index: Uint16Array };
      const rigParts = geometry.userData.rigParts as (string | undefined)[];
      expect(owners.index.length).toBe(count);
      expect(rigParts.length).toBe(count);
      for (const attribute of Object.values(geometry.attributes))
        expect((attribute as T.BufferAttribute).count).toBe(count);
      expect((geometry.userData.uvSource as Uint32Array).length).toBe(count);
    });

    test(`${name} unwraps identically every time`, () => {
      const first = unwrapped(name).mesh.geometry.attributes.uv
        .array as Float32Array;
      const second = unwrapped(name).mesh.geometry.attributes.uv
        .array as Float32Array;
      expect(first.length).toBe(second.length);
      expect(Buffer.from(first.buffer)).toEqual(Buffer.from(second.buffer));
    });
  }

  test('the triangles claim a usable share of the atlas', () => {
    const { mesh, welded } = unwrapped('godzilla');
    expect(welded.layout.degenerate).toBe(0);
    const rows = triangleAreas(mesh.geometry);
    const total = rows.reduce((sum, row) => sum + row.uv, 0);
    // Packed rectangles cover most of the atlas; the triangles inside them
    // cover a quarter of it, which is what a bounding-box unwrap costs.
    expect(total).toBeGreaterThan(0.1);
    expect(total).toBeLessThan(1);
  });
});

// --- the rig survives the split ----------------------------------------

describe('skin binding across uv seams', () => {
  test('a character rig binds every duplicate exactly as it bound the original', () => {
    const { mesh, welded } = unwrapped('godzilla');
    const geometry = mesh.geometry;
    const skin = geometry.attributes.skinIndex as T.BufferAttribute;
    const source = geometry.userData.uvSource as Uint32Array;
    expect(welded.skin).toBeDefined();

    // Exact: two vertices split from one welded vertex must answer to the
    // same bone, or a seam would tear open the moment the model animates.
    const bound = new Map<number, string>();
    for (let i = 0; i < skin.count; i++) {
      const key = `${skin.getX(i)},${skin.getY(i)},${skin.getZ(i)},${skin.getW(i)}`;
      const held = bound.get(source[i]);
      if (held === undefined) bound.set(source[i], key);
      else expect(key).toBe(held);
    }
    expect(bound.size).toBe(welded.vertices);

    // And the distribution over the original vertices is untouched.
    const before = new Map<number, number>();
    for (let i = 0; i < welded.skin!.count; i++)
      before.set(welded.skin!.getX(i), (before.get(welded.skin!.getX(i)) ?? 0) + 1);
    const after = new Map<number, number>();
    for (const key of bound.values()) {
      const bone = Number(key.split(',')[0]);
      after.set(bone, (after.get(bone) ?? 0) + 1);
    }
    expect([...after].sort((a, b) => a[0] - b[0])).toEqual(
      [...before].sort((a, b) => a[0] - b[0]),
    );
  });

  test('a joint rig binds every duplicate exactly as it bound the original', () => {
    const spec = parseSpec({
      ...specFile('tire-swing-tree-leafy'),
      surface: { blend: 0.03, detail: 96, budget: 6000, shading: 'smooth' },
    });
    const model = buildSpec(spec);
    const weldedSkin = (
      meshOf(model).geometry.attributes.skinIndex as T.BufferAttribute
    ).clone();
    splitUvSeams(model);
    const geometry = meshOf(model).geometry;
    const skin = geometry.attributes.skinIndex as T.BufferAttribute;
    const source = geometry.userData.uvSource as Uint32Array;

    const before = new Map<number, number>();
    for (let i = 0; i < weldedSkin.count; i++)
      before.set(weldedSkin.getX(i), (before.get(weldedSkin.getX(i)) ?? 0) + 1);
    // The swing binds to a second bone, so the split has something to get
    // wrong; a single-bone answer here would mean the test proves nothing.
    expect(before.size).toBeGreaterThan(1);

    const seen = new Map<number, number>();
    for (let i = 0; i < skin.count; i++) {
      const held = seen.get(source[i]);
      if (held === undefined) seen.set(source[i], skin.getX(i));
      else expect(skin.getX(i)).toBe(held);
    }
    const after = new Map<number, number>();
    for (const bone of seen.values())
      after.set(bone, (after.get(bone) ?? 0) + 1);
    expect([...after].sort((a, b) => a[0] - b[0])).toEqual(
      [...before].sort((a, b) => a[0] - b[0]),
    );
  });
});

// --- the atlas ----------------------------------------------------------

/** Pull the pixels back out of a PNG: header fields, then the inflated rows. */
function decodePng(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, Uint8Array[]>();
  let at = 8;
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    const held = chunks.get(type);
    if (held) held.push(body);
    else chunks.set(type, [body]);
    at += 12 + length;
  }
  const header = chunks.get('IHDR')![0];
  const head = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = head.getUint32(0);
  const height = head.getUint32(4);
  expect(header[8]).toBe(8);
  expect(header[9]).toBe(6);
  expect(chunks.has('IEND')).toBe(true);

  const idat = chunks.get('IDAT')!;
  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let cursor = 0;
  for (const part of idat) {
    joined.set(part, cursor);
    cursor += part.length;
  }
  const raw = inflateSync(joined);
  expect(raw.length).toBe(height * (1 + width * 4));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 4)]).toBe(0);
    rgba.set(
      raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)),
      y * width * 4,
    );
  }
  return { width, height, rgba };
}

function toSrgb(c: number) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

describe('colour atlas', () => {
  test('covers roughly the area the uv triangles claim', () => {
    const { model, mesh } = unwrapped('godzilla');
    const atlas = bakeColorAtlas(model)!;
    expect(atlas.width).toBe(UV_DEFAULTS.size);
    expect(atlas.height).toBe(UV_DEFAULTS.size);
    const claimed =
      triangleAreas(mesh.geometry).reduce((sum, row) => sum + row.uv, 0) *
      atlas.width *
      atlas.height;
    // Point sampling at texel centres, so the two agree to a few per cent
    // rather than exactly. An order of magnitude apart means the raster and
    // the packer disagree about where a chart is.
    expect(atlas.covered).toBeGreaterThan(claimed * 0.8);
    expect(atlas.covered).toBeLessThan(claimed * 1.25);
  });

  test('a vertex samples its own colour out of the atlas', () => {
    const { model, mesh } = unwrapped('lantern-keeper');
    const atlas = bakeColorAtlas(model)!;
    const geometry = mesh.geometry;
    const uv = geometry.attributes.uv as T.BufferAttribute;
    const color = geometry.attributes.color as T.BufferAttribute;
    // Sample sparsely: a vertex sits on a chart's rim, so its own texel may
    // have been filled by dilation rather than by a triangle.
    let checked = 0;
    for (let i = 0; i < uv.count; i += 37) {
      const x = Math.min(
        atlas.width - 1,
        Math.floor(uv.getX(i) * atlas.width),
      );
      const y = Math.min(
        atlas.height - 1,
        Math.floor((1 - uv.getY(i)) * atlas.height),
      );
      const pixel = (y * atlas.width + x) * 4;
      if (!atlas.rgba[pixel + 3]) continue;
      checked++;
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs(atlas.rgba[pixel + c] - toSrgb(color.getComponent(i, c)) * 255),
        ).toBeLessThan(48);
    }
    expect(checked).toBeGreaterThan(20);

    // And the atlas is not one flat fill: this asset paints its eyes a
    // different colour from its body, so both must survive the bake.
    const distinct = new Set<number>();
    for (let pixel = 0; pixel < atlas.width * atlas.height; pixel++)
      if (atlas.rgba[pixel * 4 + 3])
        distinct.add(
          (atlas.rgba[pixel * 4] << 16) |
            (atlas.rgba[pixel * 4 + 1] << 8) |
            atlas.rgba[pixel * 4 + 2],
        );
    expect(distinct.size).toBeGreaterThan(1);
  });

  test('nothing lands outside the atlas and nothing is NaN', () => {
    const { model } = unwrapped('lich');
    const atlas = bakeColorAtlas(model)!;
    expect(atlas.rgba.length).toBe(atlas.width * atlas.height * 4);
    expect(atlas.covered).toBeGreaterThan(0);
    let opaque = 0;
    for (let i = 3; i < atlas.rgba.length; i += 4) if (atlas.rgba[i]) opaque++;
    // Dilation grows the painted region into the gutters, never shrinks it.
    expect(opaque).toBeGreaterThanOrEqual(atlas.covered);
  });

  test('a faceted asset gets no atlas', () => {
    const flat = { ...specFile('lantern-keeper') };
    delete flat.surface;
    const model = buildSpec(parseSpec(flat));
    splitUvSeams(model);
    expect(bakeColorAtlas(model)).toBeNull();
  });
});

describe('written files', () => {
  test('a surface spec ships a decodable png and an mtl that points at it', async () => {
    const spec = parseSpec(specFile('lantern-keeper'));
    const result = await writeAsset(
      { spec },
      { outDir: join(scratch, 'surface'), formats: ['glb', 'obj'] },
    );
    const base = fileName(spec.name);
    expect(result.files.some((f) => f.endsWith(`${base}.png`))).toBe(true);

    const png = await readFile(join(scratch, 'surface', `${base}.png`));
    const decoded = decodePng(new Uint8Array(png));
    expect(decoded.width).toBe(UV_DEFAULTS.size);
    let opaque = 0;
    for (let i = 3; i < decoded.rgba.length; i += 4)
      if (decoded.rgba[i]) opaque++;
    expect(opaque).toBeGreaterThan(decoded.width * decoded.height * 0.1);

    const mtl = await readFile(join(scratch, 'surface', `${base}.mtl`), 'utf8');
    expect(mtl).toContain(`map_Kd ${base}.png`);
    // An importer multiplies Kd by the map, so a tinted Kd would darken it.
    expect(mtl).toContain('Kd 1.00000 1.00000 1.00000');

    const obj = await readFile(join(scratch, 'surface', `${base}.obj`), 'utf8');
    expect(obj).toMatch(/^vt /m);
  });

  test('the browser unity pack ships the same atlas as the cli', async () => {
    // The studio downloads a zip built entirely in the browser, the CLI writes
    // loose files from Node. Both go through the same fflate-backed encoder, so
    // "Export for Unity" in the studio has to produce the same texture, not a
    // model whose mtl points at a file that was never packed.
    const spec = parseSpec(specFile('lantern-keeper'));
    const { zip, base } = await specUnityPack(spec);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).map((path) => path.split('/').pop()).sort()).toEqual(
      [
        `${base}.glb`,
        `${base}.obj`,
        `${base}.mtl`,
        `${base}.png`,
        'spec.json',
        'README.txt',
      ].sort(),
    );

    const zipped = decodePng(entries[`${base}/${base}.png`]);
    expect(zipped.width).toBe(UV_DEFAULTS.size);
    const mtl = new TextDecoder().decode(entries[`${base}/${base}.mtl`]);
    expect(mtl).toContain(`map_Kd ${base}.png`);
    const readme = new TextDecoder().decode(entries[`${base}/README.txt`]);
    expect(readme).toContain(`${base}.png`);

    const result = await writeAsset(
      { spec },
      { outDir: join(scratch, 'parity'), formats: ['glb'] },
    );
    const onDisk = new Uint8Array(
      await readFile(result.files.find((f) => f.endsWith('.png'))!),
    );
    // Same encoder, same atlas, so the two files are the same bytes — not
    // merely the same pixels. The rig differs between the two paths and the
    // unwrap must not notice.
    expect(Buffer.from(entries[`${base}/${base}.png`])).toEqual(
      Buffer.from(onDisk),
    );
    expect(decodePng(onDisk).rgba).toEqual(zipped.rgba);
  });

  test('a faceted recipe writes no png, and its readme promises none', async () => {
    const recipe = generateBlueprint('hut', 3);
    const result = await writeAsset(
      { recipe },
      { outDir: join(scratch, 'faceted'), formats: ['glb', 'obj'] },
    );
    expect(result.files.some((f) => f.endsWith('.png'))).toBe(false);
    const { zip } = await unityPack(recipe);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).some((path) => path.endsWith('.png'))).toBe(false);
    const readme = new TextDecoder().decode(
      entries[Object.keys(entries).find((p) => p.endsWith('README.txt'))!],
    );
    expect(readme).not.toContain('.png');
  });

  test('a written glb keeps its uv channel', async () => {
    const spec = parseSpec(specFile('lantern-keeper'));
    const outDir = join(scratch, 'glb');
    await writeAsset({ spec }, { outDir, formats: ['glb'] });
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const buffer = await readFile(join(outDir, `${fileName(spec.name)}.glb`));
    const gltf = await new GLTFLoader().parseAsync(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
      '',
    );
    const loaded = meshes(gltf.scene);
    expect(loaded.length).toBeGreaterThan(0);
    for (const mesh of loaded) {
      const uv = mesh.geometry.attributes.uv as T.BufferAttribute | undefined;
      expect(uv, mesh.name).toBeDefined();
      expect(uv!.count).toBe(
        (mesh.geometry.attributes.position as T.BufferAttribute).count,
      );
    }
  });
});

/**
 * The material channels.
 *
 * Same rasteriser, different channels — so what is worth testing is not that
 * it draws, but that it draws only when the asset has something to say, and
 * that what comes out decodes to the numbers that were authored.
 */
describe('material atlases', () => {
  test('a spec with no material block bakes one map and no others', () => {
    // The default tuple is the tuple every asset had before `material`
    // existed. Shipping three flat grey megabytes beside it would be a
    // regression dressed as a feature.
    const { model } = unwrapped('lantern-keeper');
    const atlas = bakeColorAtlas(model)!;
    expect(atlas.covered).toBeGreaterThan(0);
    expect(atlas.maps).toBeUndefined();
  });

  test('an emissive part bakes an emissive map and still no others', () => {
    // The octopod's eye glows and nothing on it varies in roughness or
    // metalness, so exactly one extra channel has anything to record.
    const { model } = unwrapped('octopod-walker');
    const atlas = bakeColorAtlas(model)!;
    expect(atlas.maps?.emissive).toBeDefined();
    expect(atlas.maps?.roughness).toBeUndefined();
    expect(atlas.maps?.metalness).toBeUndefined();
    const emissive = atlas.maps!.emissive!;
    expect(emissive.width).toBe(UV_DEFAULTS.size);
    expect(emissive.height).toBe(UV_DEFAULTS.size);
    // Most of the model is unlit, and the lens is not: both have to be in
    // there, or the map is a flat fill that says nothing.
    let dark = 0;
    let lit = 0;
    for (let pixel = 0; pixel < emissive.width * emissive.height; pixel++) {
      if (!emissive.rgba[pixel * 4 + 3]) continue;
      const bright =
        emissive.rgba[pixel * 4] +
        emissive.rgba[pixel * 4 + 1] +
        emissive.rgba[pixel * 4 + 2];
      if (bright > 90) lit++;
      else dark++;
    }
    expect(dark).toBeGreaterThan(1000);
    expect(lit).toBeGreaterThan(20);
  });

  test('roughness and metalness bake linearly, and decode to what was authored', () => {
    const spec = parseSpec({
      version: 1,
      name: 'Two Finishes',
      kind: 'prop',
      surface: { blend: 0.02, detail: 72, budget: 4000, shading: 'flat' },
      parts: [
        {
          name: 'matte',
          shape: 'box',
          size: [0.6, 0.3, 0.3],
          color: '#888888',
        },
        {
          name: 'chrome',
          shape: 'sphere',
          size: [0.36, 0.36, 0.36],
          position: [0.3, 0, 0],
          color: '#cccccc',
          material: { roughness: 0.25, metalness: 1 },
        },
      ],
    });
    const model = buildSpec(spec);
    splitUvSeams(model);
    const atlas = bakeColorAtlas(model)!;
    const rough = atlas.maps?.roughness;
    const metal = atlas.maps?.metalness;
    expect(rough).toBeDefined();
    expect(metal).toBeDefined();
    expect(atlas.maps?.emissive).toBeUndefined();
    // Linear, not sRGB: 0.25 roughness is 64, not the 137 a colour curve
    // would give it. An engine reads these as numbers.
    const levels = new Set<number>();
    for (let pixel = 0; pixel < rough!.width * rough!.height; pixel++)
      if (rough!.rgba[pixel * 4 + 3]) levels.add(rough!.rgba[pixel * 4]);
    expect([...levels].some((v) => Math.abs(v - 64) <= 2)).toBe(true);
    expect([...levels].some((v) => v >= 253)).toBe(true);
    const metals = new Set<number>();
    for (let pixel = 0; pixel < metal!.width * metal!.height; pixel++)
      if (metal!.rgba[pixel * 4 + 3]) metals.add(metal!.rgba[pixel * 4]);
    expect([...metals].some((v) => v >= 253)).toBe(true);
    expect([...metals].some((v) => v <= 2)).toBe(true);
  });

  test('the written files carry the extra maps and the mtl points at them', async () => {
    const spec = parseSpec(specFile('octopod-walker'));
    const result = await writeAsset(
      { spec },
      { outDir: join(scratch, 'materials'), formats: ['glb', 'obj'] },
    );
    const base = fileName(spec.name);
    const written = result.files.map((f) => f.split('/').pop());
    expect(written).toContain(`${base}.png`);
    expect(written).toContain(`${base}-emissive.png`);
    expect(written).not.toContain(`${base}-roughness.png`);
    const emissive = await readFile(
      result.files.find((f) => f.endsWith('-emissive.png'))!,
    );
    const decoded = decodePng(new Uint8Array(emissive));
    expect(decoded.width).toBe(UV_DEFAULTS.size);
    const mtl = await readFile(
      result.files.find((f) => f.endsWith('.mtl'))!,
      'utf8',
    );
    expect(mtl).toContain(`map_Ke ${base}-emissive.png`);
    // An importer multiplies Ke by map_Ke, so the scalar has to be white or
    // the map is tinted twice.
    expect(mtl).toContain('Ke 1.00000 1.00000 1.00000');
  });

  test('a faceted spec with no material writes the mtl it always wrote', async () => {
    const result = await writeAsset(
      { spec: parseSpec(specFile('cottage')) },
      { outDir: join(scratch, 'plain-mtl'), formats: ['obj'] },
    );
    const mtl = await readFile(
      result.files.find((f) => f.endsWith('.mtl'))!,
      'utf8',
    );
    expect(mtl).toContain('Ns 1\n');
    expect(mtl).not.toContain('Ke ');
    expect(mtl).not.toContain('map_Ke');
    expect(result.files.some((f) => f.includes('-roughness'))).toBe(false);
  });
});
