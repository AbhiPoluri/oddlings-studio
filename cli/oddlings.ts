#!/usr/bin/env -S npx tsx
import '../lib/node-shims';
import { stats } from '../lib/asset-build';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  blueprints,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from '../lib/procedural-director';
import { parseRecipe } from '../lib/asset-recipe';
import { parseSpec, specJSONSchema, SHAPES, RIG_PARTS } from '../lib/asset-spec';
import { writeAsset, inspectGLB, FORMATS, type Format } from '../node/write-asset';
import { auditModel, type Audit } from '../lib/asset-audit';
import { buildSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { markActive } from '../node/active-spec';
import { flatten } from '../lib/spec-edit';

const USAGE = `oddlings — procedural game assets from code

  blueprints                        List built-in generators
  generate <blueprint> [options]    Build an asset from a blueprint + seed
  mutate <recipe.json> [options]    Vary an existing recipe
  build <spec.json> [options]       Build an asset authored from scratch
  audit <spec.json>                 Check geometry without writing anything
  schema [spec|shapes]              Print the spec JSON Schema or shape list
  inspect <file.glb>                Report bones, clips and triangles of a GLB

Options
  --seed <int>        Generation seed (default: random)
  --strength <0-1>    Mutation strength (default: 0.45)
  --out <dir>         Output directory (default: ./assets)
  --format <list>     Comma-separated: ${FORMATS.join(', ')} (default: glb,json)
  --name <text>       Override the asset name
  --json              Print machine-readable output only
  --strict            Exit non-zero when the geometry audit reports an error

Examples
  oddlings generate guardian --seed 7 --out ./Assets/Creatures --format glb,unity
  oddlings build ./specs/lantern-keeper.json --out ./Assets --format glb,obj
  oddlings build ./specs/kaiju-surface.spec.json --out ./Assets   # one fused mesh
`;

type Options = {
  seed?: number;
  strength: number;
  out: string;
  formats: Format[];
  name?: string;
  json: boolean;
  strict: boolean;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    strength: 0.45,
    out: './assets',
    formats: ['glb', 'json'],
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--seed':
        options.seed = Number(value);
        if (!Number.isInteger(options.seed) || options.seed < 0)
          fail('--seed needs a non-negative integer.');
        i++;
        break;
      case '--strength':
        options.strength = Number(value);
        if (!(options.strength >= 0.05 && options.strength <= 1))
          fail('--strength must be between 0.05 and 1.');
        i++;
        break;
      case '--out':
        if (!value) fail('--out needs a directory.');
        options.out = value;
        i++;
        break;
      case '--name':
        if (!value) fail('--name needs text.');
        options.name = value;
        i++;
        break;
      case '--format': {
        if (!value) fail('--format needs a comma-separated list.');
        const requested = value.split(',').map((f) => f.trim().toLowerCase());
        const bad = requested.filter((f) => !FORMATS.includes(f as Format));
        if (bad.length) fail(`Unknown format: ${bad.join(', ')}`);
        options.formats = requested as Format[];
        i++;
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      default:
        if (flag.startsWith('--')) fail(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

async function readJSON(path: string) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    fail(
      `Could not read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

const MARK: Record<string, string> = { error: '✗', warn: '!', info: '·' };

function printAudit(audit: Audit) {
  for (const finding of audit.findings)
    console.log(`  ${MARK[finding.severity]} ${finding.message}`);
}

function report(
  result: Awaited<ReturnType<typeof writeAsset>>,
  options: Options,
) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { triangles, meshes, materials, bones, size } = result.stats;
    console.log(`${result.name}`);
    console.log(
      `  ${triangles.toLocaleString()} tris · ${meshes} meshes · ${materials} materials${bones ? ` · ${bones} bones` : ''}`,
    );
    console.log(`  ${size.map((n) => n.toFixed(2)).join(' × ')} m`);
    for (const file of result.files) console.log(`  → ${file}`);
    printAudit(result.audit);
  }
  if (options.strict && !result.audit.ok) process.exit(1);
}

async function main() {
  await readySurface();
  const [command, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith('--'));
  const options = parseOptions(rest);

  switch (command) {
    case 'blueprints': {
      const rows = (Object.keys(blueprints) as Blueprint[]).map((key) => ({
        blueprint: key,
        kind: blueprints[key].kind,
        label: blueprints[key].label,
        description: blueprints[key].description,
      }));
      if (options.json) return console.log(JSON.stringify(rows, null, 2));
      for (const row of rows)
        console.log(
          `${row.blueprint.padEnd(11)} ${row.kind.padEnd(12)} ${row.description}`,
        );
      return;
    }
    case 'generate': {
      const blueprint = positional[0] as Blueprint;
      if (!blueprint || !(blueprint in blueprints))
        fail(
          `Unknown blueprint. Run "oddlings blueprints" for the list of ${Object.keys(blueprints).length}.`,
        );
      const recipe = generateBlueprint(blueprint, options.seed ?? randomSeed());
      if (options.name) recipe.name = options.name;
      return report(
        await writeAsset(
          { recipe },
          { outDir: options.out, formats: options.formats },
        ),
        options,
      );
    }
    case 'mutate': {
      if (!positional[0]) fail('Pass a recipe JSON file to mutate.');
      const recipe = parseRecipe(await readJSON(positional[0]));
      const next = mutateRecipe(
        recipe,
        options.seed ?? randomSeed(),
        options.strength,
      );
      if (options.name) next.name = options.name;
      return report(
        await writeAsset(
          { recipe: next },
          { outDir: options.out, formats: options.formats },
        ),
        options,
      );
    }
    case 'build': {
      if (!positional[0]) fail('Pass a spec JSON file to build.');
      const spec = parseSpec(await readJSON(positional[0]));
      if (options.name) spec.name = options.name;
      return report(
        await writeAsset(
          { spec },
          { outDir: options.out, formats: options.formats },
        ),
        options,
      );
    }
    case 'audit': {
      if (!positional[0]) fail('Pass a spec JSON file to audit.');
      const spec = parseSpec(await readJSON(positional[0]));
      const model = buildSpec(spec);
      const audit = auditModel(model, {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      });
      // Auditing is the tightest iteration loop there is, so it is the most
      // useful place to keep the studio's preview in step.
      await markActive(spec.name, spec, positional[0]);
      if (options.json) console.log(JSON.stringify(audit, null, 2));
      else {
        console.log(`${spec.name}: ${audit.ok ? 'passes' : 'has problems'}`);
        const { triangles, meshes, bones } = stats(model);
        console.log(
          `  ${triangles.toLocaleString()} tris · ${meshes} meshes${bones ? ` · ${bones} bones` : ''}`,
        );
        printAudit(audit);
      }
      if (!audit.ok) process.exit(1);
      return;
    }
    case 'schema': {
      if (positional[0] === 'shapes')
        return console.log(
          JSON.stringify({ shapes: SHAPES, rigParts: RIG_PARTS }, null, 2),
        );
      return console.log(JSON.stringify(specJSONSchema(), null, 2));
    }
    case 'inspect': {
      if (!positional[0]) fail('Pass a .glb file to inspect.');
      return console.log(
        JSON.stringify(await inspectGLB(positional[0]), null, 2),
      );
    }
    default:
      console.log(USAGE);
      if (command) process.exit(1);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
