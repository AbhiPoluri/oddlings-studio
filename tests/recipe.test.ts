import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import * as T from 'three';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from '../lib/procedural-director';
import { initialRecipe, parseRecipe, limits } from '../lib/asset-recipe';
import { buildAsset, stats } from '../lib/asset-build';
import { recipeGLB } from '../lib/asset-bundle';

const keys = Object.keys(blueprints) as Blueprint[];
const digest = (buffer: ArrayBuffer) =>
  createHash('sha256').update(Buffer.from(buffer)).digest('hex');

describe('recipe validation', () => {
  test('accepts a round-tripped recipe', () => {
    expect(parseRecipe(JSON.parse(JSON.stringify(initialRecipe)))).toEqual(
      initialRecipe,
    );
  });

  test.each([
    ['a non-object', 'not a recipe'],
    ['a wrong version', { ...initialRecipe, version: 2 }],
    ['an unknown kind', { ...initialRecipe, kind: 'vehicle' }],
    ['a kind/archetype mismatch', { ...initialRecipe, archetype: 'island' }],
    ['a malformed color', { ...initialRecipe, color: 'teal' }],
    ['an out-of-range value', { ...initialRecipe, eyes: 99 }],
    ['a fractional count', { ...initialRecipe, horns: 2.5 }],
    ['a negative seed', { ...initialRecipe, seed: -1 }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseRecipe(input)).toThrow();
  });

  test('backfills rig fields missing from older recipes', () => {
    const legacy: Record<string, unknown> = { ...initialRecipe };
    for (const key of ['rigged', 'hipHeight', 'headPivot', 'shoulderWidth'])
      delete legacy[key];
    const restored = parseRecipe(legacy);
    expect(restored.rigged).toBe(initialRecipe.rigged);
    expect(restored.hipHeight).toBe(initialRecipe.hipHeight);
  });
});

describe('blueprints', () => {
  test('every blueprint produces a recipe that validates', () => {
    for (const key of keys)
      for (const seed of [0, 1337, 2147483647]) {
        const recipe = generateBlueprint(key, seed);
        expect(parseRecipe(recipe)).toEqual(recipe);
        expect(recipe.kind).toBe(blueprints[key].kind);
        expect(recipe.archetype).toBe(blueprints[key].archetype);
      }
  });

  test('every blueprint builds a non-empty mesh', () => {
    for (const key of keys) {
      const measured = stats(buildAsset(generateBlueprint(key, 11)));
      expect(measured.triangles).toBeGreaterThan(0);
      expect(measured.meshes).toBeGreaterThan(0);
      expect(measured.size.every((n) => n > 0)).toBe(true);
    }
  });

  test('characters rig to 14 bones, props and worlds stay static', () => {
    for (const key of keys) {
      const recipe = generateBlueprint(key, 5);
      const bones = stats(buildAsset(recipe)).bones;
      const rigs =
        (recipe.kind === 'creature' || recipe.kind === 'person') &&
        recipe.rigged;
      expect(bones).toBe(rigs ? 14 : 0);
    }
  });

  test('mutations stay inside the documented limits', () => {
    let recipe = generateBlueprint('scout', 3);
    for (let i = 0; i < 25; i++) {
      recipe = mutateRecipe(recipe, i * 977, 1);
      expect(() => parseRecipe(recipe)).not.toThrow();
      for (const [key, [min, max]] of Object.entries(limits)) {
        const value = recipe[key as keyof typeof recipe] as number;
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThanOrEqual(max);
      }
    }
  });

  test('a mutation actually changes the asset', async () => {
    const source = generateBlueprint('guardian', 21);
    const mutated = mutateRecipe(source, 99, 0.8);
    expect(mutated).not.toEqual(source);
    expect(mutated.kind).toBe(source.kind);
    expect(digest(await recipeGLB(mutated))).not.toBe(
      digest(await recipeGLB(source)),
    );
  });

  test('creature variations move the eye count', () => {
    const source = generateBlueprint('trickster', 17);
    const eyes = new Set(
      Array.from({ length: 24 }, (_, i) => mutateRecipe(source, i + 1, 0.8).eyes),
    );
    expect(eyes.size).toBeGreaterThan(1);
  });

  test('people and props keep their eye value untouched', () => {
    for (const key of ['villager', 'tree'] as Blueprint[]) {
      const source = generateBlueprint(key, 31);
      for (let i = 0; i < 10; i++)
        expect(mutateRecipe(source, i + 1, 1).eyes).toBe(source.eyes);
    }
  });
});

describe('determinism', () => {
  test('the same seed exports byte-identical GLB', async () => {
    for (const key of ['scout', 'villager', 'tree', 'grove'] as Blueprint[]) {
      const recipe = generateBlueprint(key, 4242);
      const [a, b] = await Promise.all([
        recipeGLB(recipe),
        recipeGLB(recipe),
      ]);
      expect(digest(a)).toBe(digest(b));
    }
  });

  test('different seeds produce different geometry', async () => {
    const a = await recipeGLB(generateBlueprint('scout', 1));
    const b = await recipeGLB(generateBlueprint('scout', 2));
    expect(digest(a)).not.toBe(digest(b));
  });
});

describe('mesh hygiene', () => {
  test('geometry is non-indexed with flat normals and merged materials', () => {
    const model = buildAsset(generateBlueprint('beast', 8));
    let checked = 0;
    model.traverse((o) => {
      if (o instanceof T.Mesh) {
        checked++;
        expect(o.geometry.index).toBeNull();
        expect(o.geometry.attributes.normal).toBeDefined();
        expect((o.material as T.MeshStandardMaterial).flatShading).toBe(true);
      }
    });
    expect(checked).toBeGreaterThan(0);
    expect(stats(model).materials).toBeLessThanOrEqual(stats(model).meshes);
  });
});
