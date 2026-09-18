import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { markActive } from './active-spec';

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
    },
  };
}
