import { parseRecipe, type Recipe } from './asset-recipe';
export function registerStudioTools(
  read: () => Recipe,
  update: (r: Recipe) => void,
) {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools = [
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
      name: 'direct_asset_with_ai',
      description:
        'Create a new procedural game asset or refine the current one from a natural-language instruction using Jev. Updates the visible editable recipe as one undoable step; does not save or export.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['create', 'refine'] },
          instruction: { type: 'string', minLength: 3, maxLength: 600 },
        },
        required: ['mode', 'instruction'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(input: unknown) {
        if (
          !input ||
          typeof input !== 'object' ||
          Object.keys(input).length !== 2 ||
          !('mode' in input) ||
          !('instruction' in input) ||
          !['create', 'refine'].includes(String(input.mode)) ||
          typeof input.instruction !== 'string' ||
          input.instruction.trim().length < 3 ||
          input.instruction.length > 600
        )
          throw Error('Expected a create or refine mode and a 3–600 character instruction.');
        const response = await fetch('/api/assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: input.mode,
            prompt: input.instruction.trim(),
            recipe: read(),
          }),
        });
        const data = (await response.json()) as {
          recipe?: unknown;
          confidence?: number;
          model?: string;
          error?: string;
        };
        if (!response.ok || !data.recipe)
          throw Error(data.error || 'The AI asset director could not finish.');
        const recipe = parseRecipe(data.recipe);
        update(recipe);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return {
          recipe: read(),
          model: data.model ?? 'jev',
          confidence: data.confidence ?? 0,
        };
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
