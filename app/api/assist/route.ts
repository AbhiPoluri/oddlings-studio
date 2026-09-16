import { env } from 'cloudflare:workers';
import { initialRecipe, parseRecipe, type Recipe } from '@/lib/asset-recipe';

type Mode = 'create' | 'refine';
type Choice = {
  type: 'choice';
  choice: string;
  confidence?: number;
};
type JevResponse = {
  model?: string;
  answers?: Record<string, Choice>;
};

const palettes = {
  seafoam: '#93cec8',
  berry: '#c7a4b5',
  pollen: '#d2c385',
  twilight: '#a7aed2',
  clay: '#d2ac87',
  moss: '#b8c99a',
  mist: '#b3c4de',
  bone: '#d7ddd0',
} as const;

const worldPalettes = {
  seafoam: '#50675c',
  berry: '#867887',
  pollen: '#8d8172',
  twilight: '#68798b',
  clay: '#8d8172',
  moss: '#596c50',
  mist: '#68798b',
  bone: '#626c53',
} as const;

const names = {
  creature: ['Mossling', 'Wobble', 'Nettle', 'Bramble', 'Mumble', 'Sprig'],
  environment: [
    'Fern Hollow',
    'Quiet Clearing',
    'Moon Garden',
    'Mossy Outpost',
    'Pebble Grove',
  ],
};

let inFlight = 0;
let lastRequestAt = 0;

function question(instructions: string, criteria: Record<string, string>) {
  return { type: 'choice', instructions, criteria };
}

const commonQuestions = {
  kind: question('Choose the asset category requested.', {
    creature: 'A character, monster, animal, person, or living thing.',
    environment: 'A place, landscape, biome, clearing, village, or level area.',
  }),
  palette: question('Choose the closest color mood.', {
    seafoam: 'Cool blue-green, aquatic, mint, or friendly.',
    berry: 'Pink, plum, berry, warm magical, or soft.',
    pollen: 'Yellow, gold, dry grass, or sunny.',
    twilight: 'Blue-violet, moonlit, mysterious, or arcane.',
    clay: 'Orange-brown, terracotta, desert, or warm earth.',
    moss: 'Green, mossy, leafy, or natural.',
    mist: 'Pale blue-grey, icy, cloudy, or ghostly.',
    bone: 'Pale neutral, bone, cream, stone, or uncolored.',
  }),
  scale: question('Choose a practical relative game scale.', {
    tiny: 'Tiny prop or critter, about half normal size.',
    small: 'Small character or compact game asset.',
    normal: 'Normal hero, NPC, or scene scale.',
    large: 'Large creature, landmark, or set piece.',
  }),
};

const createQuestions = {
  ...commonQuestions,
  width: question('Choose the head or overall silhouette width.', {
    narrow: 'Narrow, thin, delicate, or lean.',
    balanced: 'Balanced or unspecified.',
    wide: 'Wide, broad, round, chunky, or stout.',
  }),
  height: question('Choose the head or overall silhouette height.', {
    squat: 'Short, squat, compressed, or low.',
    balanced: 'Balanced or unspecified.',
    tall: 'Tall, stretched, long, or lanky.',
  }),
  roughness: question('Choose how irregular the shape should be.', {
    smooth: 'Clean, symmetrical, polished, or cute.',
    organic: 'Slightly organic or unspecified.',
    lopsided: 'Asymmetric, rough, wild, handmade, or strange.',
  }),
  eyes: question('Choose the requested or most fitting eye count.', {
    one: 'One eye or cyclops.',
    two: 'Two eyes or unspecified familiar face.',
    three: 'Three eyes, magical, or slightly strange.',
    four: 'Four eyes, alien, insect-like, or unusual.',
    five: 'Five eyes, very strange, chaotic, or eldritch.',
  }),
  horns: question('Choose horn abundance.', {
    none: 'No horns, antlers, spikes, or crown.',
    subtle: 'Two small horns, antennae, or a subtle crown.',
    crowned: 'Four horns, antlers, spikes, or a clear crown.',
    wild: 'Many horns, antlers, spikes, or a dramatic crown.',
  }),
  teeth: question('Choose visible tooth abundance.', {
    none: 'No visible teeth or closed mouth.',
    shy: 'A few small teeth or a restrained expression.',
    grin: 'A clear friendly or mischievous grin.',
    toothy: 'Many teeth, fierce, hungry, or monster-like.',
  }),
  ears: question('Choose ear size.', {
    none: 'No ears.',
    small: 'Small ears or unclear ears.',
    clear: 'Clearly visible medium ears.',
    large: 'Large, long, wing-like, rabbit, goblin, or elf ears.',
  }),
  trees: question('Choose tree density for an environment.', {
    none: 'No trees or barren.',
    sparse: 'A few trees or open terrain.',
    grove: 'A normal grove or unspecified nature scene.',
    forest: 'Dense forest or many trees.',
  }),
  huts: question('Choose building density for an environment.', {
    none: 'No huts or buildings.',
    camp: 'One small hut, tent, or camp.',
    hamlet: 'A few huts or a tiny settlement.',
    village: 'A village or several buildings.',
  }),
  rocks: question('Choose rock density for an environment.', {
    few: 'Clean, soft, or almost no rocks.',
    scattered: 'Some scattered stones.',
    rocky: 'Rocky terrain or many stones.',
    field: 'A dense boulder field or very rugged ground.',
  }),
  plants: question('Choose small plant or mushroom density.', {
    bare: 'Bare ground or no small plants.',
    sparse: 'A few plants or mushrooms.',
    lush: 'Lush ground cover or many small plants.',
    overgrown: 'Very dense, overgrown, fungal, or enchanted.',
  }),
  pond: question('Choose whether the environment needs water.', {
    no: 'Dry environment or no water requested.',
    yes: 'Pond, pool, lake, swamp, oasis, or visible water.',
  }),
  rigged: question('Choose whether a creature should have an animation rig.', {
    yes: 'A creature, character, NPC, enemy, or anything meant to animate.',
    no: 'A static creature prop or an environment.',
  }),
  hips: question('Choose the body rig hip height.', {
    low: 'Short legs, heavy body, squat, or grounded.',
    neutral: 'Balanced or unspecified proportions.',
    high: 'Long legs, tall, nimble, or lanky.',
  }),
  headPivot: question('Choose the head joint height.', {
    low: 'Low-set head, hunched, or neckless.',
    neutral: 'Balanced or unspecified head placement.',
    high: 'High-set head, long neck, tall head, or upright.',
  }),
  shoulders: question('Choose the body rig shoulder width.', {
    narrow: 'Narrow, delicate, or lean shoulders.',
    neutral: 'Balanced or unspecified shoulders.',
    wide: 'Broad, strong, chunky, or imposing shoulders.',
  }),
};

const deltas = {
  much_less: 'Make this much smaller, fewer, lower, smoother, or narrower.',
  less: 'Make this somewhat smaller, fewer, lower, smoother, or narrower.',
  keep: 'The instruction does not request a change to this setting.',
  more: 'Make this somewhat larger, more numerous, higher, rougher, or wider.',
  much_more: 'Make this much larger, more numerous, higher, rougher, or wider.',
};

function refineQuestions() {
  const choices: Record<string, ReturnType<typeof question>> = {
    palette: question('Should the current color mood change?', {
      keep: 'No color or palette change is requested.',
      seafoam: 'Change to cool blue-green, aquatic, or mint.',
      berry: 'Change to pink, plum, berry, or warm magical.',
      pollen: 'Change to yellow, gold, dry grass, or sunny.',
      twilight: 'Change to blue-violet, moonlit, mysterious, or arcane.',
      clay: 'Change to orange-brown, terracotta, desert, or warm earth.',
      moss: 'Change to green, mossy, leafy, or natural.',
      mist: 'Change to pale blue-grey, icy, cloudy, or ghostly.',
      bone: 'Change to a pale neutral, bone, cream, or stone.',
    }),
    kind: question('Should the current asset category change?', {
      keep: 'No category change is requested.',
      creature: 'Turn it into a character, monster, animal, or living thing.',
      environment: 'Turn it into a place, landscape, biome, or level area.',
    }),
    pond: question('Should the current water setting change?', {
      keep: 'No change to water is requested.',
      no: 'Remove the pond or make it dry.',
      yes: 'Add a pond, pool, swamp, oasis, or water.',
    }),
    rigged: question('Should the current rig setting change?', {
      keep: 'No rig change is requested.',
      yes: 'Add or enable a body rig for animation.',
      no: 'Remove the rig or make this static.',
    }),
    seed: question('Should this become a new procedural variation?', {
      keep: 'Keep the same underlying variation.',
      new: 'Make a new variation, remix, regenerate, or change the seed.',
    }),
  };
  for (const key of [
    'width',
    'height',
    'roughness',
    'eyes',
    'horns',
    'teeth',
    'ears',
    'trees',
    'huts',
    'rocks',
    'plants',
    'hips',
    'headPivot',
    'shoulders',
  ])
    choices[key] = question(
      `Decide how the instruction changes ${key}. The current recipe is in state.`,
      deltas,
    );
  choices.scale = question(
    'Decide whether to change the whole asset scale in game units. Words about proportions such as taller, wider, shorter legs, or a bigger head do not change this setting.',
    {
      much_less: 'Make the entire asset much smaller in the game world.',
      less: 'Make the entire asset somewhat smaller in the game world.',
      keep: 'No explicit overall game-world size or scale change is requested.',
      more: 'Make the entire asset somewhat larger in the game world.',
      much_more: 'Make the entire asset much larger in the game world.',
    },
  );
  return choices;
}

function picked(
  answers: Record<string, Choice>,
  key: string,
  fallback: string,
) {
  const value = answers[key]?.choice;
  return typeof value === 'string' ? value : fallback;
}

function value<T>(map: Record<string, T>, choice: string, fallback: T) {
  return Object.prototype.hasOwnProperty.call(map, choice)
    ? map[choice]
    : fallback;
}

function delta(
  current: number,
  choice: string,
  step: number,
  min: number,
  max: number,
) {
  const multiplier = value(
    { much_less: -2, less: -1, keep: 0, more: 1, much_more: 2 },
    choice,
    0,
  );
  return Math.max(min, Math.min(max, current + multiplier * step));
}

function named(kind: Recipe['kind'], seed: number) {
  const list = names[kind];
  return `${list[seed % list.length]} ${String(seed).slice(-3).padStart(3, '0')}`;
}

function createRecipe(answers: Record<string, Choice>) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
  const kind = picked(answers, 'kind', 'creature') as Recipe['kind'];
  const colorMap = kind === 'creature' ? palettes : worldPalettes;
  const palette = picked(
    answers,
    'palette',
    kind === 'creature' ? 'seafoam' : 'forest',
  );
  return parseRecipe({
    ...initialRecipe,
    kind,
    seed,
    name: named(kind, seed),
    color: value(colorMap, palette, Object.values(colorMap)[0]),
    width: value(
      { narrow: 0.75, balanced: 1, wide: 1.35 },
      picked(answers, 'width', 'balanced'),
      1,
    ),
    height: value(
      { squat: 0.78, balanced: 1, tall: 1.35 },
      picked(answers, 'height', 'balanced'),
      1,
    ),
    roughness: value(
      { smooth: 0.03, organic: 0.12, lopsided: 0.27 },
      picked(answers, 'roughness', 'organic'),
      0.12,
    ),
    eyes: value(
      { one: 1, two: 2, three: 3, four: 4, five: 5 },
      picked(answers, 'eyes', 'two'),
      2,
    ),
    horns: value(
      { none: 0, subtle: 2, crowned: 4, wild: 8 },
      picked(answers, 'horns', 'subtle'),
      2,
    ),
    teeth: value(
      { none: 0, shy: 3, grin: 6, toothy: 10 },
      picked(answers, 'teeth', 'grin'),
      6,
    ),
    ears: value(
      { none: 0, small: 0.55, clear: 1, large: 1.65 },
      picked(answers, 'ears', 'clear'),
      1,
    ),
    trees: value(
      { none: 0, sparse: 6, grove: 12, forest: 23 },
      picked(answers, 'trees', 'grove'),
      12,
    ),
    huts: value(
      { none: 0, camp: 1, hamlet: 3, village: 5 },
      picked(answers, 'huts', 'hamlet'),
      3,
    ),
    rocks: value(
      { few: 5, scattered: 18, rocky: 30, field: 40 },
      picked(answers, 'rocks', 'scattered'),
      18,
    ),
    plants: value(
      { bare: 0, sparse: 24, lush: 62, overgrown: 100 },
      picked(answers, 'plants', 'lush'),
      62,
    ),
    pond: picked(answers, 'pond', 'no') === 'yes',
    scale: value(
      { tiny: 0.5, small: 0.8, normal: 1, large: 1.5 },
      picked(answers, 'scale', 'normal'),
      1,
    ),
    rigged: kind === 'creature' && picked(answers, 'rigged', 'yes') === 'yes',
    hipHeight: value(
      { low: 0.4, neutral: 0.48, high: 0.6 },
      picked(answers, 'hips', 'neutral'),
      0.48,
    ),
    headPivot: value(
      { low: 0.76, neutral: 0.9, high: 1.18 },
      picked(answers, 'headPivot', 'neutral'),
      0.9,
    ),
    shoulderWidth: value(
      { narrow: 0.22, neutral: 0.28, wide: 0.38 },
      picked(answers, 'shoulders', 'neutral'),
      0.28,
    ),
  });
}

function refineRecipe(current: Recipe, answers: Record<string, Choice>) {
  const requestedKind = picked(answers, 'kind', 'keep');
  const kind: Recipe['kind'] =
    requestedKind === 'creature' || requestedKind === 'environment'
      ? requestedKind
      : current.kind;
  const paletteKey = picked(answers, 'palette', '');
  const colorMap = kind === 'creature' ? palettes : worldPalettes;
  const seed =
    picked(answers, 'seed', 'keep') === 'new'
      ? crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647
      : current.seed;
  const next = {
    ...current,
    kind,
    seed,
    name:
      kind !== current.kind || seed !== current.seed
        ? named(kind, seed)
        : current.name,
    color:
      paletteKey in colorMap
        ? colorMap[paletteKey as keyof typeof colorMap]
        : current.color,
    width: delta(
      current.width,
      picked(answers, 'width', 'keep'),
      0.16,
      0.6,
      1.5,
    ),
    height: delta(
      current.height,
      picked(answers, 'height', 'keep'),
      0.16,
      0.65,
      1.5,
    ),
    roughness: delta(
      current.roughness,
      picked(answers, 'roughness', 'keep'),
      0.06,
      0,
      0.3,
    ),
    eyes: Math.round(
      delta(current.eyes, picked(answers, 'eyes', 'keep'), 1, 1, 5),
    ),
    horns: Math.round(
      delta(current.horns, picked(answers, 'horns', 'keep'), 2, 0, 8),
    ),
    teeth: Math.round(
      delta(current.teeth, picked(answers, 'teeth', 'keep'), 2, 0, 10),
    ),
    ears: delta(current.ears, picked(answers, 'ears', 'keep'), 0.35, 0, 1.8),
    trees: Math.round(
      delta(current.trees, picked(answers, 'trees', 'keep'), 5, 0, 24),
    ),
    huts: Math.round(
      delta(current.huts, picked(answers, 'huts', 'keep'), 1, 0, 5),
    ),
    rocks: Math.round(
      delta(current.rocks, picked(answers, 'rocks', 'keep'), 8, 0, 40),
    ),
    plants: Math.round(
      delta(current.plants, picked(answers, 'plants', 'keep'), 20, 0, 100),
    ),
    scale: delta(current.scale, picked(answers, 'scale', 'keep'), 0.25, 0.1, 5),
    hipHeight: delta(
      current.hipHeight,
      picked(answers, 'hips', 'keep'),
      0.06,
      0.35,
      0.65,
    ),
    headPivot: delta(
      current.headPivot,
      picked(answers, 'headPivot', 'keep'),
      0.12,
      0.7,
      1.3,
    ),
    shoulderWidth: delta(
      current.shoulderWidth,
      picked(answers, 'shoulders', 'keep'),
      0.04,
      0.2,
      0.4,
    ),
    pond:
      picked(answers, 'pond', 'keep') === 'keep'
        ? current.pond
        : picked(answers, 'pond', 'no') === 'yes',
    rigged:
      kind === 'creature' &&
      (picked(answers, 'rigged', 'keep') === 'keep'
        ? current.rigged
        : picked(answers, 'rigged', 'yes') === 'yes'),
  };
  return parseRecipe(next);
}

export async function POST(request: Request) {
  const now = Date.now();
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host)
    return Response.json(
      { error: 'Request origin is not allowed.' },
      { status: 403 },
    );
  if (inFlight >= 3 || now - lastRequestAt < 700)
    return Response.json(
      { error: 'The assistant is busy. Try again in a moment.' },
      { status: 429 },
    );
  let body: { mode?: Mode; prompt?: string; recipe?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Send a valid assistant request.' },
      { status: 400 },
    );
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const mode = body.mode === 'refine' ? 'refine' : 'create';
  if (prompt.length < 3 || prompt.length > 600)
    return Response.json(
      { error: 'Describe the asset in 3 to 600 characters.' },
      { status: 400 },
    );
  let current: Recipe | undefined;
  if (mode === 'refine') {
    try {
      current = parseRecipe(body.recipe);
    } catch {
      return Response.json(
        { error: 'The current asset recipe is invalid.' },
        { status: 400 },
      );
    }
  }
  const key =
    (env as unknown as { TYPESAFE_API_KEY?: string }).TYPESAFE_API_KEY ??
    process.env.TYPESAFE_API_KEY;
  if (!key)
    return Response.json(
      { error: 'The AI assistant is not configured yet.' },
      { status: 503 },
    );
  lastRequestAt = now;
  inFlight++;
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: {
          task:
            mode === 'create'
              ? 'Create a new procedural game asset.'
              : 'Refine the current procedural game asset.',
          instruction: prompt,
          current_recipe: current ?? null,
          note: 'Interpret only the user instruction. Choose keep for refine fields the instruction does not address.',
        },
        questions:
          mode === 'create' ? createQuestions : refineQuestions(),
      }),
    });
    if (!response.ok) throw Error(`Jev returned ${response.status}`);
    const data = (await response.json()) as JevResponse;
    const answers = data.answers ?? {};
    const recipe =
      mode === 'create'
        ? createRecipe(answers)
        : refineRecipe(current!, answers);
    const confidences = Object.values(answers)
      .map((answer) => answer.confidence)
      .filter(
        (confidence): confidence is number => typeof confidence === 'number',
      );
    const confidence = confidences.length
      ? confidences.reduce((sum, item) => sum + item, 0) / confidences.length
      : 0;
    return Response.json({ recipe, confidence, model: data.model ?? 'jev' });
  } catch (error) {
    console.error(
      'Jev asset assistant failed',
      error instanceof Error ? error.message : error,
    );
    return Response.json(
      { error: 'The AI assistant could not finish this draft. Try again.' },
      { status: 502 },
    );
  } finally {
    inFlight--;
  }
}
