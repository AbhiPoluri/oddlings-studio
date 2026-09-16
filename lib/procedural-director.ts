import {
  initialRecipe,
  parseRecipe,
  type Recipe,
  type Kind,
} from './asset-recipe';
export const blueprints = {
  scout: {
    kind: 'creature',
    archetype: 'oddling',
    label: 'Scout',
    description: 'Light, alert, long-eared explorer',
  },
  guardian: {
    kind: 'creature',
    archetype: 'oddling',
    label: 'Guardian',
    description: 'Broad, sturdy, horned defender',
  },
  trickster: {
    kind: 'creature',
    archetype: 'oddling',
    label: 'Trickster',
    description: 'Lopsided, many-eyed little menace',
  },
  beast: {
    kind: 'creature',
    archetype: 'oddling',
    label: 'Beast',
    description: 'Heavy, toothy monster silhouette',
  },
  villager: {
    kind: 'person',
    archetype: 'person',
    label: 'Villager',
    description: 'Friendly stylized game character',
  },
  ranger: {
    kind: 'person',
    archetype: 'person',
    label: 'Ranger',
    description: 'Lean explorer with a hood and pack',
  },
  custom: {
    kind: 'prop',
    archetype: 'kitbash',
    label: 'Custom form',
    description: 'Core, modules, supports, and details',
  },
  tree: {
    kind: 'prop',
    archetype: 'tree',
    label: 'Tree',
    description: 'Standalone trunk, branches, and crown',
  },
  boulder: {
    kind: 'prop',
    archetype: 'rock',
    label: 'Boulder',
    description: 'Faceted game-ready rock formation',
  },
  mushroom: {
    kind: 'prop',
    archetype: 'mushroom',
    label: 'Mushroom',
    description: 'Oversized cap with procedural spots',
  },
  hut: {
    kind: 'prop',
    archetype: 'hut',
    label: 'Hut',
    description: 'Small standalone fantasy dwelling',
  },
  grove: {
    kind: 'environment',
    archetype: 'island',
    label: 'Grove',
    description: 'Dense trees, stones, and a pond',
  },
  outpost: {
    kind: 'environment',
    archetype: 'island',
    label: 'Outpost',
    description: 'Huts, paths, and sparse woodland',
  },
  ruins: {
    kind: 'environment',
    archetype: 'island',
    label: 'Ruins',
    description: 'Rocky clearing with scattered remains',
  },
  fungal: {
    kind: 'environment',
    archetype: 'island',
    label: 'Fungal wilds',
    description: 'Overgrown mushroom biome',
  },
} as const;
export type Blueprint = keyof typeof blueprints;
export const defaultBlueprint: Record<Kind, Blueprint> = {
  creature: 'scout',
  person: 'villager',
  prop: 'custom',
  environment: 'grove',
};
const characterColors = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
  '#b3c4de',
  '#d7ddd0',
];
const worldColors = [
  '#596c50',
  '#626c53',
  '#50675c',
  '#8d8172',
  '#68798b',
  '#867887',
];
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function jitter(
  r: () => number,
  v: number,
  a: number,
  min: number,
  max: number,
) {
  return Math.max(min, Math.min(max, v + (r() - 0.5) * a * 2));
}
function count(
  r: () => number,
  v: number,
  a: number,
  min: number,
  max: number,
) {
  return Math.round(jitter(r, v, a, min, max));
}
const names: Record<Blueprint, string[]> = {
  scout: ['Sprig', 'Nim', 'Pip'],
  guardian: ['Bramble', 'Mossguard', 'Thorn'],
  trickster: ['Wobble', 'Tangle', 'Boggle'],
  beast: ['Grumble', 'Gnash', 'Maw'],
  villager: ['Mira', 'Pollen', 'Tavi'],
  ranger: ['Ash', 'Rowan', 'Fern'],
  custom: ['Module', 'Construct', 'Artifact'],
  tree: ['Old Oak', 'Whisper Tree', 'Crooked Pine'],
  boulder: ['Moss Rock', 'Grey Stone', 'Tumbled Boulder'],
  mushroom: ['Glowcap', 'Spore Bell', 'Mooncap'],
  hut: ['Acorn Hut', 'Wayfarer Hut', 'Moss Cottage'],
  grove: ['Fern Hollow', 'Quiet Grove', 'Greenfold'],
  outpost: ['Pebble Outpost', 'Moss Camp', 'Little Hold'],
  ruins: ['Old Stones', 'Broken Circle', 'Grey Remains'],
  fungal: ['Sporewood', 'Glowcap Fen', 'Mushroom Wilds'],
};
function codeName(b: Blueprint, s: number) {
  const list = names[b];
  return `${list[s % list.length]} ${String(s).slice(-3).padStart(3, '0')}`;
}
export function generateBlueprint(blueprint: Blueprint, seed: number): Recipe {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
    throw Error('Seed must be an integer from 0 to 2147483647.');
  const rng = random(seed),
    meta = blueprints[blueprint];
  if (!meta) throw Error('Unknown procedural blueprint.');
  const character = meta.kind === 'creature' || meta.kind === 'person',
    palette = character ? characterColors : worldColors;
  const base: Recipe = {
    ...initialRecipe,
    kind: meta.kind,
    archetype: meta.archetype,
    name: codeName(blueprint, seed),
    seed,
    color: palette[Math.floor(rng() * palette.length)],
    rigged: character,
  };
  const profiles: Record<Blueprint, Partial<Recipe>> = {
    scout: {
      width: 0.82,
      height: 1.2,
      roughness: 0.06,
      eyes: 2,
      horns: 0,
      teeth: 2,
      ears: 1.5,
      scale: 0.78,
      hipHeight: 0.57,
      headPivot: 1.08,
      shoulderWidth: 0.22,
    },
    guardian: {
      width: 1.36,
      height: 0.96,
      eyes: 2,
      horns: 4,
      teeth: 5,
      ears: 0.65,
      scale: 1.2,
    },
    trickster: {
      width: 1.03,
      height: 0.9,
      roughness: 0.27,
      eyes: 4,
      horns: 2,
      teeth: 7,
      ears: 1.15,
      scale: 0.72,
    },
    beast: {
      width: 1.42,
      height: 1.16,
      roughness: 0.19,
      eyes: 3,
      horns: 6,
      teeth: 10,
      ears: 0.25,
      scale: 1.45,
    },
    villager: {
      width: 0.94,
      height: 1,
      roughness: 0.05,
      eyes: 2,
      horns: 2,
      teeth: 3,
      ears: 0.5,
      hipHeight: 0.72,
      headPivot: 1.5,
      shoulderWidth: 0.34,
    },
    ranger: {
      width: 0.82,
      height: 1.13,
      roughness: 0.12,
      eyes: 2,
      horns: 4,
      teeth: 1,
      ears: 0.8,
      hipHeight: 0.76,
      headPivot: 1.58,
      shoulderWidth: 0.3,
    },
    custom: {
      width: 1,
      height: 1,
      roughness: 0.15,
      horns: 4,
      teeth: 6,
      ears: 1,
      rigged: false,
    },
    tree: {
      width: 1,
      height: 1.2,
      roughness: 0.16,
      horns: 6,
      teeth: 5,
      ears: 1,
      rigged: false,
    },
    boulder: {
      width: 1.25,
      height: 0.8,
      roughness: 0.25,
      horns: 1,
      teeth: 3,
      ears: 0.7,
      rigged: false,
    },
    mushroom: {
      width: 1.15,
      height: 0.95,
      roughness: 0.08,
      horns: 0,
      teeth: 7,
      ears: 0.8,
      rigged: false,
    },
    hut: {
      width: 1,
      height: 1,
      roughness: 0.05,
      horns: 1,
      teeth: 2,
      ears: 1,
      rigged: false,
    },
    grove: { trees: 21, huts: 0, rocks: 22, plants: 68, pond: true },
    outpost: { trees: 8, huts: 5, rocks: 14, plants: 28, pond: false },
    ruins: { trees: 3, huts: 2, rocks: 39, plants: 16, pond: false },
    fungal: { trees: 13, huts: 1, rocks: 17, plants: 100, pond: true },
  };
  const recipe = { ...base, ...profiles[blueprint] };
  if (meta.kind === 'environment') {
    recipe.trees = count(rng, recipe.trees, 3, 0, 24);
    recipe.huts = count(rng, recipe.huts, 1, 0, 5);
    recipe.rocks = count(rng, recipe.rocks, 4, 0, 40);
    recipe.plants = count(rng, recipe.plants, 8, 0, 100);
  } else {
    recipe.width = jitter(rng, recipe.width, 0.08, 0.6, 1.5);
    recipe.height = jitter(rng, recipe.height, 0.08, 0.65, 1.5);
    recipe.roughness = jitter(rng, recipe.roughness, 0.025, 0, 0.3);
    recipe.horns = count(rng, recipe.horns, 1, 0, 8);
    recipe.teeth = count(rng, recipe.teeth, 1, 0, 10);
  }
  return parseRecipe(recipe);
}
export function mutateRecipe(
  current: Recipe,
  seed: number,
  strength: number,
): Recipe {
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
    throw Error('Seed must be an integer from 0 to 2147483647.');
  const amount = Math.max(0.05, Math.min(1, strength)),
    rng = random(seed),
    character = current.kind === 'creature' || current.kind === 'person',
    palette = character ? characterColors : worldColors;
  const next: Recipe = {
    ...current,
    seed,
    name: `${current.name.replace(/\s\d{3}$/, '')} ${String(seed).slice(-3).padStart(3, '0')}`,
    color:
      rng() < amount * 0.45
        ? palette[Math.floor(rng() * palette.length)]
        : current.color,
  };
  if (current.kind === 'environment') {
    next.trees = count(rng, current.trees, 10 * amount, 0, 24);
    next.huts = count(rng, current.huts, 3 * amount, 0, 5);
    next.rocks = count(rng, current.rocks, 15 * amount, 0, 40);
    next.plants = count(rng, current.plants, 36 * amount, 0, 100);
    if (rng() < amount * 0.3) next.pond = !current.pond;
  } else {
    next.width = jitter(rng, current.width, 0.28 * amount, 0.6, 1.5);
    next.height = jitter(rng, current.height, 0.28 * amount, 0.65, 1.5);
    next.roughness = jitter(rng, current.roughness, 0.12 * amount, 0, 0.3);
    next.horns = count(rng, current.horns, 3 * amount, 0, 8);
    next.teeth = count(rng, current.teeth, 4 * amount, 0, 10);
    next.ears = jitter(rng, current.ears, 0.65 * amount, 0, 1.8);
    if (character) {
      next.hipHeight = jitter(rng, current.hipHeight, 0.1 * amount, 0.35, 0.85);
      next.headPivot = jitter(rng, current.headPivot, 0.2 * amount, 0.7, 1.65);
      next.shoulderWidth = jitter(
        rng,
        current.shoulderWidth,
        0.08 * amount,
        0.2,
        0.55,
      );
    }
  }
  return parseRecipe(next);
}
