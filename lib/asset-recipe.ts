export type Kind = 'creature' | 'person' | 'prop' | 'environment';
export type Archetype =
  | 'oddling'
  | 'person'
  | 'kitbash'
  | 'tree'
  | 'rock'
  | 'mushroom'
  | 'hut'
  | 'island';
export type Recipe = {
  version: 1;
  kind: Kind;
  archetype: Archetype;
  name: string;
  seed: number;
  color: string;
  width: number;
  height: number;
  roughness: number;
  eyes: number;
  horns: number;
  teeth: number;
  ears: number;
  trees: number;
  huts: number;
  rocks: number;
  plants: number;
  pond: boolean;
  scale: number;
  rigged: boolean;
  hipHeight: number;
  headPivot: number;
  shoulderWidth: number;
};
export const initialRecipe: Recipe = {
  version: 1,
  kind: 'creature',
  archetype: 'oddling',
  name: 'Mossling',
  seed: 13921440,
  color: '#93cec8',
  width: 1,
  height: 1,
  roughness: 0.12,
  eyes: 3,
  horns: 4,
  teeth: 6,
  ears: 1,
  trees: 12,
  huts: 3,
  rocks: 22,
  plants: 45,
  pond: true,
  scale: 1,
  rigged: true,
  hipHeight: 0.48,
  headPivot: 0.9,
  shoulderWidth: 0.28,
};
export const limits = {
  width: [0.6, 1.5],
  height: [0.65, 1.5],
  roughness: [0, 0.3],
  eyes: [1, 5],
  horns: [0, 8],
  teeth: [0, 10],
  ears: [0, 1.8],
  trees: [0, 24],
  huts: [0, 5],
  rocks: [0, 40],
  plants: [0, 100],
  scale: [0.1, 5],
  hipHeight: [0.35, 0.85],
  headPivot: [0.7, 1.65],
  shoulderWidth: [0.2, 0.55],
} as const;
const kinds: Kind[] = ['creature', 'person', 'prop', 'environment'];
const archetypes: Archetype[] = [
  'oddling',
  'person',
  'kitbash',
  'tree',
  'rock',
  'mushroom',
  'hut',
  'island',
];
export function parseRecipe(input: unknown): Recipe {
  if (!input || typeof input !== 'object')
    throw Error('Choose an Oddlings recipe JSON file.');
  const p = { ...input } as Record<string, unknown>;
  if (p.archetype === undefined)
    p.archetype = p.kind === 'environment' ? 'island' : 'oddling';
  for (const k of [
    'rigged',
    'hipHeight',
    'headPivot',
    'shoulderWidth',
  ] as const)
    if (p[k] === undefined) p[k] = initialRecipe[k];
  if (typeof p.rigged !== 'boolean') throw Error('Invalid rig setting.');
  if (
    p.version !== 1 ||
    !kinds.includes(p.kind as Kind) ||
    !archetypes.includes(p.archetype as Archetype) ||
    typeof p.name !== 'string' ||
    p.name.length > 60 ||
    !Number.isInteger(p.seed) ||
    Number(p.seed) < 0 ||
    Number(p.seed) > 2147483647 ||
    typeof p.color !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(p.color) ||
    typeof p.pond !== 'boolean'
  )
    throw Error('This file is not a supported asset recipe.');
  const allowed: Record<Kind, Archetype[]> = {
    creature: ['oddling'],
    person: ['person'],
    prop: ['kitbash', 'tree', 'rock', 'mushroom', 'hut'],
    environment: ['island'],
  };
  if (!allowed[p.kind as Kind].includes(p.archetype as Archetype))
    throw Error('Invalid asset archetype.');
  for (const [k, [min, max]] of Object.entries(limits)) {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw Error(`Invalid recipe value: ${k}`);
  }
  for (const k of [
    'eyes',
    'horns',
    'teeth',
    'trees',
    'huts',
    'rocks',
    'plants',
  ])
    if (!Number.isInteger(p[k])) throw Error(`Invalid count: ${k}`);
  return Object.fromEntries(
    Object.keys(initialRecipe).map((k) => [k, p[k]]),
  ) as Recipe;
}
export function fileName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'oddling'
  );
}
