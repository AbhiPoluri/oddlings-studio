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
import { auditModel, type Audit, type Hint } from '../lib/asset-audit';
import { withClipFindings } from '../lib/asset-audit-clips';
import { buildSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { markActive } from '../node/active-spec';
import { flatten } from '../lib/spec-edit';
import { measureSpec, type SpecMeasure } from '../lib/asset-measure';
import {
  describeMark,
  loadNotes,
  openNotes,
  resolveNote,
  reviewPathFor,
  saveNotes,
} from '../lib/review-notes';
import { specTemplate, TEMPLATE_KINDS, type TemplateKind } from '../mcp/spec-guide';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileName } from '../lib/asset-recipe';
import { renderPngs, VIEWS, type ViewName } from '../lib/asset-render';

const USAGE = `oddlings — procedural game assets from code

  blueprints                        List built-in generators
  generate <blueprint> [options]    Build an asset from a blueprint + seed
  mutate <recipe.json> [options]    Vary an existing recipe
  new <${TEMPLATE_KINDS.join('|')}>
                                    Print a starter spec that already audits clean
  build <spec.json> [options]       Build an asset authored from scratch
  render <spec.json> [options]      Write PNGs of the model, no browser needed
  audit <spec.json> [--visual]      Check geometry without writing anything
  measure <spec.json> [--parts a,b] Boxes, gaps to neighbours and the skeleton
  notes <spec.json>                 Read and close a reviewer's notes
  schema [spec|shapes]              Print the spec JSON Schema or shape list
  inspect <file.glb>                Report bones, clips and triangles of a GLB

Options
  --seed <int>        Generation seed (default: random)
  --strength <0-1>    Mutation strength (default: 0.45)
  --out <dir>         Output directory (default: ./assets)
  --format <list>     Comma-separated: ${FORMATS.join(', ')} (default: glb,json)
  --name <text>       Override the asset name
  --parts <list>      measure: comma-separated part names (default: all)
  --resolve <id>      notes: close this note
  --reply <text>      notes: what you did about it
  --size <px>         render: frame edge in pixels (default: 512)
  --views <list>      render: ${VIEWS.join(', ')}
  --visual            audit: also report what the model looks like
  --json              Print machine-readable output only
  --strict            Exit non-zero when the geometry audit reports an error

Examples
  oddlings new creature --name Bogwright > ./specs/bogwright.spec.json
  oddlings generate guardian --seed 7 --out ./Assets/Creatures --format glb,unity
  oddlings build ./specs/lantern-keeper.json --out ./Assets --format glb,obj
  oddlings build ./specs/kaiju-surface.spec.json --out ./Assets   # one fused mesh
  oddlings measure ./specs/wizard.spec.json --parts hat,staff
  oddlings render ./specs/wizard.spec.json --out ./shots --views front,side
  oddlings audit ./specs/wizard.spec.json --visual
  oddlings notes ./specs/wizard.spec.json --resolve n1a --reply "widened the brim"
`;

type Options = {
  seed?: number;
  strength: number;
  out: string;
  formats: Format[];
  name?: string;
  parts?: string[];
  resolve?: string;
  reply?: string;
  size: number;
  views?: ViewName[];
  visual: boolean;
  json: boolean;
  strict: boolean;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    strength: 0.45,
    out: './assets',
    formats: ['glb', 'json'],
    size: 512,
    visual: false,
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
      case '--parts':
        if (!value) fail('--parts needs a comma-separated list of part names.');
        options.parts = value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        i++;
        break;
      case '--resolve':
        if (!value) fail('--resolve needs a note id.');
        options.resolve = value;
        i++;
        break;
      case '--reply':
        if (!value) fail('--reply needs text.');
        options.reply = value;
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
      case '--size':
        options.size = Number(value);
        if (!Number.isInteger(options.size) || options.size < 16 || options.size > 2048)
          fail('--size needs a whole number of pixels between 16 and 2048.');
        i++;
        break;
      case '--views': {
        if (!value) fail('--views needs a comma-separated list.');
        const wanted = value.split(',').map((v) => v.trim()).filter(Boolean);
        const bad = wanted.filter((v) => !VIEWS.includes(v as ViewName));
        if (bad.length)
          fail(`Unknown view: ${bad.join(', ')}. Pick from ${VIEWS.join(', ')}.`);
        options.views = wanted as ViewName[];
        i++;
        break;
      }
      case '--visual':
        options.visual = true;
        break;
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

/**
 * A fix hint as a sentence.
 *
 * The numbers are already rounded to four decimals, so plain String() prints
 * them the way they were computed rather than padding 0.03 out to 0.0300.
 */
function hintWords(hint: Hint, gap?: number) {
  if (hint.move)
    return `move by [${hint.move.join(', ')}]${hint.toward ? ` toward ${hint.toward}` : ''}`;
  if (hint.grow !== undefined)
    return `raise surface.blend to ${hint.grow}${hint.toward ? ` to fuse with ${hint.toward}` : ''}${gap === undefined ? '' : ` (gap ${gap})`}`;
  return hint.toward ? `nearest part: ${hint.toward}` : '';
}

function printAudit(audit: Audit) {
  for (const finding of audit.findings) {
    console.log(`  ${MARK[finding.severity]} ${finding.message}`);
    const words = finding.hint
      ? hintWords(finding.hint, finding.threshold)
      : '';
    if (words) console.log(`      → ${words}`);
  }
}

/** Errors and warnings, for the build history. */
function tally(audit: Audit) {
  return {
    ok: audit.ok,
    errors: audit.findings.filter((f) => f.severity === 'error').length,
    warnings: audit.findings.filter((f) => f.severity === 'warn').length,
  };
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

/**
 * The one line that stops a reviewer's note going unread.
 *
 * It rides on `audit`, which is the command an agent runs dozens of times, so
 * a note left in the studio reaches the agent within one iteration instead of
 * waiting for someone to think of looking.
 */
async function printNotes(
  specPath: string,
  preloaded?: Awaited<ReturnType<typeof loadNotes>>,
) {
  const notes = preloaded ?? (await loadNotes(specPath));
  const open = openNotes(notes);
  if (!open.length) return;
  console.log(
    `  ${open.length} open review note${open.length === 1 ? '' : 's'} — run \`oddlings notes ${specPath}\``,
  );
}

function printNoteList(
  specPath: string,
  notes: Awaited<ReturnType<typeof loadNotes>>,
) {
  const open = openNotes(notes);
  if (!open.length) {
    console.log(
      `No open notes in ${reviewPathFor(specPath)} (${notes.notes.length} resolved).`,
    );
    return;
  }
  console.log(`${open.length} open · ${reviewPathFor(specPath)}`);
  for (const note of open) {
    const where = note.partName ?? (note.part ? note.part.join('.') : 'whole asset');
    console.log(`  ${note.id.padEnd(14)} ${where.padEnd(18)} ${note.text}`);
    // Drawn rather than typed: the shape is the other half of what was said,
    // and the full geometry is in the file for anything that wants it. Only
    // when it adds something — an unlabelled mark already uses this sentence
    // as its text, and printing it twice says nothing twice.
    const shape = note.mark ? describeMark(note.mark) : null;
    if (shape && shape !== note.text)
      console.log(`  ${''.padEnd(14)} ${''.padEnd(18)} ↳ ${shape}`);
  }
  console.log(
    `  Close one with: oddlings notes ${specPath} --resolve <id> --reply "what you changed"`,
  );
}

/**
 * Precision that suits the asset.
 *
 * A 6 m cottage printed to three decimals is a wall of noise; a 6 cm bolt
 * printed to two is a column of zeroes. One asset, one precision, chosen from
 * how big the thing actually is.
 */
function digitsFor(report: SpecMeasure) {
  return Math.max(...report.bounds.size) < 2 ? 3 : 2;
}

/** Fixed-point, without the `-0.00` that a rounded-away negative leaves. */
function fixed(n: number, digits: number) {
  const text = n.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

function triple(v: [number, number, number], digits: number) {
  return v.map((n) => fixed(n, digits)).join(' ');
}

function printMeasure(report: SpecMeasure) {
  const d = digitsFor(report);
  console.log(
    `${report.name} — ${report.mode} · ${report.parts.length} parts · ${report.meshes} meshes · ${report.triangles.toLocaleString()} tris · ${triple(report.bounds.size, d)} m${report.scale === 1 ? '' : ` · scale ${report.scale}`}`,
  );
  const width = d === 3 ? 20 : 17;
  console.log(
    `  ${'part'.padEnd(22)}${'cp'.padStart(3)}  ${'size'.padEnd(width)}${'centre'.padEnd(width)}${'surf'.padStart(6)}  ${'nearest'.padEnd(18)}${'gap'.padStart(8)}`,
  );
  for (const part of report.parts) {
    // Indented by depth, so a child reads as a child rather than as another
    // top-level part that happens to sit inside one.
    const label = `${'  '.repeat(part.depth)}${part.name}`.slice(0, 22);
    const surface = part.surfaceVertices === null
      ? '—'
      : part.surfaceVertices || 'none';
    console.log(
      `  ${label.padEnd(22)}${String(part.copies).padStart(3)}  ` +
        `${triple(part.bounds.size, d).padEnd(width)}${triple(part.bounds.centre, d).padEnd(width)}` +
        `${String(surface).padStart(6)}  ` +
        `${(part.nearest?.name ?? '—').slice(0, 17).padEnd(18)}` +
        `${(part.nearest ? signed(part.nearest.gap) : '').padStart(8)}`,
    );
  }
  if (report.skeleton.length) {
    console.log(`  skeleton — ${report.skeleton.length} bones`);
    for (const bone of report.skeleton)
      console.log(
        `  ${bone.name.padEnd(16)}${(bone.parent ?? '—').padEnd(16)}${triple(bone.at, 3).padEnd(20)}${String(bone.vertices).padStart(7)} verts`,
      );
  }
  console.log(
    `  ${report.sampling.meshSamples} samples per mesh · ${report.sampling.measuredParts} parts measured for gaps · ${report.sampling.ms} ms`,
  );
}

/** A gap reads wrong without its sign: -0.02 is contact, 0.02 is a hole. */
function signed(n: number) {
  return `${n > 0 ? '+' : ''}${n.toFixed(3)}`;
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
    case 'new': {
      const kind = positional[0] as TemplateKind;
      if (!kind || !TEMPLATE_KINDS.includes(kind))
        fail(`Pass one of: ${TEMPLATE_KINDS.join(', ')}.`);
      return console.log(
        JSON.stringify(specTemplate(kind, options.name), null, 2),
      );
    }
    case 'build': {
      if (!positional[0]) fail('Pass a spec JSON file to build.');
      const spec = parseSpec(await readJSON(positional[0]));
      if (options.name) spec.name = options.name;
      const built = await writeAsset(
        { spec },
        {
          outDir: options.out,
          formats: options.formats,
          // The authored file, not the copy written beside the model: the
          // build history is only useful if it points at what to edit.
          source: positional[0],
        },
      );
      report(built, { ...options, strict: false });
      if (!options.json) await printNotes(positional[0]);
      if (options.strict && !built.audit.ok) process.exit(1);
      return;
    }
    case 'render': {
      if (!positional[0]) fail('Pass a spec JSON file to render.');
      const spec = parseSpec(await readJSON(positional[0]));
      const model = buildSpec(spec);
      const rendered = renderPngs(model, {
        size: options.size,
        ...(options.views ? { views: options.views } : {}),
      });
      const base = fileName(options.name ?? spec.name);
      await mkdir(resolve(options.out), { recursive: true });
      const files: { view: string; file: string; fill: number }[] = [];
      for (const image of rendered.images) {
        const file = join(resolve(options.out), `${base}-${image.view}.png`);
        await writeFile(file, image.png);
        files.push({ view: image.view, file, fill: Number(image.fill.toFixed(3)) });
      }
      if (options.json)
        return console.log(
          JSON.stringify(
            {
              name: spec.name,
              size: options.size,
              triangles: rendered.triangles,
              ms: rendered.ms,
              views: files,
            },
            null,
            2,
          ),
        );
      console.log(
        `${spec.name} — ${rendered.triangles.toLocaleString()} tris · ${files.length} views at ${options.size}px · ${rendered.ms} ms`,
      );
      for (const file of files)
        console.log(
          `  → ${file.file}  (${file.view}, silhouette ${(file.fill * 100).toFixed(0)}% of frame)`,
        );
      return;
    }
    case 'audit': {
      if (!positional[0]) fail('Pass a spec JSON file to audit.');
      const spec = parseSpec(await readJSON(positional[0]));
      const model = buildSpec(spec);
      const audit = withClipFindings(auditModel(model, {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        visual: options.visual,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      }), spec);
      const { triangles, meshes, bones } = stats(model);
      // Auditing is the tightest iteration loop there is, so it is the most
      // useful place to keep the studio's preview in step, and the most
      // honest place to record what the geometry looked like at the time.
      await markActive(spec.name, spec, positional[0], {
        tris: triangles,
        meshes,
        bones,
        ...tally(audit),
        source: positional[0],
      });
      const notes = await loadNotes(positional[0]);
      if (options.json)
        // The audit object itself is untouched — a caller that reads
        // `findings` keeps working, and the notes ride alongside.
        console.log(
          JSON.stringify(
            { ...audit, reviewNotes: openNotes(notes) },
            null,
            2,
          ),
        );
      else {
        console.log(`${spec.name}: ${audit.ok ? 'passes' : 'has problems'}`);
        console.log(
          `  ${triangles.toLocaleString()} tris · ${meshes} meshes${bones ? ` · ${bones} bones` : ''}`,
        );
        printAudit(audit);
        await printNotes(positional[0], notes);
      }
      if (!audit.ok) process.exit(1);
      return;
    }
    case 'measure': {
      if (!positional[0]) fail('Pass a spec JSON file to measure.');
      const report = measureSpec(await readJSON(positional[0]), {
        parts: options.parts,
      });
      if (options.json) return console.log(JSON.stringify(report, null, 2));
      return printMeasure(report);
    }
    case 'notes': {
      if (!positional[0]) fail('Pass a spec JSON file.');
      const path = positional[0];
      let notes = await loadNotes(path);
      if (options.resolve) {
        notes = resolveNote(notes, options.resolve, options.reply);
        await saveNotes(path, notes);
        if (!options.json)
          console.log(
            `Resolved ${options.resolve} in ${reviewPathFor(path)}${
              options.reply ? '' : ' — no reply given, which the reviewer reads as silence.'
            }`,
          );
      }
      if (options.json) return console.log(JSON.stringify(notes, null, 2));
      return printNoteList(path, notes);
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
