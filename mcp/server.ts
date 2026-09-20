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
import { measureSpec } from '../lib/asset-measure';
import {
  loadNotes,
  openNotes,
  resolveNote,
  reviewPathFor,
  saveNotes,
} from '../lib/review-notes';
import {
  EXAMPLE_SPEC,
  SPEC_GUIDE,
  specTemplate,
  TEMPLATE_KINDS,
  type TemplateKind,
} from './spec-guide';

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
      'Procedural 3D game assets generated entirely from local code. Use list_blueprints + generate_from_blueprint for fast variations on built-in creature, person, prop and environment generators. Use get_spec_guide + build_from_spec to author an asset from scratch out of primitives, transforms, repeats and rig bindings. Add a `surface` block to a spec and those primitives are blended into one continuous manifold polygon mesh instead of being exported as separate stacked solids — use it for creatures, characters and anything that has to deform. Rigged characters export with a 14-bone skeleton and Idle, Walk, Jump, Wave and Attack clips. Every build returns an `audit` of the geometry it produced: when `audit.ok` is false the model has a real defect — parts hanging in mid-air, a model in separate pieces, a body bound to the head bone. Read the findings, fix the spec and build again rather than shipping it. Use audit_spec to iterate without writing files. Findings carry a `hint` with the fix as numbers — a translation to add to the position of the part, and the part it should move toward — so apply that rather than guessing a direction. Start from spec_template rather than a blank page. Use measure_spec instead of writing a script to find a bounding box, a gap between two parts, or which bone owns what. And read review_notes for the comments a human reviewer left before calling an asset finished, then close each one with resolve_note and a reply.',
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
      templates: TEMPLATE_KINDS,
      schema: specJSONSchema(),
    }),
);

server.registerTool(
  'spec_template',
  {
    title: 'Starter spec',
    description:
      'Return a complete, working starter spec for one kind of asset: creature, person, prop, mechanism or environment. Each one already follows the conventions that are easy to get wrong from a blank page — it faces +z, it stands on the ground with every part touching, parts are named, characters pin their own bones and carry a surface block, and the mechanism shows a two-joint chain sharing one clip with a phase lag. Every template passes audit_spec as returned, so it is a safe base to edit rather than a sketch to correct. Edit the geometry, keep the structure, and audit after each change. "mechanism" is a prop with a joints block; the spec itself has four kinds, not five.',
    inputSchema: {
      kind: z
        .enum(TEMPLATE_KINDS as unknown as [TemplateKind, ...TemplateKind[]])
        .describe('Which starter to return.'),
      name: z.string().max(60).optional().describe('Name the asset.'),
    },
    annotations: { readOnlyHint: true },
  },
  ({ kind, name }) => {
    try {
      return ok(specTemplate(kind, name));
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'measure_spec',
  {
    title: 'Measure a spec',
    description:
      'Measure an asset spec (the spec OBJECT, as audit_spec takes it) and return the numbers you would otherwise write a throwaway script for. Per authored part: its world bounding box after scale, how many meshes it expands into, the bone or joint carrying it, how many vertices of the fused surface it owns in surface mode — zero being the no-surface defect — and, for the parts you name, the nearest OTHER part with the signed gap to it. A positive gap is clear air between the two surfaces; a negative gap is how deep they interpenetrate; zero is contact. Gaps are exact point-to-triangle distances between the authored primitives, so they are right for spheres, limbs and lathes, not only for boxes. It also returns the skeleton, with the position of every bone and the number of vertices weighted to it, which is how you confirm a leg is bound to a leg. Nothing is written. Name two or three parts to keep it cheap once you know which corner of the model you are working on.',
    inputSchema: {
      spec: z
        .record(z.string(), z.unknown())
        .describe('An asset spec object. See get_spec_guide for the schema.'),
      parts: z
        .array(z.string())
        .optional()
        .describe(
          'Part names to compute the nearest neighbour and gap for. Default: every part. An unknown name is an error, listing the names that exist.',
        ),
      surface: z
        .boolean()
        .optional()
        .describe(
          'Run the surface build, which is the expensive half. Default true when the spec declares one; false drops the surface-vertex counts and returns in milliseconds.',
        ),
    },
    annotations: { readOnlyHint: true },
  },
  ({ spec, parts, surface }) => {
    try {
      return ok(measureSpec(spec, { parts, surface }));
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'review_notes',
  {
    title: 'Read review notes',
    description:
      'Read the notes a human reviewer left on an asset. Takes a spec FILE PATH (not a spec object): the notes live beside it, so specs/foo.spec.json has specs/foo.review.json. Each note names the part it is about, says what is wrong, and is either open or resolved. This is the only channel a reviewer has into your work — an asset that audits clean can still be wrong in every way a number cannot see, and the note is where that gets said. Read the open notes before you decide an asset is finished, fix what they ask for, and close each one with resolve_note and a reply saying what you changed. A spec with no review file simply has no notes, which is not an error. ' +
      'A note may also carry a `mark`: a stroke the reviewer drew straight onto the model in the studio, resolved into geometry at the moment they drew it. `mark.gesture` says what the stroke was — `circle` rings the parts it encloses, `remove` is a scribble or a cross over something that should go, `arrow` points at the part its tip landed on, and `sketch` is a shape drawn in empty space for something that is not there yet. `mark.parts` lists those parts as spec paths with the names they had, so act on the paths rather than re-deriving them. `mark.worldPoints` is the stroke itself in world metres — on the model surface for a circle, a remove or an arrow, and on a plane facing the camera for a sketch — so the last point of an arrow is what it points at, the extent of a sketch is the size of the thing being asked for, and the centre of a circle is where it was aimed. `mark.cameraPose` is where the reviewer was standing (position, target, fov), which is what tells you which side of the model they were looking at. The note\'s own `text` still says what to do; the mark says where.',
    inputSchema: {
      spec: z
        .string()
        .describe('Path to the spec file, e.g. ./specs/wizard.spec.json.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ spec }) => {
    try {
      const notes = await loadNotes(spec);
      return ok({
        file: reviewPathFor(spec),
        open: openNotes(notes),
        all: notes.notes,
      });
    } catch (error) {
      return problem(error);
    }
  },
);

server.registerTool(
  'resolve_note',
  {
    title: 'Close a review note',
    description:
      'Mark one review note as resolved and write the reply that goes back to the reviewer. Takes the spec FILE PATH, the note id from review_notes, and the reply. Close a note only after the change is actually in the spec and the asset still audits clean — a note closed on an unbuilt intention is worse than one left open, because the reviewer stops watching for it. The reply is what the reviewer reads: say what you changed, in one line, not that you agree. An unknown id is refused rather than ignored.',
    inputSchema: {
      spec: z.string().describe('Path to the spec file the notes belong to.'),
      id: z.string().describe('Note id, from review_notes.'),
      reply: z
        .string()
        .optional()
        .describe('What you changed. Leave it out and the reviewer sees silence.'),
    },
  },
  async ({ spec, id, reply }) => {
    try {
      const notes = resolveNote(await loadNotes(spec), id, reply);
      await saveNotes(spec, notes);
      return ok({
        file: reviewPathFor(spec),
        resolved: notes.notes.find((note) => note.id === id),
        stillOpen: openNotes(notes).length,
      });
    } catch (error) {
      return problem(error);
    }
  },
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
      specPath: z
        .string()
        .optional()
        .describe(
          'The file you are authoring this spec in, if it has one. It is recorded in the build history so the studio can show which source a build came from; without it the history points at the copy written beside the model.',
        ),
      outDir: outDirSchema,
      formats: formatSchema,
    },
  },
  async ({ spec, specPath, outDir, formats }) => {
    try {
      const parsed = parseSpec(spec);
      const result = await writeAsset(
        { spec: parsed },
        {
          outDir: outDir ?? OUT_DIR_DEFAULT,
          formats: formatsOf(formats),
          source: specPath,
        },
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
