import { initialRecipe, parseRecipe, type Recipe } from './asset-recipe';

export const blueprints = {
  scout: {
    kind: 'creature',
    label: 'Scout',
    description: 'Light, alert, long-eared explorer',
  },
  guardian: {
    kind: 'creature',
    label: 'Guardian',
    description: 'Broad, sturdy, horned defender',
  },
  trickster: {
    kind: 'creature',
    label: 'Trickster',
    description: 'Lopsided, many-eyed little menace',
  },
  beast: {
    kind: 'creature',
    label: 'Beast',
    description: 'Heavy, toothy monster silhouette',
  },
  grove: {
    kind: 'environment',
    label: 'Grove',
    description: 'Dense trees, stones, and a pond',
  },
  outpost: {
    kind: 'environment',
    label: 'Outpost',
    description: 'Huts, paths, and sparse woodland',
  },
  ruins: {
    kind: 'environment',
    label: 'Ruins',
    description: 'Rocky clearing with scattered remains',
  },
  fungal: {
    kind: 'environment',
    label: 'Fungal wilds',
    description: 'Overgrown mushroom biome',
  },
} as const;

export type Blueprint = keyof typeof blueprints;

const creatureColors = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
  '#b3c4de',
  '#d7ddd0',
];
const worldColors = ['#596c50', '#626c53', '#50675c', '#8d8172', '#68798b', '#867887'];

function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rng: () => number, value: number, amount: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value + (rng() - 0.5) * amount * 2));
}

function count(rng: () => number, value: number, amount: number, min: number, max: number) {
  return Math.round(jitter(rng, value, amount, min, max));
}

function codeName(blueprint: Blueprint, seed: number) {
  const roots: Record<Blueprint, string[]> = {
    scout: ['Sprig', 'Nim', 'Pip', 'Scout'],
    guardian: ['Bramble', 'Mossguard', 'Thorn', 'Bulwark'],
    trickster: ['Wobble', 'Mumble', 'Tangle', 'Boggle'],
    beast: ['Grumble', 'Gnash', 'Tusk', 'Maw'],
    grove: ['Fern Hollow', 'Quiet Grove', 'Moss Garden', 'Greenfold'],
    outpost: ['Pebble Outpost', 'Moss Camp', 'Wayfarer Rest', 'Little Hold'],
    ruins: ['Old Stones', 'Broken Circle', 'Grey Remains', 'Forgotten Court'],
    fungal: ['Sporewood', 'Mushroom Wilds', 'Glowcap Fen', 'Mycelium Hollow'],
  };
  const list = roots[blueprint];
  return `${list[seed % list.length]} ${String(seed).slice(-3).padStart(3, '0')}`;
}

export function generateBlueprint(blueprint: Blueprint, seed: number): Recipe {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
    throw Error('Seed must be an integer from 0 to 2147483647.');
  const rng = random(seed);
  const meta = blueprints[blueprint];
  if (!meta) throw Error('Unknown procedural blueprint.');
  const base: Recipe = {
    ...initialRecipe,
    kind: meta.kind,
    name: codeName(blueprint, seed),
    seed,
    color:
      meta.kind === 'creature'
        ? creatureColors[Math.floor(rng() * creatureColors.length)]
        : worldColors[Math.floor(rng() * worldColors.length)],
    rigged: meta.kind === 'creature',
  };
  const profiles: Record<Blueprint, Partial<Recipe>> = {
    scout: { width: 0.82, height: 1.2, roughness: 0.06, eyes: 2, horns: 0, teeth: 2, ears: 1.5, scale: 0.78, hipHeight: 0.57, headPivot: 1.08, shoulderWidth: 0.22 },
    guardian: { width: 1.36, height: 0.96, roughness: 0.1, eyes: 2, horns: 4, teeth: 5, ears: 0.65, scale: 1.2, hipHeight: 0.43, headPivot: 0.86, shoulderWidth: 0.38 },
    trickster: { width: 1.03, height: 0.9, roughness: 0.27, eyes: 4, horns: 2, teeth: 7, ears: 1.15, scale: 0.72, hipHeight: 0.49, headPivot: 0.88, shoulderWidth: 0.27 },
    beast: { width: 1.42, height: 1.16, roughness: 0.19, eyes: 3, horns: 6, teeth: 10, ears: 0.25, scale: 1.45, hipHeight: 0.4, headPivot: 1.02, shoulderWidth: 0.4 },
    grove: { trees: 21, huts: 0, rocks: 22, plants: 68, pond: true, scale: 1 },
    outpost: { trees: 8, huts: 5, rocks: 14, plants: 28, pond: false, scale: 1 },
    ruins: { trees: 3, huts: 2, rocks: 39, plants: 16, pond: false, scale: 1 },
    fungal: { trees: 13, huts: 1, rocks: 17, plants: 100, pond: true, scale: 1 },
  };
  const recipe = { ...base, ...profiles[blueprint] };
  if (meta.kind === 'creature') {
    recipe.width = jitter(rng, recipe.width, 0.08, 0.6, 1.5);
    recipe.height = jitter(rng, recipe.height, 0.08, 0.65, 1.5);
    recipe.roughness = jitter(rng, recipe.roughness, 0.025, 0, 0.3);
    recipe.eyes = count(rng, recipe.eyes, 1, 1, 5);
    recipe.horns = count(rng, recipe.horns, 1, 0, 8);
    recipe.teeth = count(rng, recipe.teeth, 1, 0, 10);
  } else {
    recipe.trees = count(rng, recipe.trees, 3, 0, 24);
    recipe.huts = count(rng, recipe.huts, 1, 0, 5);
    recipe.rocks = count(rng, recipe.rocks, 4, 0, 40);
    recipe.plants = count(rng, recipe.plants, 8, 0, 100);
  }
  return parseRecipe(recipe);
}

export function mutateRecipe(current: Recipe, seed: number, strength: number): Recipe {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
    throw Error('Seed must be an integer from 0 to 2147483647.');
  const amount = Math.max(0.05, Math.min(1, strength));
  const rng = random(seed);
  const next: Recipe = {
    ...current,
    seed,
    name: `${current.name.replace(/\s\d{3}$/, '')} ${String(seed).slice(-3).padStart(3, '0')}`,
    color:
      rng() < amount * 0.45
        ? (current.kind === 'creature' ? creatureColors : worldColors)[
            Math.floor(rng() * (current.kind === 'creature' ? creatureColors : worldColors).length)
          ]
        : current.color,
  };
  if (current.kind === 'creature') {
    next.width = jitter(rng, current.width, 0.28 * amount, 0.6, 1.5);
    next.height = jitter(rng, current.height, 0.28 * amount, 0.65, 1.5);
    next.roughness = jitter(rng, current.roughness, 0.12 * amount, 0, 0.3);
    next.eyes = count(rng, current.eyes, 2 * amount, 1, 5);
    next.horns = count(rng, current.horns, 3 * amount, 0, 8);
    next.teeth = count(rng, current.teeth, 4 * amount, 0, 10);
    next.ears = jitter(rng, current.ears, 0.65 * amount, 0, 1.8);
    next.hipHeight = jitter(rng, current.hipHeight, 0.1 * amount, 0.35, 0.65);
    next.headPivot = jitter(rng, current.headPivot, 0.2 * amount, 0.7, 1.3);
    next.shoulderWidth = jitter(rng, current.shoulderWidth, 0.08 * amount, 0.2, 0.4);
  } else {
    next.trees = count(rng, current.trees, 10 * amount, 0, 24);
    next.huts = count(rng, current.huts, 3 * amount, 0, 5);
    next.rocks = count(rng, current.rocks, 15 * amount, 0, 40);
    next.plants = count(rng, current.plants, 36 * amount, 0, 100);
    if (rng() < amount * 0.3) next.pond = !current.pond;
  }
  return parseRecipe(next);
}
