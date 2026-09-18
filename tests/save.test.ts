import '../lib/node-shims';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { oddlingsSave, SAVE_ROUTE } from '../node/save-plugin';
import { readFileSync } from 'node:fs';

type Handler = (request: EventEmitter & { method: string; setEncoding(): void }, response: FakeResponse) => Promise<void>;
class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  setHeader(k: string, v: string) { this.headers[k] = v; }
  end(chunk: string) { this.body = chunk; }
}

/** Run the middleware the way Vite would, with a request body of our choosing. */
async function post(handler: Handler, body: unknown, method = 'POST') {
  const request = Object.assign(new EventEmitter(), { method, setEncoding() {} });
  const response = new FakeResponse();
  const done = handler(request as never, response);
  request.emit('data', JSON.stringify(body));
  request.emit('end');
  await done;
  return { status: response.statusCode, json: JSON.parse(response.body) as Record<string, unknown> };
}

let handler: Handler;
let scratch: string;
const rifle = JSON.parse(readFileSync('specs/sniper-rifle.spec.json', 'utf8'));

beforeAll(async () => {
  const plugin = oddlingsSave();
  const server = { middlewares: { use(route: string, fn: Handler) { expect(route).toBe(SAVE_ROUTE); handler = fn; } } };
  (plugin.configureServer as (s: unknown) => void)(server);
  // A scratch folder inside the project, because the endpoint refuses to
  // write anywhere else — which is the point of the next test.
  scratch = await mkdtemp(join(process.cwd(), 'specs', 'drafts', 'save-test-'));
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('save-back', () => {
  test('writes a valid spec where the studio asked, pretty-printed', async () => {
    const path = relative(process.cwd(), join(scratch, 'rifle.spec.json'));
    const { status, json } = await post(handler, { path, spec: rifle });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.name).toBe('Sniper Rifle');
    const written = await readFile(join(scratch, 'rifle.spec.json'), 'utf8');
    expect(JSON.parse(written)).toEqual(rifle);
    expect(written.split('\n').length).toBeGreaterThan(10);
  });

  test('refuses a path that leaves the project or is not a spec', async () => {
    expect((await post(handler, { path: '../outside.json', spec: rifle })).status).toBe(400);
    expect((await post(handler, { path: 'specs/x.txt', spec: rifle })).status).toBe(400);
    expect((await post(handler, { path: '/etc/passwd.json', spec: rifle })).status).toBe(400);
  });

  test('refuses a spec the builder would reject, with the parser message', async () => {
    const path = relative(process.cwd(), join(scratch, 'bad.spec.json'));
    const { status, json } = await post(handler, { path, spec: { ...rifle, parts: [] } });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/parts/);
    await expect(readFile(join(scratch, 'bad.spec.json'))).rejects.toThrow();
  });

  test('is POST only', async () => {
    expect((await post(handler, {}, 'GET')).status).toBe(405);
  });
});
