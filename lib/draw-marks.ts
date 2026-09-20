/**
 * Strokes drawn over the model, resolved into something an agent can act on.
 *
 * The rest of the review loop is words: a note names a part and says what is
 * wrong with it. Words run out at exactly the point a reviewer wants to say
 * "this bit, here" — the part has no name yet, or it is half of one part and
 * half of another, or the correction is a shape rather than a property. So the
 * reviewer draws, and the drawing is resolved here, at capture time, while the
 * camera still says what the strokes were aimed at.
 *
 * Resolved into geometry rather than kept as pixels, because the agent on the
 * other end reads structured data and never sees the viewport. A circle
 * becomes a list of part paths; an arrow becomes a part plus a direction; a
 * sketch becomes a polyline in world metres. None of those need a picture.
 *
 * Everything here is either plain 2D arithmetic or a camera transform, and
 * nothing reaches for a renderer or the DOM — the viewport passes in one
 * function that says what a screen point hits, and that is the only part of
 * this that needs a model to exist.
 */
export type Vec3 = [number, number, number];
export type Point2 = { x: number; y: number };
export type Path = number[];

/**
 * What one stroke meant.
 *
 * Four, because they are the four things people actually do over a picture of
 * a model: ring something, cross something out, point at something, and draw
 * the thing that is missing.
 */
export type Gesture = 'circle' | 'remove' | 'arrow' | 'sketch';

export type MarkPart = { path: Path; name: string | null };

export type CameraPose = { position: Vec3; target: Vec3; fov: number };

/** One finished stroke, as it is stored on a note. */
export type Mark = {
  gesture: Gesture;
  /** What the stroke is about: enclosed, pointed at, or nearest. */
  parts: MarkPart[];
  /** The stroke in world metres, on the model, the ground, or the view plane. */
  worldPoints: Vec3[];
  /** Where it was drawn from, so the agent can picture what the reviewer saw. */
  cameraPose: CameraPose;
};

/**
 * A mark on screen: one stored mark, plus the note it belongs to.
 *
 * The id travels with it because a drawn line is a thing you click — and what
 * clicking it should open is the note, not the geometry.
 */
export type DrawnMark = Mark & { id: string };

/**
 * What the viewport lends this module: a camera and a way to hit the model.
 *
 * An interface rather than a three.js scene so the rules above can be checked
 * against a real camera and a stub model, which is the half of this that has
 * right and wrong answers.
 */
export type StrokeWorld = {
  /** A world point in element-local CSS pixels. */
  project: (at: Vec3) => Point2;
  /** Where a screen point meets the built model, or null where it misses. */
  hit: (at: Point2) => { point: Vec3; path: Path | null } | null;
  /** Where a screen point meets the ground, or null when it looks at the sky. */
  ground: (at: Point2) => Vec3 | null;
  /** A screen point on the camera-facing plane through `anchor`. */
  onPlane: (at: Point2, anchor: Vec3) => Vec3 | null;
  pose: () => CameraPose;
};

/** An authored part with a place in the world, for the enclosure test. */
export type PartCentre = { path: Path; name: string | null; centre: Vec3 };

/** How many points a stored stroke keeps. Enough for a shape, few enough to read. */
export const MAX_POINTS = 48;

/** Below this a stroke is a click that wandered, not a gesture. */
const MIN_POINTS = 3;
const MIN_LENGTH_PX = 12;

const round = (n: number) => Math.round(n * 1000) / 1000;
const tidy = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(points: Point2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function bounds(points: Point2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, diagonal: Math.hypot(maxX - minX, maxY - minY) };
}

/**
 * Drop points closer together than `step`, keeping the first and the last.
 *
 * A pointer reports sub-pixel drift and a trackpad reports it twice, so the
 * raw stroke has runs of points in the same place. Those runs are what make a
 * smooth arc look like it reverses direction, which is the difference between
 * "circle" and "scribble this out".
 */
export function thin(points: Point2[], step = 8): Point2[] {
  if (points.length < 2) return [...points];
  const out = [points[0]];
  for (const point of points.slice(1, -1))
    if (distance(out[out.length - 1], point) >= step) out.push(point);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * At most `max` points, evenly spaced along the stroke.
 *
 * Even along the arc rather than every nth point, so a slow corner and a fast
 * straight get the same share of what is stored — the corner is the part that
 * carries the shape.
 */
export function resample(points: Point2[], max = MAX_POINTS): Point2[] {
  if (points.length <= max) return [...points];
  const total = pathLength(points);
  if (total === 0) return [points[0], points[points.length - 1]];
  const step = total / (max - 1);
  const out: Point2[] = [points[0]];
  let walked = 0;
  let want = step;
  for (let i = 1; i < points.length; i++) {
    const span = distance(points[i - 1], points[i]);
    while (span > 0 && walked + span >= want && out.length < max - 1) {
      const t = (want - walked) / span;
      out.push({
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      });
      want += step;
    }
    walked += span;
  }
  out.push(points[points.length - 1]);
  return out;
}

/** True when the stroke comes back to where it started. */
export function closed(points: Point2[]): boolean {
  if (points.length < MIN_POINTS) return false;
  const span = bounds(points);
  // Proportional as well as absolute: a big loop is allowed a bigger gap,
  // because nobody lands within twenty pixels of the start of a gesture that
  // took up half the screen.
  const slack = Math.max(20, span.diagonal * 0.18);
  return distance(points[0], points[points.length - 1]) <= slack;
}

function crosses(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const side = (p: Point2, q: Point2, r: Point2) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(a, b, c), d2 = side(a, b, d);
  const d3 = side(c, d, a), d4 = side(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * How many times the stroke runs over itself.
 *
 * Neighbouring segments are skipped: they share an endpoint, and a shared
 * endpoint is not a crossing. One crossing is the overshoot at the end of an
 * ordinary hand-drawn loop; two or more is a cross through something.
 */
export function selfCrossings(points: Point2[]): number {
  let count = 0;
  for (let i = 0; i + 1 < points.length; i++)
    for (let j = i + 2; j + 1 < points.length; j++)
      if (crosses(points[i], points[i + 1], points[j], points[j + 1])) count++;
  return count;
}

/** Turns sharper than a right angle and a half: the corners of a zigzag. */
export function reversals(points: Point2[]): number {
  let count = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y;
    const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    if ((ax * bx + ay * by) / (la * lb) < Math.cos((135 * Math.PI) / 180)) count++;
  }
  return count;
}

/** 1 for a ruled line, towards 0 for a stroke that wanders. */
export function straightness(points: Point2[]): number {
  const total = pathLength(points);
  if (total === 0) return 1;
  return distance(points[0], points[points.length - 1]) / total;
}

/**
 * What a stroke means, from its shape and how much of it landed on the model.
 *
 * Order matters and is the whole rule, so it is written out rather than
 * scattered through conditions:
 *
 * 1. Crossed over itself twice, or turned back on itself three times — a
 *    cross or a zigzag. That is `remove` whether or not it also closes, which
 *    is what makes "ring it and score it out" one gesture rather than two.
 * 2. Ends where it began: `circle`.
 * 3. Open, straight, and finishing on the model: `arrow`, pointing at what it
 *    landed on.
 * 4. Open and mostly off the model: `sketch`, a thing that is not there yet.
 * 5. Anything left is an open scribble over the model: `remove`.
 *
 * One stroke is one mark. An X is two strokes and therefore two marks, which
 * is honest — merging them would mean guessing at how long to wait for the
 * second one, and guessing wrong in front of somebody who only drew one.
 */
export function classifyStroke(points: Point2[], hits: boolean[]): Gesture {
  const thinned = thin(points);
  const onModel = hits.filter(Boolean).length / Math.max(1, hits.length);
  const endsOnModel = hits[hits.length - 1] ?? false;
  if (selfCrossings(thinned) >= 2 || reversals(thinned) >= 3) return 'remove';
  if (closed(thinned)) return 'circle';
  if (endsOnModel && straightness(thinned) > 0.6) return 'arrow';
  if (onModel < 0.3) return 'sketch';
  return 'remove';
}

/** Even-odd ray casting. The polygon is the stroke, closed by its last segment. */
export function inPolygon(polygon: Point2[], at: Point2): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (
      a.y > at.y !== b.y > at.y &&
      at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** The middle of a stroke. The mean rather than the area centroid, which can
 *  fall outside a loop somebody drew round an L-shaped thing. */
export function centroid(points: Point2[]): Point2 {
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Part paths without repeats, in the order they were found. */
function dedupe(parts: MarkPart[]): MarkPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.path.join('.');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve one finished stroke against the model, now.
 *
 * "Now" is the point of it: the answer depends on where the camera is, and the
 * camera moves a second later. Everything the agent is told — which parts,
 * which world points, which pose — is fixed here and never recomputed, so a
 * note still means what it meant when it was drawn.
 *
 * Returns null for a stroke too short to be a gesture, which is what a click
 * that drifted looks like.
 */
export function resolveStroke(
  raw: Point2[],
  world: StrokeWorld,
  parts: PartCentre[] = [],
): Mark | null {
  const points = resample(thin(raw, 3), 160);
  if (points.length < MIN_POINTS || pathLength(points) < MIN_LENGTH_PX)
    return null;

  const hits = points.map((point) => world.hit(point));
  const gesture = classifyStroke(points, hits.map(Boolean));

  /**
   * Whether this stroke is about the model or about the space around it.
   *
   * The distinction decides where the parts that missed are put, and getting
   * it wrong is loud: a ring round a head is mostly sky, and dropping that sky
   * onto the ground plane sends the points that landed near the horizon four
   * kilometres away. A ring drawn on the floor, on the other hand, belongs on
   * the floor. So the stroke as a whole picks one surface, rather than each
   * point picking its own.
   */
  const touched = hits.some(Boolean);

  /** The part the stroke was drawn nearest to on screen, which is what "beside
   *  the torso" means to the person drawing it. */
  const beside = nearestOnScreen(points, parts, world);

  /**
   * Anchored to the first thing it actually touched.
   *
   * A sketch that touched nothing is anchored to the part it was drawn beside
   * instead of to the ground, because the ground under a stroke aimed at the
   * air beside a model's shoulder is metres behind it — and a shoulder plate
   * sketched on a plane ten metres away is a shoulder plate ten metres wide.
   * The part it is next to is the depth the reviewer was drawing at.
   */
  const anchor: Vec3 =
    hits.find((hit) => hit)?.point ??
    (gesture === 'sketch' ? beside?.centre : undefined) ??
    points.map((point) => world.ground(point)).find((p): p is Vec3 => Boolean(p)) ??
    world.pose().target;

  const kept = resample(points, MAX_POINTS);
  const worldPoints = kept
    .map((point) => {
      // A sketch is a thing that does not exist yet, so it is drawn on a plane
      // facing the camera rather than smeared over whatever happens to be
      // behind it — that is the shape the reviewer meant.
      if (gesture === 'sketch') return world.onPlane(point, anchor);
      const hit = world.hit(point)?.point;
      if (hit) return hit;
      return touched
        ? world.onPlane(point, anchor)
        : (world.ground(point) ?? world.onPlane(point, anchor));
    })
    .filter((point): point is Vec3 => Boolean(point))
    .map(tidy);
  if (worldPoints.length < 2) return null;

  return {
    gesture,
    parts: markParts(gesture, points, hits, parts, world, beside),
    worldPoints,
    cameraPose: posed(world.pose()),
  };
}

function posed(pose: CameraPose): CameraPose {
  return {
    position: tidy(pose.position),
    target: tidy(pose.target),
    fov: round(pose.fov),
  };
}

/**
 * Which parts one gesture is about.
 *
 * A ring means everything inside it, by the projected centre of each part —
 * plus whatever sits under the middle of the ring, because a loop drawn round
 * one big part encloses no centre at all when that centre is off screen.
 * An arrow means the one thing its tip landed on. A sketch means the part it
 * was drawn next to, which is the only way to say where a new thing goes.
 */
/** The part whose centre is drawn closest to the middle of the stroke. */
function nearestOnScreen(
  points: Point2[],
  parts: PartCentre[],
  world: StrokeWorld,
): PartCentre | null {
  const middle = centroid(points);
  let best: { part: PartCentre; away: number } | null = null;
  for (const part of parts) {
    const at = world.project(part.centre);
    const away = Math.hypot(at.x - middle.x, at.y - middle.y);
    if (!best || away < best.away) best = { part, away };
  }
  return best?.part ?? null;
}

function markParts(
  gesture: Gesture,
  points: Point2[],
  hits: ({ point: Vec3; path: Path | null } | null)[],
  parts: PartCentre[],
  world: StrokeWorld,
  beside: PartCentre | null,
): MarkPart[] {
  const named = (path: Path): MarkPart => ({
    path: [...path],
    name: parts.find((part) => part.path.join('.') === path.join('.'))?.name ?? null,
  });

  if (gesture === 'arrow') {
    const tip = [...hits].reverse().find((hit) => hit?.path);
    return tip?.path ? [named(tip.path)] : [];
  }

  // A sketch is about somewhere rather than something, so it names the part it
  // was drawn beside — on screen, which is the only place the reviewer was
  // judging "beside" from.
  if (gesture === 'sketch') return beside ? [named(beside.path)] : [];

  const inside = parts
    .filter((part) => inPolygon(points, world.project(part.centre)))
    .map((part) => named(part.path));
  // What is under the middle of the loop leads, because `parts[0]` is what the
  // note pins itself to — and a ring round a head should pin to the head, not
  // to whichever enclosed part the spec happens to list first.
  const middle = world.hit(centroid(points));
  return dedupe(middle?.path ? [named(middle.path), ...inside] : inside);
}

const NAMES: Record<Gesture, string> = {
  circle: 'circle around',
  remove: 'crossed out',
  arrow: 'arrow pointing at',
  sketch: 'sketch near',
};

/**
 * One line saying what a mark is, for anywhere a person or an agent reads it
 * without the viewport: the notes list, the CLI, the MCP payload, and the text
 * of a mark the reviewer drew and did not bother to label.
 */
export function describeMark(mark: Mark): string {
  const parts = mark.parts
    .map((part) => part.name ?? part.path.join('.'))
    .join(', ');
  const where = parts || 'nothing in particular';
  if (mark.gesture === 'sketch') {
    const at = mark.worldPoints[0];
    return `sketch near ${where} at (${at.join(', ')}) with ${mark.worldPoints.length} world points`;
  }
  return `${NAMES[mark.gesture]} ${where}`;
}
