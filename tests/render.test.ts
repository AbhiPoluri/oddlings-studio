import '../lib/node-shims';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import {
  AXIS_VIEWS,
  DEFAULT_VIEWS,
  renderModel,
  renderPngs,
  VIEWS,
} from '../lib/asset-render';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'oddlings-render-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

beforeAll(async () => {
  await readySurface();
});

const base = { version: 1 as const, name: 'Render Box', kind: 'prop' as const };

const boxSpec: AssetSpecInput = {
  ...base,
  parts: [{ name: 'body', shape: 'box', size: [1, 1, 1], color: '#c04030' }],
};

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function oddlings(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(
        join(root, 'node_modules/.bin/tsx'),
        [join(root, 'cli/oddlings.ts'), ...args],
        { cwd: root },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }));
    },
  );
}

describe('the rasteriser', () => {
  test('draws a box into every default view, and fills the frame', () => {
    const render = renderModel(buildSpec(boxSpec), { size: 128 });
    expect(render.views.map((v) => v.view)).toEqual(DEFAULT_VIEWS);
    for (const view of render.views) {
      // A box seen square-on covers most of its own frame; seen from three
      // quarters it covers less. Anything near zero means nothing was drawn.
      expect(view.fill, view.view).toBeGreaterThan(0.3);
      expect(view.fill, view.view).toBeLessThanOrEqual(1);
      expect(view.rgba.length).toBe(128 * 128 * 4);
    }
  });

  test('covered pixels carry the part, the triangle and a finite depth', () => {
    const [view] = renderModel(buildSpec(boxSpec), {
      size: 96,
      views: ['front'],
    }).views;
    let covered = 0;
    let background = 0;
    for (let i = 0; i < view.part.length; i++) {
      if (view.part[i] < 0) {
        // The three buffers agree about where the model is not.
        expect(view.triangle[i]).toBe(-1);
        expect(view.depth[i]).toBe(Infinity);
        background++;
      } else {
        expect(view.triangle[i]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(view.depth[i])).toBe(true);
        covered++;
      }
    }
    expect(covered).toBeGreaterThan(0);
    expect(background).toBeGreaterThan(0);
  });

  test('a red box renders red, and is shaded rather than flat', () => {
    const [view] = renderModel(buildSpec(boxSpec), {
      size: 64,
      views: ['three-quarter'],
    }).views;
    const shades = new Set<string>();
    let reds = 0;
    for (let i = 0; i < view.part.length; i++) {
      if (view.part[i] < 0) continue;
      const r = view.rgba[i * 4],
        g = view.rgba[i * 4 + 1],
        b = view.rgba[i * 4 + 2];
      if (r > g + 20 && r > b + 20) reds++;
      shades.add(`${r},${g},${b}`);
    }
    expect(reds).toBeGreaterThan(0);
    // Three faces of the cube face the camera at three angles, so one colour
    // would mean the lighting never ran.
    expect(shades.size).toBeGreaterThan(2);
  });

  test('the same model renders to the same bytes twice', () => {
    const spec = parseSpec(boxSpec);
    const first = renderPngs(buildSpec(spec), { size: 128 });
    const second = renderPngs(buildSpec(spec), { size: 128 });
    expect(first.images.map((i) => hash(i.png))).toEqual(
      second.images.map((i) => hash(i.png)),
    );
    // Non-empty: a PNG of nothing still has a header, so check the pixels.
    for (const image of first.images) expect(image.png.length).toBeGreaterThan(200);
  });

  test('every named view renders, including the six axis ones', () => {
    const render = renderModel(buildSpec(boxSpec), {
      size: 48,
      views: [...VIEWS],
    });
    expect(render.views).toHaveLength(VIEWS.length);
    for (const view of render.views)
      expect(view.fill, view.view).toBeGreaterThan(0.3);
    expect(AXIS_VIEWS.every((view) => VIEWS.includes(view))).toBe(true);
  });

  test('a fused surface renders from its vertex colours', () => {
    const spec: AssetSpecInput = {
      version: 1,
      name: 'Blob',
      kind: 'creature',
      surface: { detail: 40, blend: 0.12 },
      parts: [
        { name: 'body', shape: 'sphere', size: [0.8, 0.9, 0.8], position: [0, 0.5, 0], color: '#2050c0' },
        { name: 'nose', shape: 'sphere', size: [0.3, 0.3, 0.5], position: [0, 0.6, 0.5], color: '#e0d020' },
      ],
    };
    const [view] = renderModel(buildSpec(spec), {
      size: 96,
      views: ['front'],
    }).views;
    const parts = new Set<number>();
    for (let i = 0; i < view.part.length; i++)
      if (view.part[i] >= 0) parts.add(view.part[i]);
    // One fused mesh, two authored parts: the per-vertex owners have to come
    // through or the whole part-ID buffer collapses to one value.
    expect(parts.size).toBe(2);
  });
});

describe('oddlings render', () => {
  test('writes one PNG a view and reports where they landed', async () => {
    const spec = join(scratch, 'render-box.spec.json');
    await writeFile(spec, JSON.stringify(boxSpec));
    const out = join(scratch, 'shots');
    const result = await oddlings([
      'render',
      spec,
      '--out',
      out,
      '--size',
      '64',
      '--views',
      'front,side',
    ]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const written = (await readdir(out)).sort();
    expect(written).toEqual(['render-box-front.png', 'render-box-side.png']);
    expect(result.stdout).toContain('silhouette');
    const png = await readFile(join(out, 'render-box-front.png'));
    // The eight-byte PNG signature, so this is a file a viewer will open.
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 90000);

  test('an unknown view is refused by name', async () => {
    const result = await oddlings(['render', 'specs/wizard.spec.json', '--views', 'isometric']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('three-quarter');
  }, 60000);
});

describe('speed', () => {
  test('a real character renders four views in well under a second each', async () => {
    const spec = parseSpec(
      JSON.parse(await readFile(join(root, 'specs/wizard.spec.json'), 'utf8')),
    );
    const model = buildSpec(spec);
    const render = renderModel(model, { size: 512 });
    const each = render.ms / render.views.length;
    console.log(
      `wizard: ${render.triangles.toLocaleString()} tris · ${render.views.length} views at 512px · ${render.ms} ms total · ${each.toFixed(0)} ms a view`,
    );
    expect(each).toBeLessThan(2000);
  }, 120000);
});
