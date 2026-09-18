import '../lib/node-shims';
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { unzipSync } from 'fflate';
import { generateBlueprint } from '../lib/procedural-director';
import { unityPack } from '../lib/asset-bundle';
import { writeAsset, inspectGLB } from '../node/write-asset';
import { EXAMPLE_SPEC } from '../mcp/spec-guide';
import { parseSpec } from '../lib/asset-spec';
import { fileName } from '../lib/asset-recipe';

const scratch = await mkdtemp(join(tmpdir(), 'oddlings-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

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
