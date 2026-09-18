#!/usr/bin/env -S npx tsx
import '../lib/node-shims';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from '../lib/procedural-director';
import { parseRecipe } from '../lib/asset-recipe';
import {
  parseSpec,
  specJSONSchema,
  SHAPES,
  RIG_PARTS,
} from '../lib/asset-spec';
import {
  writeAsset,
  inspectGLB,
  FORMATS,
  type Format,
} from '../node/write-asset';
import { auditModel } from '../lib/asset-audit';
import { buildSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { flatten } from '../lib/spec-edit';
import { EXAMPLE_SPEC, SPEC_GUIDE } from './spec-guide';

/**
 * Oddlings Studio as an MCP server.
 *
 * Two ways in: pick a blueprint and vary it, or author a spec from scratch.
 * Everything is deterministic local code — no model calls, no network, no
 * generated media. Tools write real files and report what landed on disk so a
 * calling agent can iterate against measurements instead of guesses.
 */

const OUT_DIR_DEFAULT = './assets';

const formatSchema = z
  .array(z.enum(FORMATS))
  .optional()
  .describe(
    `Output formats. glb = rigged mesh with animation clips, obj = static mesh + mtl, unity = zip of both plus import notes, json = the editable recipe or spec. Default: ["glb","json"].`,
  );

const outDirSchema = z
  .string()
  .optional()
  .describe(
    `Directory to write into, relative to the working directory. Default: ${OUT_DIR_DEFAULT}`,
  );

function formatsOf(input: Format[] | undefined): Format[] {
  return input?.length ? input : ['glb', 'json'];
}

function ok(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function problem(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

const server = new McpServer(
  { name: 'oddlings-studio', version: '1.0.0' },
  {
    instructions:
      'Procedural 3D game assets generated entirely from local code. Use list_blueprints + generate_from_blueprint for fast variations on built-in creature, person, prop and environment generators. Use get_spec_guide + build_from_spec to author an asset from scratch out of primitives, transforms, repeats and rig bindings. Add a `surface` block to a spec and those primitives are blended into one continuous manifold polygon mesh instead of being exported as separate stacked solids — use it for creatures, characters and anything that has to deform. Rigged characters export with a 14-bone skeleton and Idle, Walk, Jump, Wave and Attack clips. Every build returns an `audit` of the geometry it produced: when `audit.ok` is false the model has a real defect — parts hanging in mid-air, a model in separate pieces, a body bound to the head bone. Read the findings, fix the spec and build again rather than shipping it. Use audit_spec to iterate without writing files.',
  },
);

server.registerTool(
  'list_blueprints',
  {
    title: 'List blueprints',
    description:
      'List the built-in procedural generators, each with the asset kind it produces. Start here when the caller wants a creature, villager, tree, rock, hut or environment without authoring geometry by hand.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () =>
    ok(
      (Object.keys(blueprints) as Blueprint[]).map((key) => ({
        blueprint: key,
        kind: blueprints[key].kind,
        label: blueprints[key].label,
        description: blueprints[key].description,
      })),
    ),
);

server.registerTool(
  'generate_from_blueprint',
  {
    title: 'Generate from blueprint',
    description:
      'Build a complete game asset from a named blueprint and an integer seed, then write it to disk. The same blueprint and seed always produce byte-identical geometry. Returns the editable recipe plus triangle, mesh, material and bone counts.',
    inputSchema: {
      blueprint: z
        .enum(Object.keys(blueprints) as [Blueprint, ...Blueprint[]])
        .describe('Blueprint name from list_blueprints.'),
      seed: z
        .number()
        .int()
        .min(0)
        .max(2147483647)
        .describe('Seed. Reuse a seed to reproduce an asset exactly.'),
      name: z.string().max(60).optional().describe('Override the asset name.'),
      outDir: outDirSchema,
      formats: formatSchema,
    },
  },
  async ({ blueprint, seed, name, outDir, formats }) => {
    try {
      const recipe = generateBlueprint(blueprint, seed);
      if (name) recipe.name = name;
      const result = await writeAsset(
        { recipe },
        { outDir: outDir ?? OUT_DIR_DEFAULT, formats: formatsOf(formats) },
      );
      return ok({ ...result, recipe });
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'mutate_recipe',
  {
    title: 'Mutate a recipe',
    description:
      'Produce a deterministic variation of an existing recipe: same silhouette family, shifted proportions, counts and palette. Use this to generate a set of siblings from one approved asset.',
    inputSchema: {
      recipe: z
        .record(z.string(), z.unknown())
        .describe('A recipe object returned by a previous call.'),
      seed: z.number().int().min(0).max(2147483647),
      strength: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe('How far to drift from the source. Default 0.45.'),
      outDir: outDirSchema,
      formats: formatSchema,
    },
  },
  async ({ recipe, seed, strength, outDir, formats }) => {
    try {
      const next = mutateRecipe(parseRecipe(recipe), seed, strength ?? 0.45);
      const result = await writeAsset(
        { recipe: next },
        { outDir: outDir ?? OUT_DIR_DEFAULT, formats: formatsOf(formats) },
      );
      return ok({ ...result, recipe: next });
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'get_spec_guide',
  {
    title: 'Asset spec guide',
    description:
      'Return the authoring guide, the full JSON Schema, the available primitive shapes and rig bones, and a worked example spec. Read this before calling build_from_spec for the first time.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () =>
    ok({
      guide: SPEC_GUIDE,
      shapes: SHAPES,
      rigParts: RIG_PARTS,
      example: EXAMPLE_SPEC,
      schema: specJSONSchema(),
    }),
);

server.registerTool(
  'build_from_spec',
  {
    title: 'Build from spec',
    description:
      'Build an asset the blueprints do not cover, from a spec you author: a tree of primitives with transforms, colors, seeded jitter, mirrors, repeats and optional rig bindings. Supply a rig block to get a skinned 14-bone character with the standard clips; omit it for a static mesh. Supply a `surface` block to fuse the primitives into one continuous polygon mesh with vertex colours and per-vertex skin weights, which is what a creature or character should ship as. Call get_spec_guide first. The result carries an `audit`; if `audit.ok` is false, correct the spec and build again.',
    inputSchema: {
      spec: z
        .record(z.string(), z.unknown())
        .describe('An asset spec object. See get_spec_guide for the schema.'),
      outDir: outDirSchema,
      formats: formatSchema,
    },
  },
  async ({ spec, outDir, formats }) => {
    try {
      const parsed = parseSpec(spec);
      const result = await writeAsset(
        { spec: parsed },
        { outDir: outDir ?? OUT_DIR_DEFAULT, formats: formatsOf(formats) },
      );
      return ok({ ...result, spec: parsed });
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'audit_spec',
  {
    title: 'Check a spec',
    description:
      'Build a spec in memory and report its geometry problems without writing any files: parts left hanging in mid-air, a model that falls into separate pieces, geometry that would bind to the wrong bone, and the silhouette from each axis. Use this to iterate on a spec cheaply before committing it to disk.',
    inputSchema: {
      spec: z
        .record(z.string(), z.unknown())
        .describe('An asset spec object. See get_spec_guide for the schema.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ spec }) => {
    try {
      const parsed = parseSpec(spec);
      return ok(
        auditModel(buildSpec(parsed), {
          rigged: Boolean(parsed.rig),
          scale: parsed.scale,
          labels: new Map(
            flatten(parsed).map((row) => [
              row.path.join('.'),
              row.part.name ?? row.part.shape,
            ]),
          ),
        }),
      );
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'inspect_asset',
  {
    title: 'Inspect a GLB',
    description:
      'Load a written .glb back off disk and report its triangle, mesh and material counts, bone names and animation clips. Use this to verify an export before handing it to an engine.',
    inputSchema: {
      path: z.string().describe('Path to a .glb file.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => {
    try {
      return ok(await inspectGLB(path));
    } catch (error) {
      return problem(error);
    }
  },
);

await readySurface();
await server.connect(new StdioServerTransport());
