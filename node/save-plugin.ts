import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { markActive } from './active-spec';

/**
 * Save-back for the studio.
 *
 * The follow feature makes the studio show what an agent just built. That is
 * half a review loop: a person can see a floating part, but until now their
 * fix lived only in the browser tab, and the agent's next iteration started
 * from the file it had written, not from the correction. This endpoint closes
 * the loop — the studio writes the edited spec back to the followed file and
 * re-points the preview at it, so the agent picks up from the reviewer's
 * version.
 *
 * Dev-server only, by construction: it is a Vite middleware on the local
 * process, never bundled for the Worker, and it only writes inside the
 * project to paths that look like specs.
 */
export const SAVE_ROUTE = '/__oddlings/save';

/** The same rule the `?spec=` pin uses: a relative JSON path, no escaping. */
const SPEC_PATH = /^[\w./-]+\.json$/;

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

function reply(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}

export function oddlingsSave(): Plugin {
  return {
    name: 'oddlings-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(SAVE_ROUTE, async (request, response) => {
        if (request.method !== 'POST') return reply(response, 405, { error: 'POST only.' });
        try {
          const { path, spec } = JSON.parse(await readBody(request)) as {
            path?: unknown;
            spec?: unknown;
          };
          if (typeof path !== 'string' || !SPEC_PATH.test(path) || path.includes('..'))
            return reply(response, 400, { error: 'Not a spec path.' });
          const target = resolve(path);
          if (relative(process.cwd(), target).startsWith('..'))
            return reply(response, 400, { error: 'Path leaves the project.' });
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
            path: relative(process.cwd(), target),
            name: parsed.name,
            at: new Date().toISOString(),
          });
        } catch (error) {
          return reply(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
