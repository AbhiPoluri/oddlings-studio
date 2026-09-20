import '../lib/node-shims';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as T from 'three';
import {
  classifyStroke,
  closed,
  describeMark,
  inPolygon,
  MAX_POINTS,
  resample,
  resolveStroke,
  reversals,
  selfCrossings,
  straightness,
  thin,
  type Mark,
  type PartCentre,
  type Point2,
  type Vec3,
} from '../lib/draw-marks';
import { strokeWorld } from '../lib/draw-anchor';
import { addNote, loadNotes, markSchema, noteSchema, saveNotes } from '../lib/review-notes';
import { NOTES_ROUTE, oddlingsStudioApi } from '../node/studio-api';
import { drawnMarks, markNote, newNote } from '../components/studio/notes';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DrawOverlay } from '../components/studio/draw-overlay';
import { COMMANDS, COMMAND_BY_ID } from '../components/studio/actions';
import { commandFor, keyConflicts } from '../components/studio/keymap';
import { initialState, reducer } from '../components/studio/reducer';
import { parseSpec } from '../lib/asset-spec';
import { readFileSync } from 'node:fs';

/**
 * Draw-to-instruct, from the stroke to the file the agent reads.
 *
 * Three layers, and they are tested separately because they fail separately:
 * what a stroke means is 2D arithmetic with no camera in it; where it lands is
 * a camera with no scene in it; and whether the answer survives the trip to
 * disk is the schema and the route. Nothing here needs a browser, which is the
 * point — the browser pass is for whether the sheet catches the pointer, not
 * for whether a loop encloses a shoulder.
 */

// ── Synthetic strokes ──────────────────────────────────────────────────

/** A ring, in screen pixels. `close` leaves the last point short of the first. */
function ring(
  { x = 200, y = 200, r = 60, n = 36, close = true } = {},
): Point2[] {
  const span = close ? Math.PI * 2 : Math.PI * 1.2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * span;
    return { x: x + Math.cos(t) * r, y: y + Math.sin(t) * r };
  });
}

/** A ruled line from a to b. */
function line(a: Point2, b: Point2, n = 16): Point2[] {
  return Array.from({ length: n }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / (n - 1),
    y: a.y + ((b.y - a.y) * i) / (n - 1),
  }));
}

const all = (n: number, value: boolean) => Array.from({ length: n }, () => value);

describe('what a stroke means', () => {
  test('a stroke that comes back to where it started is a circle', () => {
    const stroke = ring();
    expect(closed(stroke)).toBe(true);
    expect(classifyStroke(stroke, all(stroke.length, true))).toBe('circle');
  });

  test('a big loop is allowed a bigger gap before it stops being closed', () => {
    // The same sixty-pixel gap at two sizes. Nobody closes a gesture that took
    // up half the screen to within twenty pixels, and a small loop left that
    // far open was not a loop.
    const gapped = (r: number, gap: number) => {
      const span = Math.PI * 2 - gap / r;
      return Array.from({ length: 36 }, (_, i) => {
        const t = (i / 35) * span;
        return { x: 500 + Math.cos(t) * r, y: 500 + Math.sin(t) * r };
      });
    };
    expect(closed(gapped(400, 60))).toBe(true);
    expect(closed(gapped(40, 60))).toBe(false);
  });

  test('a loop with a cross through it is a removal, not a circle', () => {
    const stroke = [...ring(), ...line({ x: 150, y: 150 }, { x: 250, y: 250 }, 10)];
    expect(selfCrossings(stroke)).toBeGreaterThanOrEqual(2);
    expect(classifyStroke(stroke, all(stroke.length, true))).toBe('remove');
  });

  test('a zigzag over the model is a removal', () => {
    const stroke = Array.from({ length: 24 }, (_, i) => ({
      x: 100 + i * 8,
      y: 200 + (i % 2 ? 40 : -40),
    }));
    expect(reversals(thin(stroke))).toBeGreaterThanOrEqual(3);
    expect(classifyStroke(stroke, all(stroke.length, true))).toBe('remove');
  });

  test('a straight stroke that ends on the model is an arrow', () => {
    const stroke = line({ x: 40, y: 40 }, { x: 240, y: 180 });
    expect(straightness(stroke)).toBeGreaterThan(0.6);
    // Only the last third lands on anything, which is what pointing is.
    const hits = stroke.map((_, i) => i > stroke.length * 0.7);
    expect(classifyStroke(stroke, hits)).toBe('arrow');
  });

  test('an open stroke that mostly misses the model is a sketch', () => {
    const stroke = Array.from({ length: 20 }, (_, i) => ({
      x: 400 + i * 6,
      y: 300 + Math.sin(i / 3) * 30,
    }));
    expect(classifyStroke(stroke, all(stroke.length, false))).toBe('sketch');
  });

  test('an open scribble over the model is a removal, not a sketch', () => {
    // Wobbly enough not to be an arrow, on the model enough not to be a new
    // thing being asked for: the remaining reading is "get rid of this".
    const stroke = Array.from({ length: 20 }, (_, i) => ({
      x: 100 + i * 12,
      y: 200 + Math.sin(i / 1.6) * 45,
    }));
    expect(classifyStroke(stroke, all(stroke.length, true))).toBe('remove');
  });
});

describe('containment', () => {
  const loop = ring();

  test('a point inside the loop is inside it', () => {
    expect(inPolygon(loop, { x: 200, y: 200 })).toBe(true);
  });

  test('a point outside it is not, however close', () => {
    expect(inPolygon(loop, { x: 400, y: 400 })).toBe(false);
    expect(inPolygon(loop, { x: 200 + 62, y: 200 })).toBe(false);
  });

  test('a concave loop does not swallow the bay it curves around', () => {
    // A C: the middle of the opening is outside the ink even though it is
    // inside the bounding box, which is the case a box test gets wrong.
    const c = ring({ r: 80, n: 40, close: false }).map((p) => ({
      x: p.y,
      y: p.x,
    }));
    expect(inPolygon(c, { x: 200, y: 200 })).toBe(true);
    expect(inPolygon(c, { x: 200, y: 500 })).toBe(false);
  });
});

describe('thinning and resampling', () => {
  test('points closer together than the step are dropped, ends kept', () => {
    const drift = Array.from({ length: 50 }, (_, i) => ({ x: 10 + i * 0.4, y: 10 }));
    const out = thin(drift);
    expect(out.length).toBeLessThan(10);
    expect(out[0]).toEqual(drift[0]);
    expect(out[out.length - 1]).toEqual(drift[drift.length - 1]);
  });

  test('a long stroke is cut to the cap without losing its shape', () => {
    const long = ring({ n: 400 });
    const out = resample(long, MAX_POINTS);
    expect(out).toHaveLength(MAX_POINTS);
    // Still a ring: every kept point is still the radius away from the centre.
    for (const point of out)
      expect(Math.hypot(point.x - 200, point.y - 200)).toBeCloseTo(60, 0);
  });
});

// ── Anchoring, with a real camera and a stubbed model ───────────────────

/** A camera looking at the origin from the front, as the studio's does. */
function camera() {
  const c = new T.PerspectiveCamera(45, 1, 0.1, 100);
  c.position.set(0, 1, 6);
  c.lookAt(0, 1, 0);
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}

const SIZE = { width: 800, height: 600 };

/**
 * A model that is one flat square at z = 0, a metre each way around (0, 1, 0).
 *
 * Enough to answer "did the ray hit, and where": the resolver only ever asks
 * that, and a real mesh would be a slower way of saying the same thing.
 */
function slab(path: number[] | null = [0]) {
  return (at: Point2) => {
    const c = cam;
    const ray = new T.Raycaster();
    ray.setFromCamera(
      new T.Vector2((at.x / SIZE.width) * 2 - 1, -(at.y / SIZE.height) * 2 + 1),
      c,
    );
    const point = new T.Vector3();
    const plane = new T.Plane(new T.Vector3(0, 0, 1), 0);
    if (!ray.ray.intersectPlane(plane, point)) return null;
    if (Math.abs(point.x) > 1 || Math.abs(point.y - 1) > 1) return null;
    return { point: [point.x, point.y, point.z] as Vec3, path };
  };
}

let cam = camera();
const world = (hit: (at: Point2) => { point: Vec3; path: number[] | null } | null) =>
  strokeWorld({ camera: cam, size: SIZE, target: new T.Vector3(0, 1, 0), hit });

const PARTS: PartCentre[] = [
  { path: [0], name: 'torso', centre: [0, 1, 0] },
  { path: [1], name: 'head', centre: [0, 2.4, 0] },
];

describe('anchoring against a camera', () => {
  beforeAll(() => {
    cam = camera();
  });

  test('projecting a world point and hitting it back agree', () => {
    const w = world(slab());
    const middle = w.project([0, 1, 0]);
    expect(middle.x).toBeCloseTo(SIZE.width / 2, 0);
    expect(middle.y).toBeCloseTo(SIZE.height / 2, 0);
    expect(w.hit(middle)!.point[0]).toBeCloseTo(0, 5);
    expect(w.hit(middle)!.point[1]).toBeCloseTo(1, 5);
  });

  test('a stroke off the model still lands somewhere: the ground', () => {
    const w = world(() => null);
    // Low on the screen is the floor in front of the model, not nothing.
    const at = w.ground({ x: 400, y: 560 });
    expect(at).not.toBeNull();
    expect(at![1]).toBeCloseTo(0, 5);
  });

  test('a circle round a part names that part, anchored to the model', () => {
    const middle = world(slab()).project(PARTS[0].centre);
    const stroke = ring({ x: middle.x, y: middle.y, r: 40 });
    const mark = resolveStroke(stroke, world(slab()), PARTS)!;
    expect(mark.gesture).toBe('circle');
    expect(mark.parts.map((p) => p.name)).toEqual(['torso']);
    // On the model, not floating in front of it or behind it.
    for (const point of mark.worldPoints) expect(point[2]).toBeCloseTo(0, 2);
    expect(mark.worldPoints.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(mark.cameraPose.target).toEqual([0, 1, 0]);
    expect(mark.cameraPose.fov).toBe(45);
  });

  test('a ring round a part keeps its sky at the part\'s depth, not the horizon', () => {
    // The case that shows up the moment anyone rings a head: most of the loop
    // is empty space behind the model, and letting each of those points find
    // the ground on its own sends the ones near the horizon kilometres away.
    const middle = world(slab()).project(PARTS[0].centre);
    const wide = ring({ x: middle.x, y: middle.y, r: 150 });
    const mark = resolveStroke(wide, world(slab()), PARTS)!;
    for (const point of mark.worldPoints)
      expect(new T.Vector3(...point).distanceTo(cam.position)).toBeLessThan(12);
  });

  test('a loop round nothing encloses nothing, and is still a mark', () => {
    const mark = resolveStroke(ring({ x: 700, y: 520, r: 30 }), world(() => null), PARTS)!;
    expect(mark.gesture).toBe('circle');
    expect(mark.parts).toEqual([]);
    // Resolved onto the ground, so it is still somewhere the agent can read.
    for (const point of mark.worldPoints) expect(point[1]).toBeCloseTo(0, 2);
  });

  test('an arrow names what its tip landed on, not what it flew over', () => {
    const w = world(slab([1]));
    const tip = w.project([0, 1, 0]);
    const mark = resolveStroke(line({ x: 60, y: 80 }, tip), w, PARTS)!;
    expect(mark.gesture).toBe('arrow');
    expect(mark.parts.map((p) => p.path)).toEqual([[1]]);
    // The last point is the thing being pointed at, which is what makes the
    // direction readable without the pixels.
    const last = mark.worldPoints[mark.worldPoints.length - 1];
    expect(last[0]).toBeCloseTo(0, 1);
    expect(last[1]).toBeCloseTo(1, 1);
  });

  test('a sketch is drawn on a plane facing the camera, near the nearest part', () => {
    const stroke = Array.from({ length: 24 }, (_, i) => ({
      x: 620 + i * 4,
      y: 140 + Math.sin(i / 3) * 40,
    }));
    const mark = resolveStroke(stroke, world(() => null), PARTS)!;
    expect(mark.gesture).toBe('sketch');
    // Named after what it was drawn beside, and drawn at that thing's depth —
    // not on the ground, which under a stroke aimed beside a model's shoulder
    // is metres behind it and would make the sketch metres wide.
    expect(mark.parts.map((p) => p.name)).toEqual(['head']);
    for (const point of mark.worldPoints)
      expect(new T.Vector3(...point).distanceTo(new T.Vector3(0, 2.4, 0))).toBeLessThan(3);
    // One plane: every point the same distance along the camera's forward
    // axis, which is what keeps a sketch the shape it was drawn as.
    const forward = new T.Vector3();
    cam.getWorldDirection(forward);
    const depths = mark.worldPoints.map((p) =>
      new T.Vector3(...p).sub(cam.position).dot(forward),
    );
    for (const depth of depths) expect(depth).toBeCloseTo(depths[0], 2);
  });

  test('a click that drifted is not a gesture', () => {
    expect(resolveStroke(line({ x: 100, y: 100 }, { x: 103, y: 101 }, 4), world(slab()), PARTS))
      .toBeNull();
  });
});

// ── The trip to disk ────────────────────────────────────────────────────

const mark: Mark = {
  gesture: 'circle',
  parts: [
    { path: [0, 2], name: 'helmet' },
    { path: [0, 3], name: 'visor' },
  ],
  worldPoints: [
    [0, 1.2, 0.3],
    [0.2, 1.4, 0.3],
    [-0.2, 1.4, 0.3],
  ],
  cameraPose: { position: [0, 1.5, 4], target: [0, 1.2, 0], fov: 45 },
};

describe('the note a mark becomes', () => {
  test('an unlabelled mark still says something a reader can act on', () => {
    const note = markNote({ id: 'n1', mark, text: '   ', at: '2026-09-19T00:00:00.000Z' });
    expect(note.text).toBe('circle around helmet, visor');
    // And it points at a part, so every reader that predates marks — the
    // outliner badge, the panel's Select button — still works on it.
    expect(note.part).toEqual([0, 2]);
    expect(note.partName).toBe('helmet');
  });

  test('a label the reviewer typed wins', () => {
    expect(markNote({ id: 'n1', mark, text: 'make this bigger', at: 'x' }).text).toBe(
      'make this bigger',
    );
  });

  test('a sketch describes itself by where it is and how big it is', () => {
    expect(
      describeMark({ ...mark, gesture: 'sketch', parts: [{ path: [1], name: 'torso' }] }),
    ).toBe('sketch near torso at (0, 1.2, 0.3) with 3 world points');
  });

  test('only open marks are drawn: resolving one puts the scribble away', () => {
    const open = markNote({ id: 'a', mark, text: 'wider', at: 'x' });
    const done = { ...markNote({ id: 'b', mark, text: 'done', at: 'x' }), status: 'resolved' as const };
    const typed = newNote({ id: 'c', part: null, partName: null, text: 'typed', at: 'x' });
    expect(drawnMarks([open, done, typed]).map((m) => m.id)).toEqual(['a']);
  });
});

describe('the schema', () => {
  test('a note with a mark round-trips', () => {
    const note = noteSchema.parse(
      markNote({ id: 'n1', mark, text: 'bigger', at: '2026-09-19T00:00:00.000Z' }),
    );
    expect(note.mark).toEqual(mark);
  });

  test('a note without one is still valid', () => {
    const note = noteSchema.parse(
      newNote({ id: 'n2', part: [0], partName: 'body', text: 'floats', at: 'x' }),
    );
    expect(note.mark).toBeUndefined();
  });

  test('an unbounded stroke is refused rather than written', () => {
    const points = Array.from({ length: MAX_POINTS + 1 }, (): Vec3 => [0, 0, 0]);
    expect(markSchema.safeParse({ ...mark, worldPoints: points }).success).toBe(false);
    expect(markSchema.safeParse({ ...mark, gesture: 'doodle' }).success).toBe(false);
  });

  test('written and read back off disk unchanged', async () => {
    const spec = join(scratch, 'drawn.spec.json');
    await saveNotes(spec, addNote({ version: 1, spec, notes: [] }, { text: 'bigger', mark }));
    const back = await loadNotes(spec);
    expect(back.notes[0].mark).toEqual(mark);
  });
});

// ── The route the studio writes through ─────────────────────────────────

type FakeRequest = EventEmitter & { method: string; url?: string; originalUrl?: string; headers?: Record<string, string>; setEncoding(): void };
type Handler = (request: FakeRequest, response: FakeResponse) => Promise<void>;

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  setHeader(k: string, v: string) { this.headers[k] = v; }
  end(chunk?: string) { this.body = chunk ?? ''; }
}

const handlers = new Map<string, Handler>();
let scratch: string;

/** Run the notes middleware the way Vite would. */
async function call(
  { method = 'GET', url, body }: { method?: string; url?: string; body?: unknown } = {},
) {
  const handler = handlers.get(NOTES_ROUTE)!;
  const request = Object.assign(new EventEmitter(), {
    method,
    url: url ?? '/',
    originalUrl: url ? `${NOTES_ROUTE}${url}` : NOTES_ROUTE,
    headers: {},
    setEncoding() {},
  }) as FakeRequest;
  const response = new FakeResponse();
  const done = handler(request, response);
  if (body !== undefined) {
    request.emit('data', JSON.stringify(body));
    request.emit('end');
  }
  await done;
  return { status: response.statusCode, json: JSON.parse(response.body || 'null') };
}

beforeAll(async () => {
  const plugin = oddlingsStudioApi();
  (plugin.configureServer as (s: unknown) => void)({
    middlewares: { use: (route: string, fn: Handler) => handlers.set(route, fn) },
  });
  // Inside the project, because the endpoint refuses to write anywhere else.
  scratch = await mkdtemp(join(process.cwd(), 'specs', 'drafts', 'draw-test-'));
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('the notes route', () => {
  test('a drawn note survives a PUT and a GET', async () => {
    const path = relative(process.cwd(), join(scratch, 'drawn.spec.json'))
      .split(sep)
      .join('/');
    const note = markNote({ id: 'nd1', mark, text: 'make this bigger', at: '2026-09-19T00:00:00.000Z' });
    const put = await call({ method: 'PUT', body: { path, notes: [note] } });
    expect(put.status).toBe(200);
    const { json } = await call({ url: `?path=${encodeURIComponent(path)}` });
    expect((json as { notes: typeof note[] }).notes[0]).toEqual(note);
  });

  test('a stroke longer than the cap is refused at the door', async () => {
    const path = relative(process.cwd(), join(scratch, 'huge.spec.json'))
      .split(sep)
      .join('/');
    const huge = markNote({
      id: 'nd2',
      mark: {
        ...mark,
        worldPoints: Array.from({ length: MAX_POINTS + 5 }, (): Vec3 => [0, 0, 0]),
      },
      text: 'too much',
      at: 'x',
    });
    expect((await call({ method: 'PUT', body: { path, notes: [huge] } })).status).toBe(400);
  });
});


// ── The tool, and the surface it puts over the canvas ───────────────────

const withSpec = reducer(initialState, {
  type: 'commit',
  doc: {
    ...initialState.doc,
    spec: parseSpec(JSON.parse(readFileSync('specs/sniper-rifle.spec.json', 'utf8'))),
  },
});

describe('the Draw tool', () => {
  test('D turns it on and off, and only where there is a spec to draw on', () => {
    expect(commandFor('D', initialState)).toBeNull();
    const command = commandFor('D', withSpec)!;
    expect(command.id).toBe('tool.draw');
    const drawing = reducer(withSpec, { type: 'tool', tool: 'draw' });
    expect(drawing.tool).toBe('draw');
    // The same key is the way back out, which is what makes it a tool rather
    // than a trap.
    const context = { state: drawing, dispatch: (a: never) => actions.push(a) };
    const actions: unknown[] = [];
    COMMAND_BY_ID.get('tool.draw')!.run(context as never);
    expect(actions).toEqual([{ type: 'tool', tool: 'select' }]);
  });

  test('a document with no spec cannot be drawn on even by asking', () => {
    expect(reducer(initialState, { type: 'tool', tool: 'draw' }).tool).toBe('select');
  });

  test('no two enabled commands claim the same key', () => {
    // `D` is new; `Mod+D` was already Duplicate, and they are different chords.
    expect(keyConflicts(withSpec)).toEqual([]);
    expect(COMMANDS.filter((c) => c.keys?.includes('D')).map((c) => c.id)).toEqual([
      'tool.draw',
    ]);
  });
});

describe('the drawing surface', () => {
  const props = {
    resolve: () => null,
    onMark: () => {},
    onExit: () => {},
  };

  test('nothing is over the canvas while the tool is off', () => {
    expect(renderToStaticMarkup(h(DrawOverlay, { ...props, active: false }))).toBe('');
  });

  test('switched on, it says what the gestures are and how to leave', () => {
    const html = renderToStaticMarkup(h(DrawOverlay, { ...props, active: true }));
    expect(html).toContain('draw-surface');
    expect(html).toMatch(/Circle a part[\s\S]*cross one out[\s\S]*arrow[\s\S]*sketch/);
    expect(html).toContain('Esc to stop drawing');
  });
});
