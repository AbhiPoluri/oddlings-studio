import { parseRecipe, type Recipe } from './asset-recipe';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from './procedural-director';

type StudioTool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean };
  execute: (input: unknown) => unknown;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: StudioTool,
        options: { signal: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}
export function registerStudioTools(
  read: () => Recipe,
  update: (r: Recipe) => void,
) {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools: StudioTool[] = [
    {
      name: 'read_asset_recipe',
      description:
        'Read the current procedural asset settings, including its rig.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input: unknown) {
        if (!input || typeof input !== 'object' || Object.keys(input).length)
          throw Error('Expected an empty object.');
        return read();
      },
    },
    {
      name: 'update_asset_recipe',
      description:
        'Update the current asset by supplying a complete valid recipe. Updates the preview and adds an undo step; does not save to the library or export.',
      inputSchema: {
        type: 'object',
        properties: { recipe: { type: 'object' } },
        required: ['recipe'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(input: unknown) {
        if (
          !input ||
          typeof input !== 'object' ||
          Object.keys(input).length !== 1 ||
          !('recipe' in input)
        )
          throw Error('Expected one recipe.');
        const recipe = parseRecipe(input.recipe);
        update(recipe);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return read();
      },
    },
    {
      name: 'generate_procedural_asset',
      description:
        'Generate a complete editable asset locally from a named code blueprint and integer seed. Updates the visible recipe as one undoable step; does not use an LLM, save, or export.',
      inputSchema: {
        type: 'object',
        properties: {
          blueprint: { type: 'string', enum: Object.keys(blueprints) },
          seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
        },
        required: ['blueprint', 'seed'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(input: unknown) {
        if (
          !input ||
          typeof input !== 'object' ||
          Object.keys(input).length !== 2 ||
          !('blueprint' in input) ||
          !('seed' in input) ||
          typeof input.blueprint !== 'string' ||
          !(input.blueprint in blueprints) ||
          !Number.isInteger(input.seed)
        )
          throw Error('Expected a valid blueprint and integer seed.');
        const recipe = generateBlueprint(
          input.blueprint as Blueprint,
          input.seed as number,
        );
        update(recipe);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return read();
      },
    },
    {
      name: 'mutate_procedural_asset',
      description:
        'Create a deterministic code-generated variation of the current asset from a new seed and mutation strength. Updates the visible recipe as one undoable step; does not use an LLM, save, or export.',
      inputSchema: {
        type: 'object',
        properties: {
          seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
          strength: { type: 'number', minimum: 0.05, maximum: 1 },
        },
        required: ['seed', 'strength'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(input: unknown) {
        if (
          !input ||
          typeof input !== 'object' ||
          Object.keys(input).length !== 2 ||
          !('seed' in input) ||
          !('strength' in input) ||
          !Number.isInteger(input.seed) ||
          typeof input.strength !== 'number'
        )
          throw Error('Expected an integer seed and mutation strength from 0.05 to 1.');
        const recipe = mutateRecipe(
          read(),
          input.seed as number,
          input.strength,
        );
        update(recipe);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return read();
      },
    },
  ];
  for (const tool of tools)
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  return () => lifecycle.abort();
}
