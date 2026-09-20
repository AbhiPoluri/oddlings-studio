import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { z } from 'zod';
import { BUILD_LOG, markActive } from './active-spec';
import { MAX_POINTS, type Mark } from '../lib/draw-marks';

/**
 * The studio's dev-server API: save-back, and reading the specs folder.
 *
 * Save-back is the half of the review loop the follow feature could not close.
 * The follow feature makes the studio show what an agent just built, so a person
 * can see a floating part — but until this endpoint their fix lived only in the
 * browser tab, and the agent's next iteration started from the file it had
 * written rather than from the correction. `SAVE_ROUTE` writes the edited spec
 * back to the followed file and re-points the preview at it.
 *
 * The two read routes answer the other half: "what else is there". A person
 * reviewing an agent's work wants the folder, not just whichever file was
 * touched last, and the browser cannot list a directory.
 *
 * Dev-server only, by construction: these are Vite middlewares on the local
 * process, never bundled for the Worker, and they only touch paths inside the
 * project that look like specs.
 */
export const SAVE_ROUTE = '/__oddlings/save';
/** Every `*.spec.json` under `specs/`, as a listing. */
export const SPECS_ROUTE = '/__oddlings/specs';
/** One spec file by path, with an ETag so a poll can skip an unchanged read. */
export const SPEC_ROUTE = '/__oddlings/spec';
/** The review notes beside one spec: `GET ?path=`, and `PUT` to replace them. */
export const NOTES_ROUTE = '/__oddlings/notes';
/** What the CLI has built, from the log it appends to. */
export const BUILDS_ROUTE = '/__oddlings/builds';

/**
 * Where the CLI writes one line per build or audit.
 *
 * Read rather than written here, and named by the module that writes it so the
 * two cannot drift: the studio is this file's only reader and the agent side
 * its only writer, so a half-appended last line is the normal case — which is
 * what `parseBuildsTail` is written to expect.
 */
const BUILDS_FILE = BUILD_LOG;

/** Where the listing looks. Relative to the project, never configurable. */
const SPECS_DIR = 'specs';

/** The same rule the `?spec=` pin uses: a relative JSON path, no escaping. */
const SPEC_PATH = /^[\w./-]+\.json$/;

/** What one row of the listing says about a file, without building it. */
export type SpecRow = {
  /** Project-relative, POSIX separators, so it doubles as a `?spec=` value. */
  path: string;
  name: string;
  kind: string;
  rig: 'none' | 'rig' | 'joints';
  /** Authored parts, children included — not meshes, which need a build. */
  parts: number;
  surface: boolean;
  /** Last write, ISO. The listing is sorted newest first on this. */
  modified: string;
  size: number;
  /** Set when the file did not parse: half-written, or not a spec at all. */
  broken?: boolean;
};

export type SpecListing = { specs: SpecRow[]; at: string };

/**
 * One thing a reviewer said about one part, kept beside the spec it is about.
 *
 * Deliberately a second file rather than a field in the spec: a note is not
 * geometry, and putting it in the spec would mean every note is an edit — the
 * studio would detach from the file it is following, the agent's next build
 * would diff against it, and a reviewer could not ask a question without
 * changing the asset. `specs/foo.spec.json` is answered by
 * `specs/foo.review.json`, which the CLI reads and resolves from the other end.
 */
export type ReviewNote = {
  id: string;
  /** The authored part path this is about, or null for the asset as a whole. */
  part: number[] | null;
  /** What that part was called when the note was written, for a stale path. */
  partName: string | null;
  text: string;
  status: 'open' | 'resolved';
  by: 'human' | 'agent';
  at: string;
  resolvedAt: string | null;
  /** What the agent said when it resolved this. */
  reply: string | null;
  /** The stroke this note was drawn as, for a note made with the Draw tool. */
  mark?: Mark;
};

export type ReviewDoc = { version: 1; spec: string; notes: ReviewNote[] };

/** One line of `.oddlings/builds.jsonl`, as the CLI appends it. */
export type BuildRow = {
  at: string;
  name: string;
  /** The spec that was built, project-relative. */
  source: string;
  tris: number;
  meshes: number;
  bones: number;
  ok: boolean;
  errors: number;
  warnings: number;
};

/**
 * The note schema, loose on purpose.
 *
 * `z.looseObject` rather than `z.object`: the agent side owns this file too,
 * and a strict parse would strip any field it adds on the way through a PUT —
 * so the studio would silently delete the other half of the conversation every
 * time somebody typed a note.
 */
const noteSchema = z.looseObject({
  id: z.string().min(1).max(64),
  part: z.array(z.number().int().min(0)).max(24).nullable(),
  partName: z.string().max(200).nullable(),
  // Non-empty, matching the agent side: a blank note is a note the CLI would
  // refuse to read, and writing one would break the file for both of us.
  text: z.string().min(1).max(4000),
  status: z.enum(['open', 'resolved']),
  by: z.enum(['human', 'agent']),
  at: z.string().min(1).max(64),
  resolvedAt: z.string().max(64).nullable(),
  reply: z.string().max(4000).nullable(),
  // Loose like its parent, and for the same reason: the agent side owns this
  // file too. Only the sizes are enforced here, because a review file is read
  // into an agent's context and an unbounded stroke is how that gets flooded.
  mark: z
    .looseObject({
      gesture: z.enum(['circle', 'remove', 'arrow', 'sketch']),
      parts: z
        .array(
          z.looseObject({
            path: z.array(z.number().int().min(0)).max(24),
            name: z.string().max(200).nullable(),
          }),
        )
        .max(64),
      worldPoints: z.array(z.tuple([z.number(), z.number(), z.number()])).min(2).max(MAX_POINTS),
      cameraPose: z.looseObject({
        position: z.tuple([z.number(), z.number(), z.number()]),
        target: z.tuple([z.number(), z.number(), z.number()]),
        fov: z.number(),
      }),
    })
    .optional(),
});

const reviewSchema = z.looseObject({
  version: z.literal(1),
  spec: z.string(),
  notes: z.array(noteSchema).max(500),
});

/** An empty review document, which is what a spec with no notes has. */
export function emptyReview(path: string): ReviewDoc {
  return { version: 1, spec: path, notes: [] };
}

/**
 * The review file beside one spec.
 *
 * Derived from the resolved target rather than from the string the caller sent,
 * so a path the save endpoint would refuse is never a path notes are written to.
 */
export function reviewTarget(target: string): string {
  return target.endsWith('.spec.json')
    ? `${target.slice(0, -'.spec.json'.length)}.review.json`
    : `${target.slice(0, -'.json'.length)}.review.json`;
}

/** The one spelling a path is compared by: project-relative, no leading slash. */
function normalPath(path: string): string {
  return path.replace(/^\.?\//, '');
}

/**
 * The newest rows of a build log, for one spec.
 *
 * Walked backwards from the end, because that is where the newest lines are and
 * because the last line is routinely half-written — the CLI appends to this
 * file while the studio is reading it. Every unparsable line is skipped rather
 * than only the last, since a crashed build can leave one anywhere.
 */
export function parseBuildsTail(
  text: string,
  source: string | null,
  limit: number,
): BuildRow[] {
  const want = source ? normalPath(source) : null;
  const lines = text.split('\n');
  const out: BuildRow[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: BuildRow;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      row = parsed as BuildRow;
    } catch {
      continue;
    }
    if (typeof row.at !== 'string' || typeof row.source !== 'string') continue;
    if (want && normalPath(row.source) !== want) continue;
    out.push(row);
  }
  return out;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      // A spec is kilobytes; anything bigger is not one.
      if (body.length > 4_000_000) fail(Error('Body too large.'));
    });
    request.on('end', () => done(body));
    request.on('error', fail);
  });
}

function reply(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers))
    response.setHeader(key, value);
  response.end(JSON.stringify(payload));
}

/**
 * The query string, read from the URL as it arrived.
 *
 * Connect rewrites `req.url` to strip the prefix it matched, so the query has
 * to come from `originalUrl` where one exists. Split rather than `new URL`,
 * because a middleware URL is a path with no origin to resolve against.
 */
function queryOf(request: IncomingMessage): URLSearchParams {
  const raw =
    (request as IncomingMessage & { originalUrl?: string }).originalUrl ??
    request.url ??
    '';
  const at = raw.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : raw.slice(at + 1));
}

/**
 * Resolve a caller-supplied spec path, or null when it is not one.
 *
 * Shared by all three routes so a path the save endpoint refuses is not a path
 * the read endpoint hands out.
 */
function specTarget(path: unknown): string | null {
  if (typeof path !== 'string' || !SPEC_PATH.test(path) || path.includes('..'))
    return null;
  const target = resolve(path);
  if (relative(process.cwd(), target).startsWith('..')) return null;
  return target;
}

/** Project-relative and POSIX, so the value round-trips through `?spec=`. */
function projectPath(target: string): string {
  return relative(process.cwd(), target).split(sep).join('/');
}

/** A marker that changes whenever the bytes could have. */
function etagOf(info: { mtimeMs: number; size: number }): string {
  return `W/"${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`;
}

/** Every `*.spec.json` under `dir`, depth first. Unreadable folders are skipped. */
async function walkSpecs(dir: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing or unreadable `specs/` is an empty listing, not a 500.
    return;
  }
  for (const entry of entries) {
    // Dot-directories hold tool state, never authored specs.
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkSpecs(full, found);
    else if (entry.isFile() && entry.name.endsWith('.spec.json')) found.push(full);
  }
}

/** Authored parts, counting nested children — the number the outliner lists. */
function countParts(parts: unknown): number {
  if (!Array.isArray(parts)) return 0;
  let total = 0;
  for (const part of parts) {
    total++;
    if (part && typeof part === 'object')
      total += countParts((part as { children?: unknown }).children);
  }
  return total;
}

/** The filename without its extensions, for a file whose `name` is unreadable. */
function nameFromPath(path: string): string {
  return path.split('/').pop()!.replace(/\.spec\.json$/, '');
}

/**
 * Describe one spec file without building it.
 *
 * Deliberately `JSON.parse` and nothing else: the dev server is single
 * threaded, and building a dozen specs to count their triangles would stall
 * every module request behind it. The studio works the expensive numbers out
 * in the browser, for the rows a person can actually see.
 */
export async function describeSpec(target: string): Promise<SpecRow> {
  const info = await stat(target);
  const path = projectPath(target);
  const base: SpecRow = {
    path,
    name: nameFromPath(path),
    kind: 'prop',
    rig: 'none',
    parts: 0,
    surface: false,
    modified: new Date(info.mtimeMs).toISOString(),
    size: info.size,
  };
  let spec: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw Error('not an object');
    spec = parsed as Record<string, unknown>;
  } catch {
    // Caught rather than dropped: a file being written right now is the normal
    // case here, and a row that says so is more use than a listing that
    // silently loses whatever an agent is in the middle of producing.
    return { ...base, broken: true };
  }
  return {
    ...base,
    name: typeof spec.name === 'string' && spec.name ? spec.name : base.name,
    kind: typeof spec.kind === 'string' ? spec.kind : base.kind,
    rig: spec.rig
      ? 'rig'
      : Array.isArray(spec.joints) && spec.joints.length
        ? 'joints'
        : 'none',
    parts: countParts(spec.parts),
    surface: Boolean(spec.surface),
  };
}

/** The whole `specs/` folder, newest write first. */
export async function listSpecs(): Promise<SpecListing> {
  const found: string[] = [];
  await walkSpecs(resolve(SPECS_DIR), found);
  const rows = await Promise.all(
    found.map((target) =>
      describeSpec(target).catch(() => null as SpecRow | null),
    ),
  );
  const specs = rows.filter((row): row is SpecRow => row !== null);
  // Newest first, with the path as a tie-break so two files written in the
  // same millisecond do not swap places between two polls.
  specs.sort(
    (a, b) =>
      Date.parse(b.modified) - Date.parse(a.modified) ||
      a.path.localeCompare(b.path),
  );
  return { specs, at: new Date().toISOString() };
}

export function oddlingsStudioApi(): Plugin {
  return {
    name: 'oddlings-studio-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(SAVE_ROUTE, async (request, response) => {
        if (request.method !== 'POST') return reply(response, 405, { error: 'POST only.' });
        try {
          const { path, spec } = JSON.parse(await readBody(request)) as {
            path?: unknown;
            spec?: unknown;
          };
          const target = specTarget(path);
          if (!target)
            return reply(response, 400, { error: 'Not a spec path inside the project.' });
          // Validate with the real schema so a bad edit is refused here, with
          // the parser's message, rather than written and discovered by the
          // agent's next build.
          const { parseSpec } = await import('../lib/asset-spec');
          const parsed = parseSpec(spec);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, JSON.stringify(spec, null, 2) + '\n');
          await markActive(parsed.name, parsed, target);
          return reply(response, 200, {
            ok: true,
            path: projectPath(target),
            name: parsed.name,
            at: new Date().toISOString(),
          });
        } catch (error) {
          return reply(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use(SPECS_ROUTE, async (request, response) => {
        if (request.method !== 'GET') return reply(response, 405, { error: 'GET only.' });
        try {
          // Never cached: the point of this route is to notice a file an agent
          // wrote a second ago.
          return reply(response, 200, await listSpecs(), {
            'Cache-Control': 'no-store',
          });
        } catch (error) {
          return reply(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use(SPEC_ROUTE, async (request, response) => {
        if (request.method !== 'GET') return reply(response, 405, { error: 'GET only.' });
        const asked = queryOf(request).get('path');
        const target = specTarget(asked);
        if (!target)
          return reply(response, 400, { error: 'Not a spec path inside the project.' });
        try {
          const info = await stat(target);
          const etag = etagOf(info);
          // The studio polls this while a project row is open, so an unchanged
          // file should cost a header exchange rather than a re-parse.
          if (request.headers?.['if-none-match'] === etag) {
            response.statusCode = 304;
            response.setHeader('ETag', etag);
            return response.end();
          }
          const body = await readFile(target, 'utf8');
          // Parsed and re-serialised so a half-written file is a 400 here
          // rather than a thrown `JSON.parse` in the browser.
          const spec: unknown = JSON.parse(body);
          return reply(response, 200, spec, {
            ETag: etag,
            'Cache-Control': 'no-store',
          });
        } catch (error) {
          return reply(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use(NOTES_ROUTE, async (request, response) => {
        const method = request.method ?? 'GET';
        if (method !== 'GET' && method !== 'PUT')
          return reply(response, 405, { error: 'GET or PUT only.' });
        try {
          // The path arrives in the query on a read and in the body on a write,
          // and both go through `specTarget` — notes are only ever written
          // beside a file this server would have let the studio save to. The
          // body is read once and held: the stream has one pass in it.
          const sent =
            method === 'PUT'
              ? (JSON.parse(await readBody(request)) as {
                  path?: unknown;
                  notes?: unknown;
                })
              : null;
          const asked = sent ? (sent.path ?? null) : queryOf(request).get('path');
          const target = specTarget(asked);
          if (!target)
            return reply(response, 400, {
              error: 'Not a spec path inside the project.',
            });
          const path = projectPath(target);
          const notesFile = reviewTarget(target);
          if (method === 'GET') {
            let body: string;
            try {
              body = await readFile(notesFile, 'utf8');
            } catch {
              // A spec nobody has reviewed yet has no file, which is an empty
              // document rather than a 404: the panel wants somewhere to put
              // the first note, not an error to render.
              return reply(response, 200, emptyReview(path), {
                'Cache-Control': 'no-store',
              });
            }
            const parsed = reviewSchema.safeParse(JSON.parse(body));
            if (!parsed.success)
              return reply(response, 200, emptyReview(path), {
                'Cache-Control': 'no-store',
              });
            return reply(
              response,
              200,
              { ...parsed.data, spec: path },
              { 'Cache-Control': 'no-store' },
            );
          }
          // Only the notes are taken from the request: the version and the spec
          // path this file claims are ours to state, so a document cannot be
          // written claiming to be about a different spec than the one it sits
          // beside.
          const parsed = reviewSchema.parse({
            version: 1,
            spec: path,
            notes: sent!.notes,
          });
          await mkdir(dirname(notesFile), { recursive: true });
          await writeFile(notesFile, JSON.stringify(parsed, null, 2) + '\n');
          return reply(response, 200, {
            ok: true,
            path: projectPath(notesFile),
            notes: parsed.notes.length,
            at: new Date().toISOString(),
          });
        } catch (error) {
          return reply(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use(BUILDS_ROUTE, async (request, response) => {
        if (request.method !== 'GET')
          return reply(response, 405, { error: 'GET only.' });
        const query = queryOf(request);
        const asked = query.get('path');
        const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50));
        let text: string;
        try {
          text = await readFile(resolve(BUILDS_FILE), 'utf8');
        } catch {
          // No log yet is not an error: it means no build has been run since
          // the CLI learned to write one.
          return reply(response, 200, { builds: [] }, { 'Cache-Control': 'no-store' });
        }
        return reply(
          response,
          200,
          { builds: parseBuildsTail(text, asked, limit) },
          { 'Cache-Control': 'no-store' },
        );
      });
    },
  };
}
