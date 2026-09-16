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
  ];
  for (const tool of tools)
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  return () => lifecycle.abort();
}
