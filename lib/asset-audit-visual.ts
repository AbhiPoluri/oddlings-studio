import * as T from 'three';
import { type AssetSpec } from './asset-spec';
import { type Finding } from './asset-audit';
import { flatten } from './spec-edit';
import {
  AXIS_VIEWS,
  DEFAULT_VIEWS,
  renderModel,
  type Render,
  type ViewName,
} from './asset-render';

/**
 * The checks that only a picture can make, expressed as numbers.
 *
 * The geometry audit answers questions about where things are. It cannot
 * answer whether the thing reads: a belt the same blue as the robe under it is
 * placed perfectly and still invisible, and a lantern sunk inside a hull is
 * six hundred triangles of nothing. Those are the notes a human leaves after
 * looking at a screenshot, and they are the reason an agent takes six rounds
 * of screenshots to finish an asset.
 *
 * So: rasterise the model (see `asset-render`) and read the pixel buffers back
 * instead of the image. Three numbers come out — how much of the frame the
 * silhouette fills, how different two touching parts look along the border
 * they share, and how many triangles no camera can see — and the second and
 * third are worth a finding. The first is reported as a number and nothing
 * else, because "this model is small in its own frame" is a statement about
 * the framing, not about the model.
 */

export type VisualOptions = {
  /** Frame edge for the views the findings are read off. Default 384. */
  size?: number;
  /** Which angles to judge contrast and silhouette from. */
  views?: ViewName[];
  /** Part paths to readable names, as `auditModel` takes them. */
  labels?: Map<string, string>;
  /**
   * How different two parts have to look along their shared border, as CIE76
   * ΔE. Ten is about where a glance stops separating two flat colours.
   */
  contrast?: number;
  /**
   * How many border pixels a pair needs before it is worth reporting. A
   * corner that grazes another part shares four pixels with it, and no author
   * wants a warning about four pixels.
   */
  minBorder?: number;
  /**
   * How much of what the model shows in a view the SMALLER of the two parts
   * has to cover, as a fraction. A fingernail reading as part of the finger
   * is not a defect; a sleeve reading as part of the robe is.
   */
  minArea?: number;
  /** How many pairs to warn about. The rest are counted, not listed. */
  most?: number;
};

export type SilhouetteReading = { view: ViewName; fill: number };

export type ContrastReading = {
  a: string;
  b: string;
  view: ViewName;
  /** Border pixels the two parts share in that view. */
  border: number;
  /** Mean CIE76 ΔE across that border. */
  distance: number;
  /** Pixels the smaller of the two covers, as a fraction of the silhouette. */
  smaller: number;
};

export type UnseenReading = {
  triangles: number;
  total: number;
  share: number;
  parts: { part: string; triangles: number; share: number }[];
};

export type VisualAudit = {
  findings: Finding[];
  silhouette: SilhouetteReading[];
  contrast: ContrastReading[];
  unseen: UnseenReading;
  /** The angles the numbers were read from, and the frame size. */
  views: ViewName[];
  size: number;
  ms: number;
};

/** How an art note names the angle. */
function viewWords(view: ViewName) {
  return view === 'front'
    ? 'from the front'
    : view === 'back'
      ? 'from behind'
      : view === 'side'
        ? 'from the side'
        : view === 'left'
          ? 'from the left'
          : view === 'top'
            ? 'from above'
            : view === 'bottom'
              ? 'from below'
              : 'from three-quarters';
}

/** One sRGB byte to linear. */
function toLinear(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function pivot(t: number) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t + 16 / 116;
}

/**
 * sRGB bytes to CIE L*a*b*, D65.
 *
 * Lab rather than a plain RGB distance because the question is whether an eye
 * separates the two, and RGB says a dark blue and a dark green are as far
 * apart as a light one and a light one. ΔE is the number that matches the
 * judgement being made.
 */
function toLab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r),
    lg = toLinear(g),
    lb = toLinear(b);
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const fx = pivot(x),
    fy = pivot(y),
    fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Readable numbers: three decimals is past where anyone is still reading. */
function round(n: number, places = 3) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Walk the pixel borders of one view and total the colour difference across
 * each pair of parts that touch.
 *
 * Right and down neighbours only: every adjacency is visited once that way,
 * and visiting it twice would double both halves of the mean and change
 * nothing.
 */
function bordersOf(
  view: Render['views'][number],
  parts: number,
  labs: Map<number, [number, number, number]>,
) {
  const pairs = new Map<string, { a: number; b: number; n: number; sum: number }>();
  const area = new Int32Array(parts);
  let covered = 0;
  const { size, part, rgba } = view;
  const labAt = (at: number) => {
    const packed =
      (rgba[at * 4] << 16) | (rgba[at * 4 + 1] << 8) | rgba[at * 4 + 2];
    let lab = labs.get(packed);
    if (!lab) {
      lab = toLab(rgba[at * 4], rgba[at * 4 + 1], rgba[at * 4 + 2]);
      labs.set(packed, lab);
    }
    return lab;
  };
  const add = (here: number, there: number) => {
    const a = part[here],
      b = part[there];
    if (a < 0 || b < 0 || a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const entry = pairs.get(key) ?? {
      a: Math.min(a, b),
      b: Math.max(a, b),
      n: 0,
      sum: 0,
    };
    const one = labAt(here),
      two = labAt(there);
    entry.n++;
    entry.sum += Math.hypot(one[0] - two[0], one[1] - two[1], one[2] - two[2]);
    pairs.set(key, entry);
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      if (part[at] >= 0) {
        area[part[at]]++;
        covered++;
      }
      if (x + 1 < size) add(at, at + 1);
      if (y + 1 < size) add(at, at + size);
    }
  return { pairs, area, covered };
}

/**
 * Render the model and read the findings a picture carries.
 *
 * `spec` is optional and used for nothing but names: without it the findings
 * say `0.3.1` where they could say "lantern". Pass it whenever there is one.
 */
export function auditVisual(
  model: T.Object3D,
  spec?: AssetSpec,
  options: VisualOptions = {},
): VisualAudit {
  const started = Date.now();
  const size = options.size ?? 384;
  const views = options.views?.length ? options.views : DEFAULT_VIEWS;
  const labels =
    options.labels ??
    (spec
      ? new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        )
      : undefined);
  const threshold = options.contrast ?? 10;
  const minBorder = options.minBorder ?? Math.max(12, Math.round(size * 0.04));
  const minArea = options.minArea ?? 0.01;
  const most = options.most ?? 5;

  const render = renderModel(model, { size, views });
  const name = (key: string) => labels?.get(key) ?? key;
  const findings: Finding[] = [];

  // --- silhouette -------------------------------------------------------
  const silhouette: SilhouetteReading[] = render.views.map((view) => ({
    view: view.view,
    fill: round(view.fill),
  }));
  findings.push({
    severity: 'info',
    code: 'silhouette',
    value: Math.min(...silhouette.map((s) => s.fill)),
    message: `Silhouette fills ${silhouette
      .map((s) => `${(s.fill * 100).toFixed(0)}% ${s.view}`)
      .join(' · ')} of the frame it is framed into.`,
  });

  // --- contrast between touching parts ----------------------------------
  const labs = new Map<number, [number, number, number]>();
  const contrast: ContrastReading[] = [];
  for (const view of render.views) {
    const { pairs, area, covered } = bordersOf(view, render.parts.length, labs);
    for (const entry of pairs.values()) {
      if (entry.n < minBorder) continue;
      contrast.push({
        a: name(render.parts[entry.a].key),
        b: name(render.parts[entry.b].key),
        view: view.view,
        border: entry.n,
        distance: round(entry.sum / entry.n, 2),
        smaller: covered
          ? round(Math.min(area[entry.a], area[entry.b]) / covered)
          : 0,
      });
    }
  }
  // One finding a pair, not one a pair a view: a belt that vanishes into the
  // robe vanishes from every angle, and saying so four times trains the reader
  // to skim. The angle named is the one that shows the most of the border.
  const worst = new Map<string, ContrastReading>();
  for (const reading of contrast) {
    // A fingernail that matches the finger is not a note anyone acts on, and
    // a model has dozens of those. The pairs worth a warning are the ones
    // where a shape large enough to be read is not being read.
    if (reading.distance >= threshold || reading.smaller < minArea) continue;
    const key = `${reading.a} ${reading.b}`;
    const held = worst.get(key);
    if (!held || reading.border > held.border) worst.set(key, reading);
  }
  const flagged = [...worst.values()].sort(
    (one, two) => two.border - one.border,
  );
  for (const reading of flagged.slice(0, most)) {
    const pair = render.parts.find((p) => name(p.key) === reading.a);
    findings.push({
      severity: 'warn',
      code: 'low-contrast',
      ...(pair?.path ? { part: pair.path } : {}),
      value: reading.distance,
      threshold,
      message: `"${reading.a}" and "${reading.b}" read as one shape ${viewWords(
        reading.view,
      )} — they meet along ${reading.border} pixels and differ by ΔE ${reading.distance}. Change one of the two colours, or put a lip, a groove or a darker trim between them.`,
    });
  }
  // The tail is counted rather than listed. Twenty warnings is a report that
  // gets skipped whole, and the full table is on `contrast` for anyone who
  // wants it.
  if (flagged.length > most)
    findings.push({
      severity: 'info',
      code: 'low-contrast',
      value: flagged.length - most,
      threshold,
      message: `${flagged.length - most} further pairs also differ by less than ΔE ${threshold} along their border. The ${most} with the longest borders are above.`,
    });

  // --- triangles nobody can see -----------------------------------------
  // Measured against the six axis views, whatever was asked for above. Against
  // four, half of every closed solid is "unseen" — the far side of a box is
  // not waste, it is a box — and a number that is always fifty percent is a
  // number nobody reads.
  const seen = new Uint8Array(render.triangles);
  const extra = AXIS_VIEWS.filter((view) => !views.includes(view));
  const passes = extra.length
    ? [
        ...render.views,
        // Smaller, because occlusion is a coarse question: a triangle that
        // shows at all shows at 256, and the pass costs a tenth of the time.
        ...renderModel(model, { size: Math.min(size, 256), views: extra }).views,
      ]
    : render.views;
  for (const view of passes)
    for (let i = 0; i < view.triangle.length; i++) {
      const t = view.triangle[i];
      if (t >= 0) seen[t] = 1;
    }
  const unseenPerPart = new Int32Array(render.parts.length);
  let unseenTotal = 0;
  for (let t = 0; t < render.triangles; t++) {
    if (seen[t]) continue;
    unseenTotal++;
    const a = render.owners[t * 3],
      b = render.owners[t * 3 + 1],
      c = render.owners[t * 3 + 2];
    unseenPerPart[a]++;
    if (b !== a) unseenPerPart[b]++;
    if (c !== a && c !== b) unseenPerPart[c]++;
  }
  const ranked = render.parts
    .map((part, index) => ({
      part: name(part.key),
      triangles: unseenPerPart[index],
      share: part.triangles ? round(unseenPerPart[index] / part.triangles) : 0,
    }))
    // By share, not by count: a big part with its back turned is at the top of
    // a count and is not the problem. A part at 1.0 is one no camera reaches.
    .filter((row) => row.triangles > 0)
    .sort((one, two) => two.share - one.share || two.triangles - one.triangles)
    .slice(0, 5);
  const unseen: UnseenReading = {
    triangles: unseenTotal,
    total: render.triangles,
    share: render.triangles ? round(unseenTotal / render.triangles) : 0,
    parts: ranked,
  };
  const buried = ranked.filter((row) => row.share >= 0.99);
  findings.push({
    severity: 'info',
    code: 'unseen-triangles',
    value: unseen.share,
    message:
      `${unseenTotal.toLocaleString()} of ${render.triangles.toLocaleString()} triangles (${(
        unseen.share * 100
      ).toFixed(0)}%) show in none of the six axis views` +
      (ranked.length
        ? `. Worst: ${ranked
            .slice(0, 3)
            .map(
              (row) =>
                `"${row.part}" ${row.triangles} (${(row.share * 100).toFixed(0)}%)`,
            )
            .join(', ')}`
        : '') +
      (buried.length
        ? ` — ${buried
            .map((row) => `"${row.part}"`)
            .join(', ')} ${buried.length === 1 ? 'is' : 'are'} entirely inside something else, so ${
            buried.length === 1 ? 'it costs' : 'they cost'
          } triangles and shows nothing.`
        : '.'),
  });

  return {
    findings,
    silhouette,
    contrast,
    unseen,
    views,
    size,
    ms: Date.now() - started,
  };
}
