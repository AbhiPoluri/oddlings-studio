import '../lib/node-shims';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BUILDS_ROUTE,
  NOTES_ROUTE,
  oddlingsStudioApi,
  parseBuildsTail,
  SAVE_ROUTE,
  SPEC_ROUTE,
  SPECS_ROUTE,
  type SpecListing,
  type SpecRow,
} from '../node/studio-api';
import {
  arrange,
  measureKey,
  pathOfKey,
  relativeTime,
  signatureOf,
} from '../components/studio/projects';
import { readFileSync } from 'node:fs';

type FakeRequest = EventEmitter & {
  method: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
  setEncoding(): void;
};
type Handler = (request: FakeRequest, response: FakeResponse) => Promise<void>;

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  setHeader(k: string, v: string) { this.headers[k] = v; }
  end(chunk?: string) { this.body = chunk ?? ''; }
}

/** Run one middleware the way Vite would, with a request of our choosing. */
async function call(
  route: string,
  {
    method = 'GET',
    url,
    body,
    headers,
  }: { method?: string; url?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const handler = handlers.get(route);
  if (!handler) throw Error(`No middleware registered on ${route}.`);
  const request = Object.assign(new EventEmitter(), {
    method,
    url: url ?? '/',
    originalUrl: url ? `${route}${url}` : route,
    headers: headers ?? {},
    setEncoding() {},
  }) as FakeRequest;
  const response = new FakeResponse();
  const done = handler(request, response);
  if (body !== undefined) {
    request.emit('data', JSON.stringify(body));
    request.emit('end');
  }
  await done;
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body
      ? (JSON.parse(response.body) as Record<string, unknown>)
      : null,
  };
}

const post = (body: unknown, method = 'POST') => call(SAVE_ROUTE, { method, body });

const handlers = new Map<string, Handler>();
let scratch: string;
const rifle = JSON.parse(readFileSync('specs/sniper-rifle.spec.json', 'utf8'));

/** The listing's own path spelling, for a file inside the scratch folder. */
const scratchPath = (file: string) =>
  relative(process.cwd(), join(scratch, file)).split(sep).join('/');

beforeAll(async () => {
  const plugin = oddlingsStudioApi();
  const server = {
    middlewares: {
      use(route: string, fn: Handler) {
        handlers.set(route, fn);
      },
    },
  };
  (plugin.configureServer as (s: unknown) => void)(server);
  // A scratch folder inside the project, because the endpoint refuses to
  // write anywhere else — which is the point of the next test.
  scratch = await mkdtemp(join(process.cwd(), 'specs', 'drafts', 'api-test-'));
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('save-back', () => {
  test('writes a valid spec where the studio asked, pretty-printed', async () => {
    const path = relative(process.cwd(), join(scratch, 'rifle.spec.json'));
    const { status, json } = await post({ path, spec: rifle });
    expect(status).toBe(200);
    expect(json!.ok).toBe(true);
    expect(json!.name).toBe('Sniper Rifle');
    const written = await readFile(join(scratch, 'rifle.spec.json'), 'utf8');
    expect(JSON.parse(written)).toEqual(rifle);
    expect(written.split('\n').length).toBeGreaterThan(10);
  });

  test('refuses a path that leaves the project or is not a spec', async () => {
    expect((await post({ path: '../outside.json', spec: rifle })).status).toBe(400);
    expect((await post({ path: 'specs/x.txt', spec: rifle })).status).toBe(400);
    expect((await post({ path: '/etc/passwd.json', spec: rifle })).status).toBe(400);
  });

  test('refuses a spec the builder would reject, with the parser message', async () => {
    const path = relative(process.cwd(), join(scratch, 'bad.spec.json'));
    const { status, json } = await post({ path, spec: { ...rifle, parts: [] } });
    expect(status).toBe(400);
    expect(String(json!.error)).toMatch(/parts/);
    await expect(readFile(join(scratch, 'bad.spec.json'))).rejects.toThrow();
  });

  test('is POST only', async () => {
    expect((await post({}, 'GET')).status).toBe(405);
  });
});

/** Read the listing, failing loudly rather than casting an error body. */
async function listing(): Promise<SpecListing> {
  const { status, json } = await call(SPECS_ROUTE);
  expect(status).toBe(200);
  return json as unknown as SpecListing;
}

const find = (rows: SpecRow[], path: string) => rows.find((row) => row.path === path);

describe('the specs listing', () => {
  test('describes every shipped spec, drafts included', async () => {
    const { specs, at } = await listing();
    expect(Number.isNaN(Date.parse(at))).toBe(false);

    const octopod = find(specs, 'specs/octopod-walker.spec.json');
    expect(octopod).toBeDefined();
    expect(octopod!.name).toBe('Octopod Walker');
    expect(octopod!.rig).toBe('joints');
    expect(octopod!.parts).toBeGreaterThan(0);
    expect(typeof octopod!.size).toBe('number');
    expect(Number.isNaN(Date.parse(octopod!.modified))).toBe(false);
    expect(octopod!.broken).toBeUndefined();

    // A body rig and a surface spec, so every badge the panel draws is covered.
    expect(find(specs, 'specs/wizard.spec.json')!.rig).toBe('rig');
    expect(find(specs, 'specs/kaiju-surface.spec.json')!.surface).toBe(true);
    expect(find(specs, 'specs/flower-bush.spec.json')!.rig).toBe('none');
    // Nested folders are walked, so a draft an agent left behind is listed.
    expect(find(specs, 'specs/drafts/naval-destroyer-v1.spec.json')).toBeDefined();
  });

  test('counts authored parts including nested children', async () => {
    const path = scratchPath('counted.spec.json');
    await writeFile(
      join(scratch, 'counted.spec.json'),
      JSON.stringify({
        version: 1,
        name: 'Counted',
        kind: 'prop',
        parts: [
          {
            name: 'body',
            shape: 'box',
            size: [1, 1, 1],
            children: [{ name: 'knob', shape: 'sphere', size: [0.2, 0.2, 0.2] }],
          },
          { name: 'base', shape: 'cylinder', size: [1, 0.2, 1] },
        ],
      }),
    );
    const row = find((await listing()).specs, path)!;
    expect(row.parts).toBe(3);
    expect(row.kind).toBe('prop');
  });

  test('reports a half-written file as broken rather than losing it', async () => {
    const path = scratchPath('torn.spec.json');
    await writeFile(join(scratch, 'torn.spec.json'), '{"version":1,"name":"Torn"');
    const row = find((await listing()).specs, path);
    expect(row).toBeDefined();
    expect(row!.broken).toBe(true);
    // No name to read, so the filename stands in.
    expect(row!.name).toBe('torn');
  });

  test('is sorted newest write first', async () => {
    const path = scratchPath('freshest.spec.json');
    await writeFile(
      join(scratch, 'freshest.spec.json'),
      JSON.stringify({
        version: 1,
        name: 'Freshest',
        kind: 'prop',
        parts: [{ name: 'body', shape: 'box', size: [1, 1, 1] }],
      }),
    );
    // Dated forward, because the other fixtures were written moments ago too.
    const soon = new Date(Date.now() + 60_000);
    await utimes(join(scratch, 'freshest.spec.json'), soon, soon);

    const { specs } = await listing();
    expect(specs[0].path).toBe(path);
    const times = specs.map((row) => Date.parse(row.modified));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('is GET only', async () => {
    expect((await call(SPECS_ROUTE, { method: 'POST' })).status).toBe(405);
  });
});

/**
 * The rules the Projects panel reads the listing by.
 *
 * Pure, and tested here beside the route that produces the rows, because the
 * two only make sense together: the signature exists because the route stamps
 * every answer with a fresh `at`.
 */
describe('arranging the listing', () => {
  const row = (over: Partial<SpecRow>): SpecRow => ({
    path: 'specs/a.spec.json',
    name: 'A',
    kind: 'prop',
    rig: 'none',
    parts: 1,
    surface: false,
    modified: '2026-09-18T00:00:00.000Z',
    size: 10,
    ...over,
  });

  test('a signature ignores the timestamp the server answered at', async () => {
    // Two answers about an unchanged folder are one listing, however the
    // server stamped them — which is what stops the panel rebuilding its rows
    // every three seconds for the rest of the session.
    const one = await listing();
    const two = await listing();
    expect(signatureOf(two.specs)).toBe(signatureOf(one.specs));
  });

  test('a signature changes when a file does', () => {
    const before = [row({}), row({ path: 'specs/b.spec.json', name: 'B' })];
    expect(signatureOf(before)).not.toBe(
      signatureOf([before[0], { ...before[1], modified: '2026-09-18T01:00:00.000Z' }]),
    );
    expect(signatureOf(before)).not.toBe(signatureOf([before[0]]));
    expect(signatureOf(before)).toBe(signatureOf([...before]));
  });

  test('sorts by write time or by name, breaking ties on the path', () => {
    const rows = [
      row({ path: 'specs/old.spec.json', name: 'Zebra', modified: '2026-09-17T00:00:00.000Z' }),
      row({ path: 'specs/new.spec.json', name: 'Apple', modified: '2026-09-18T00:00:00.000Z' }),
    ];
    expect(arrange(rows).map((r) => r.name)).toEqual(['Apple', 'Zebra']);
    expect(arrange(rows, { sort: 'name' }).map((r) => r.name)).toEqual([
      'Apple',
      'Zebra',
    ]);
    const tied = [
      row({ path: 'specs/b.spec.json', name: 'Same' }),
      row({ path: 'specs/a.spec.json', name: 'Same' }),
    ];
    expect(arrange(tied, { sort: 'name' }).map((r) => r.path)).toEqual([
      'specs/a.spec.json',
      'specs/b.spec.json',
    ]);
  });

  test('searches the name, the path and the kind', () => {
    const rows = [
      row({ path: 'specs/drafts/hull.spec.json', name: 'Hull', kind: 'prop' }),
      row({ path: 'specs/wyrm.spec.json', name: 'Wyrm', kind: 'creature' }),
    ];
    expect(arrange(rows, { query: 'drafts' }).map((r) => r.name)).toEqual(['Hull']);
    expect(arrange(rows, { query: 'creature' }).map((r) => r.name)).toEqual(['Wyrm']);
    expect(arrange(rows, { query: 'WYRM' }).map((r) => r.name)).toEqual(['Wyrm']);
    expect(arrange(rows, { query: 'nothing' })).toEqual([]);
    expect(arrange(rows, { query: '   ' })).toHaveLength(2);
  });

  test('relative times read as a person would say them', () => {
    const now = Date.parse('2026-09-18T12:00:00.000Z');
    const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
    expect(ago(0)).toBe('just now');
    expect(ago(30_000)).toBe('just now');
    expect(ago(2 * 60_000)).toBe('2 min ago');
    expect(ago(59 * 60_000)).toBe('59 min ago');
    expect(ago(60 * 60_000)).toBe('1 hr ago');
    expect(ago(5 * 60 * 60_000)).toBe('5 hrs ago');
    expect(ago(26 * 60 * 60_000)).toBe('1 day ago');
    expect(ago(3 * 24 * 60 * 60_000)).toBe('3 days ago');
    // Past a week the gap stops being the useful fact, so it shows the date.
    expect(ago(40 * 24 * 60 * 60_000)).not.toMatch(/ago/);
    // A clock running fast is not a file from the future.
    expect(relativeTime(new Date(now + 4000).toISOString(), now)).toBe('just now');
    expect(relativeTime('not a date', now)).toBe('—');
  });

  test('a measure key names the file and the version of it that was read', () => {
    const first = row({ modified: '2026-09-18T00:00:00.000Z' });
    const rebuilt = { ...first, modified: '2026-09-18T00:05:00.000Z' };
    expect(measureKey(first)).not.toBe(measureKey(rebuilt));
    expect(pathOfKey(measureKey(rebuilt))).toBe(first.path);
  });
});

describe('reading one spec', () => {
  test('returns the file with an ETag that survives a re-read', async () => {
    const { status, headers, json } = await call(SPEC_ROUTE, {
      url: '?path=specs/flower-bush.spec.json',
    });
    expect(status).toBe(200);
    expect(json!.name).toBe(
      JSON.parse(readFileSync('specs/flower-bush.spec.json', 'utf8')).name,
    );
    expect(headers.ETag).toMatch(/^W\//);

    const again = await call(SPEC_ROUTE, { url: '?path=specs/flower-bush.spec.json' });
    expect(again.headers.ETag).toBe(headers.ETag);
  });

  test('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await call(SPEC_ROUTE, { url: '?path=specs/flower-bush.spec.json' });
    const second = await call(SPEC_ROUTE, {
      url: '?path=specs/flower-bush.spec.json',
      headers: { 'if-none-match': first.headers.ETag },
    });
    expect(second.status).toBe(304);
    expect(second.json).toBeNull();
  });

  test('the ETag changes when the file does', async () => {
    const file = join(scratch, 'moving.spec.json');
    const spec = {
      version: 1,
      name: 'Moving',
      kind: 'prop',
      parts: [{ name: 'body', shape: 'box', size: [1, 1, 1] }],
    };
    await writeFile(file, JSON.stringify(spec));
    const url = `?path=${scratchPath('moving.spec.json')}`;
    const before = await call(SPEC_ROUTE, { url });
    await writeFile(file, JSON.stringify({ ...spec, name: 'Moved', seed: 7 }));
    const after = await call(SPEC_ROUTE, { url });
    expect(after.headers.ETag).not.toBe(before.headers.ETag);
    expect(after.json!.name).toBe('Moved');
  });

  test('refuses a path that leaves the project, and 404s a missing one', async () => {
    expect((await call(SPEC_ROUTE, { url: '?path=../outside.json' })).status).toBe(400);
    expect((await call(SPEC_ROUTE, { url: '?path=specs/x.txt' })).status).toBe(400);
    expect((await call(SPEC_ROUTE, { url: '' })).status).toBe(400);
    expect(
      (await call(SPEC_ROUTE, { url: '?path=specs/nope.spec.json' })).status,
    ).toBe(404);
  });

  test('is GET only', async () => {
    expect(
      (await call(SPEC_ROUTE, { method: 'POST', url: '?path=specs/flower-bush.spec.json' }))
        .status,
    ).toBe(405);
  });
});

/**
 * Review notes, from the studio's end.
 *
 * The other half of this conversation is the CLI, which reads and resolves the
 * same file — so these assert the contract rather than the implementation: a
 * spec nobody has reviewed answers with an empty document, a PUT writes JSON a
 * person could read in a diff, and a field the studio does not know about
 * survives the round trip instead of being quietly deleted.
 */
describe('review notes', () => {
  const note = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    part: [0],
    partName: 'body',
    text: 'The barrel floats.',
    status: 'open',
    by: 'human',
    at: '2026-09-18T00:00:00.000Z',
    resolvedAt: null,
    reply: null,
    ...over,
  });

  test('a spec nobody has reviewed answers with an empty document', async () => {
    const path = scratchPath('fresh.spec.json');
    await writeFile(join(scratch, 'fresh.spec.json'), JSON.stringify(rifle));
    const { status, json } = await call(NOTES_ROUTE, { url: `?path=${path}` });
    expect(status).toBe(200);
    expect(json).toEqual({ version: 1, spec: path, notes: [] });
  });

  test('a PUT writes a .review.json beside the spec, pretty-printed', async () => {
    const path = scratchPath('noted.spec.json');
    await writeFile(join(scratch, 'noted.spec.json'), JSON.stringify(rifle));
    const put = await call(NOTES_ROUTE, {
      method: 'PUT',
      body: { path, notes: [note()] },
    });
    expect(put.status).toBe(200);
    expect(put.json!.ok).toBe(true);
    expect(put.json!.path).toBe(scratchPath('noted.review.json'));
    const written = await readFile(join(scratch, 'noted.review.json'), 'utf8');
    expect(written.split('\n').length).toBeGreaterThan(5);
    expect(JSON.parse(written)).toEqual({
      version: 1,
      spec: path,
      notes: [note()],
    });
    // And reading it back is what the panel does on the next page load.
    const { json } = await call(NOTES_ROUTE, { url: `?path=${path}` });
    expect((json as unknown as { notes: unknown[] }).notes).toHaveLength(1);
  });

  test('keeps a field the studio does not know about', async () => {
    const path = scratchPath('extra.spec.json');
    await writeFile(join(scratch, 'extra.spec.json'), JSON.stringify(rifle));
    await call(NOTES_ROUTE, {
      method: 'PUT',
      body: { path, notes: [note({ agentRun: 'run-7' })] },
    });
    const { json } = await call(NOTES_ROUTE, { url: `?path=${path}` });
    const [kept] = (json as unknown as { notes: Record<string, unknown>[] }).notes;
    expect(kept.agentRun).toBe('run-7');
  });

  test('refuses a path outside the project and a note of the wrong shape', async () => {
    expect(
      (await call(NOTES_ROUTE, { url: '?path=../outside.json' })).status,
    ).toBe(400);
    expect(
      (await call(NOTES_ROUTE, { method: 'PUT', body: { path: '../out.json', notes: [] } }))
        .status,
    ).toBe(400);
    const path = scratchPath('bad.spec.json');
    await writeFile(join(scratch, 'bad.spec.json'), JSON.stringify(rifle));
    const bad = await call(NOTES_ROUTE, {
      method: 'PUT',
      body: { path, notes: [note({ status: 'maybe' })] },
    });
    expect(bad.status).toBe(400);
    await expect(readFile(join(scratch, 'bad.review.json'))).rejects.toThrow();
  });

  test('is GET or PUT only', async () => {
    expect((await call(NOTES_ROUTE, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('build history', () => {
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({
      at: '2026-09-18T00:00:00.000Z',
      name: 'Octopod Walker',
      source: 'specs/octopod-walker.spec.json',
      tris: 9000,
      meshes: 40,
      bones: 0,
      ok: true,
      errors: 0,
      warnings: 1,
      ...over,
    });

  test('reads newest first and stops at the limit', () => {
    const text = [
      line({ at: '2026-09-18T00:00:01.000Z' }),
      line({ at: '2026-09-18T00:00:02.000Z' }),
      line({ at: '2026-09-18T00:00:03.000Z' }),
    ].join('\n');
    const rows = parseBuildsTail(text, null, 2);
    expect(rows.map((row) => row.at)).toEqual([
      '2026-09-18T00:00:03.000Z',
      '2026-09-18T00:00:02.000Z',
    ]);
  });

  test('skips a half-written line wherever it is, rather than giving up', () => {
    const text = [
      line({ at: '2026-09-18T00:00:01.000Z' }),
      '{"at":"2026-09-18T00:00:0',
      line({ at: '2026-09-18T00:00:03.000Z' }),
      '{"at":"2026-09',
    ].join('\n');
    expect(parseBuildsTail(text, null, 50).map((row) => row.at)).toEqual([
      '2026-09-18T00:00:03.000Z',
      '2026-09-18T00:00:01.000Z',
    ]);
  });

  test('filters by source, however the leading slash is spelled', () => {
    const text = [
      line({ source: 'specs/wizard.spec.json' }),
      line({ source: './specs/octopod-walker.spec.json', at: '2026-09-18T00:00:09.000Z' }),
    ].join('\n');
    expect(parseBuildsTail(text, 'specs/octopod-walker.spec.json', 50)).toHaveLength(1);
    expect(parseBuildsTail(text, '/specs/wizard.spec.json', 50)).toHaveLength(1);
    expect(parseBuildsTail(text, 'specs/nothing.spec.json', 50)).toHaveLength(0);
    expect(parseBuildsTail(text, null, 50)).toHaveLength(2);
  });

  test('a log that is not there yet is an empty list, not an error', async () => {
    const { status, json } = await call(BUILDS_ROUTE, {
      url: '?path=specs/octopod-walker.spec.json&limit=5',
    });
    expect(status).toBe(200);
    expect(Array.isArray((json as unknown as { builds: unknown[] }).builds)).toBe(true);
  });

  test('is GET only', async () => {
    expect((await call(BUILDS_ROUTE, { method: 'POST' })).status).toBe(405);
  });
});
