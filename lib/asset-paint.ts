/**
 * Painting a fused surface: crisp seams between parts, and per-part paint
 * expressions.
 *
 * A fused mesh carries colour per vertex, and the GPU interpolates it across
 * every triangle. Where a red part meets a blue one, the triangles that
 * straddle the boundary come out as a red-to-blue gradient one triangle
 * wide, which on a 9,000-triangle character is a centimetre of smudge along
 * every belt, cuff and eye. `cutSeams` removes that at the source: it finds
 * the exact curve where one part's field takes over from its neighbour's,
 * splits the straddling triangles along it, and gives each side its own
 * copies of the new vertices. Boundaries become curves that follow the parts,
 * not the triangles.
 *
 * `paintAt` is the second half: a part may carry a `paint` expression, the
 * colour twin of `field`, evaluated per vertex in the part's own unit box
 * with the same toolkit, so stripes, spots, gradients and grime are written
 * as code rather than as more parts.
 */
import * as T from 'three';
import { distanceTo, fieldTools, type FieldTools, type Prim } from './asset-sdf';
import { materialKey, materialOf } from './asset-uv';

/**
 * What a primitive claims at a point: its distance, negated for a subtractor
 * so that the boundary between an added part and a cut is where the two
 * distances cancel, which is where `ownerAt` hands the vertex over.
 */
function claim(prim: Prim, x: number, y: number, z: number) {
  const d = distanceTo(prim, x, y, z);
  return prim.subtract ? -d : d;
}

/**
 * The look of a primitive, for deciding whether a seam between two owners is
 * visible at all. Two parts of the same colour, material and paint share a
 * look, and a seam between them would add vertices for nothing.
 */
export function lookKeys(prims: Prim[]) {
  return prims.map(
    (prim) =>
      `${prim.color.getHex()}|${materialKey(materialOf(prim.material))}|${prim.paint ?? ''}`,
  );
}

export type Seamed = {
  positions: Float32Array;
  indices: Uint32Array;
  /** Colour owner per vertex. */
  owners: Uint16Array;
  /** Bone owner per vertex: the same on both copies of a seam vertex. */
  rigOwners: Uint16Array;
  /** How many vertices the seams added. */
  added: number;
};

/**
 * Split every triangle whose corners belong to two differently-looking parts
 * along the curve where ownership changes.
 *
 * On each crossing edge the switch point is found by linear interpolation of
 * the two claims, and two vertices are placed there: one for each side, so
 * each side's triangles carry one flat colour up to the seam. The point is
 * shared by the two triangles on that edge, so the seam stays watertight
 * geometrically even though its vertices are doubled — which is why the audit
 * welds by position before it counts shells. A triangle with three different
 * owners is left as it was: it happens where three parts meet at a point, and
 * a gradient over one such triangle is invisible.
 *
 * Seam vertices are bound to one bone on both copies, so a skinned mesh does
 * not tear along its own colour boundaries.
 */
export function cutSeams(
  positions: Float32Array,
  indices: Uint32Array,
  owners: Uint16Array,
  prims: Prim[],
): Seamed {
  const looks = lookKeys(prims);
  const pos: number[] = Array.from(positions);
  const own: number[] = Array.from(owners);
  const rig: number[] = Array.from(owners);
  const out: number[] = [];
  // edge key -> the two copies of the crossing point, by side owner.
  const cache = new Map<string, Map<number, number>>();
  let added = 0;

  const crossing = (p: number, q: number) => {
    const op = own[p],
      oq = own[q];
    const lo = Math.min(p, q),
      hi = Math.max(p, q);
    const key = `${lo}:${hi}`;
    let copies = cache.get(key);
    if (!copies) {
      const px = pos[p * 3],
        py = pos[p * 3 + 1],
        pz = pos[p * 3 + 2];
      const qx = pos[q * 3],
        qy = pos[q * 3 + 1],
        qz = pos[q * 3 + 2];
      const g0 = claim(prims[op], px, py, pz) - claim(prims[oq], px, py, pz);
      const g1 = claim(prims[op], qx, qy, qz) - claim(prims[oq], qx, qy, qz);
      let t = g0 - g1 !== 0 ? g0 / (g0 - g1) : 0.5;
      if (!Number.isFinite(t)) t = 0.5;
      t = Math.min(0.98, Math.max(0.02, t));
      const x = px + (qx - px) * t,
        y = py + (qy - py) * t,
        z = pz + (qz - pz) * t;
      copies = new Map();
      const bone = Math.min(op, oq);
      for (const side of [op, oq]) {
        const index = pos.length / 3;
        pos.push(x, y, z);
        own.push(side);
        rig.push(bone);
        copies.set(side, index);
        added++;
      }
      cache.set(key, copies);
    }
    return copies;
  };

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    const la = looks[own[a]],
      lb = looks[own[b]],
      lc = looks[own[c]];
    if (la === lb && lb === lc) {
      out.push(a, b, c);
      continue;
    }
    if (la !== lb && lb !== lc && la !== lc) {
      // Three parts meet inside this triangle. Cut all three edges — a
      // neighbour across any of them has cut it too, so leaving one whole
      // would open a T-junction — and give each corner its own triangle. The
      // middle triangle has a side of every colour and stays blended: it is
      // one triangle wide at a three-way point and reads as nothing.
      const vab = crossing(a, b),
        vbc = crossing(b, c),
        vca = crossing(c, a);
      out.push(a, vab.get(own[a])!, vca.get(own[a])!);
      out.push(b, vbc.get(own[b])!, vab.get(own[b])!);
      out.push(c, vca.get(own[c])!, vbc.get(own[c])!);
      out.push(vab.get(own[a])!, vbc.get(own[b])!, vca.get(own[c])!);
      continue;
    }
    // Rotate so that p is the lone corner and q, r share a look.
    let p = a,
      q = b,
      r = c;
    if (lb !== la && lb !== lc) {
      p = b;
      q = c;
      r = a;
    } else if (lc !== la && lc !== lb) {
      p = c;
      q = a;
      r = b;
    }
    const v1 = crossing(p, q);
    const v2 = crossing(p, r);
    const op = own[p];
    // The far side's copies are keyed by whichever owner sits at q and r; the
    // two may be different parts that share a look, in which case either copy
    // carries the same colour and the first is fine.
    const far = (copies: Map<number, number>) => {
      for (const [side, index] of copies) if (side !== op) return index;
      return copies.values().next().value as number;
    };
    out.push(p, v1.get(op)!, v2.get(op)!);
    out.push(far(v1), q, r);
    out.push(far(v1), r, far(v2));
  }

  if (!added)
    return { positions, indices, owners, rigOwners: owners, added: 0 };
  return {
    positions: Float32Array.from(pos),
    indices: Uint32Array.from(out),
    owners: Uint16Array.from(own),
    rigOwners: Uint16Array.from(rig),
    added,
  };
}

// ---------------------------------------------------------------------------
// Paint expressions

type PaintFn = (
  x: number,
  y: number,
  z: number,
  s: PaintTools,
  M: Math,
  base: [number, number, number],
  size: [number, number, number],
) => unknown;

/** A cell of a pattern: how far inside it we are, and which cell it is. */
export type Cell = {
  /** 0 in the groove between cells, 1 on a cell's face, smooth across the edge. */
  m: number;
  /** A stable 0..1 per cell, for per-brick and per-plank variation. */
  r: number;
};

/** The field toolkit plus colour and pattern helpers. */
export type PaintTools = FieldTools & {
  /** A hex colour as [r, g, b] in 0..1. */
  rgb: (hex: string) => [number, number, number];
  /** Blend two [r, g, b] colours. */
  blend: (
    a: [number, number, number],
    b: [number, number, number],
    t: number,
  ) => [number, number, number];
  /** Scale a colour's brightness. */
  shade: (c: [number, number, number], k: number) => [number, number, number];
  /** 0 at `lo` and below, 1 at `hi` and above, smooth between. */
  step: (lo: number, hi: number, v: number) => number;
  /** Running-bond courses: every other row offset by half a brick. */
  bricks: (x: number, y: number, size?: number, mortar?: number) => Cell;
  /** Boards running along x, `width` apart across y, split by a `gap`. */
  planks: (x: number, y: number, width?: number, gap?: number) => Cell;
  /** A square grid with grout between the squares. */
  tiles: (x: number, y: number, size?: number, grout?: number) => Cell;
  /** Overlapping rows of round scales, `m` falling off toward each rim. */
  scales: (x: number, y: number, size?: number) => Cell;
  /** 1 on a band of width `period * duty`, 0 between, smooth at the edges. */
  stripes: (v: number, period?: number, duty?: number) => number;
  /** Seeded dots: 1 at the centre of a speck, 0 away from one. */
  speckle: (
    x: number,
    y: number,
    z: number,
    scale?: number,
    density?: number,
  ) => number;
  /** 0..1 wear, high where a noisy edge or cavity would collect it. */
  worn: (
    x: number,
    y: number,
    z: number,
    scale?: number,
    amount?: number,
  ) => number;
};

/** A stable 0..1 from three integers. Cheap, seeded, no allocation. */
function hash3(a: number, b: number, c: number, seed: number) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + seed * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

const paintToolsBySeed = new Map<number, PaintTools>();
export function paintTools(seed: number): PaintTools {
  const cached = paintToolsBySeed.get(seed);
  if (cached) return cached;
  const colour = new T.Color();
  const field = fieldTools(seed);
  const step = (lo: number, hi: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1e-9)));
    return t * t * (3 - 2 * t);
  };
  /**
   * One axis of a grid: how far the point is from the nearest groove, as a
   * 0..1 mask, plus the cell it landed in. `soft` is how wide the ramp at the
   * edge is, so a pattern reads as a bevel rather than as aliased steps when
   * a texel straddles the boundary.
   */
  const lane = (v: number, period: number, gap: number) => {
    const cell = Math.floor(v / period);
    const inside = v - cell * period;
    const half = gap / 2;
    const soft = Math.max(period * 0.02, gap * 0.35);
    const edge = Math.min(inside - half, period - half - inside);
    return { cell, m: step(0, soft, edge) };
  };
  const made: PaintTools = {
    ...field,
    rgb: (hex) => {
      colour.set(hex);
      return [colour.r, colour.g, colour.b];
    },
    blend: (a, b, t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ],
    shade: (c, k) => [c[0] * k, c[1] * k, c[2] * k],
    step,
    bricks: (x, y, size = 0.2, mortar = 0.02) => {
      const course = lane(y, size / 2, mortar);
      // Every other course slides half a brick along, which is what makes a
      // wall a wall rather than a grid of squares.
      const shifted = x + (course.cell % 2 === 0 ? 0 : size / 2);
      const along = lane(shifted, size, mortar);
      return {
        m: Math.min(course.m, along.m),
        r: hash3(along.cell, course.cell, 0, seed),
      };
    },
    planks: (x, y, width = 0.2, gap = 0.01) => {
      const across = lane(y, width, gap);
      // Boards end somewhere: a long seed-driven period along the board, so
      // two neighbours are not one endless plank.
      const along = lane(x + across.cell * 0.37, width * 9, gap);
      return {
        m: Math.min(across.m, along.m),
        r: hash3(across.cell, along.cell, 1, seed),
      };
    },
    tiles: (x, y, size = 0.15, grout = 0.01) => {
      const a = lane(x, size, grout);
      const b = lane(y, size, grout);
      return { m: Math.min(a.m, b.m), r: hash3(a.cell, b.cell, 2, seed) };
    },
    scales: (x, y, size = 0.06) => {
      const row = Math.floor(y / (size * 0.6));
      const shifted = x + (row % 2 === 0 ? 0 : size / 2);
      const column = Math.floor(shifted / size);
      const cx = shifted - (column + 0.5) * size;
      const cy = y - (row + 0.5) * size * 0.6;
      // A disc wider than its row spacing, so the rows overlap the way scales
      // and roof tiles do.
      const d = Math.hypot(cx / (size * 0.55), cy / (size * 0.5));
      return { m: 1 - step(0.55, 1, d), r: hash3(column, row, 3, seed) };
    },
    stripes: (v, period = 0.1, duty = 0.5) => {
      const inside = v - Math.floor(v / period) * period;
      const edge = Math.min(inside, period * duty - inside);
      return step(0, period * 0.04, edge);
    },
    speckle: (x, y, z, scale = 80, density = 0.4) => {
      const n = field.noise(x * scale, y * scale, z * scale);
      return step(0.5 - density * 0.5, 0.5, n * 0.5 + 0.5);
    },
    worn: (x, y, z, scale = 8, amount = 1) => {
      const n = field.fbm(x * scale, y * scale, z * scale, 4);
      const ridge = 1 - Math.abs(n) * 2.2;
      return Math.min(1, Math.max(0, ridge)) * amount;
    },
  };
  paintToolsBySeed.set(seed, made);
  return made;
}


const compiledPaint = new Map<string, PaintFn>();

/**
 * What one evaluation of a paint expression says about a point.
 *
 * A mutable record rather than a returned object: the atlas bake calls this a
 * million times, and a million short-lived objects is a second of garbage
 * collection for nothing.
 *
 * `roughness` and `metalness` are -1 where the expression said nothing about
 * them, which is how the bake tells "the author wants 0 here" from "the
 * author did not mention it, so the part's own tuple decides".
 */
export type PaintOut = {
  r: number;
  g: number;
  b: number;
  /** Height in metres, positive out of the surface. 0 unless asked for. */
  bump: number;
  roughness: number;
  metalness: number;
  /** Emissive colour at this point; all zero where nothing glows. */
  er: number;
  eg: number;
  eb: number;
  /**
   * Whether the paint said anything about emission. A paint that returns
   * `emissive: 0` means "dark here", which is not the same as a paint that
   * never mentioned it and leaves the material to glow evenly.
   */
  emissiveSet: boolean;
};

export function paintOut(): PaintOut {
  return { r: 0, g: 0, b: 0, bump: 0, roughness: -1, metalness: -1, er: 0, eg: 0, eb: 0, emissiveSet: false };
}

/**
 * Everything the bake needs to know about one part, as plain data.
 *
 * A `Prim` is a graph of three objects and cannot cross a worker boundary; the
 * atlas bake runs on the far side of one. This is the part reduced to what
 * paint actually reads — the frame it is evaluated in, the expression, the
 * seed its noise is drawn from, and the material tuple a texel falls back to —
 * so the record rides along on `geometry.userData` and is baked from either
 * side of the wire.
 */
export type PaintFrame = {
  color: [number, number, number];
  paint?: string;
  seed: number;
  /** World -> the part's unit box: three's sixteen column-major numbers. */
  inverse: number[];
  /** The part's metres along its own axes; also what divides the unit box. */
  stretch: [number, number, number];
  roughness: number;
  metalness: number;
  /** The part's own emissive colour, when its material has one. */
  emissive?: [number, number, number];
  /** Strength the emissive colour is authored at, for the material. */
  emissiveStrength: number;
};

const emissiveColour = new T.Color();

/** Reduce a primitive to the record above. */
export function frameOf(prim: Prim): PaintFrame {
  const tuple = materialOf(prim.material);
  let emissive: [number, number, number] | undefined;
  if (tuple.emissive) {
    emissiveColour.set(tuple.emissive);
    emissive = [emissiveColour.r, emissiveColour.g, emissiveColour.b];
  }
  return {
    color: [prim.color.r, prim.color.g, prim.color.b],
    ...(prim.paint ? { paint: prim.paint } : {}),
    seed: prim.seed,
    inverse: [...prim.inverse.elements],
    stretch: [...prim.stretch] as [number, number, number],
    roughness: tuple.roughness,
    metalness: tuple.metalness,
    ...(emissive ? { emissive } : {}),
    emissiveStrength: tuple.emissiveStrength,
  };
}

/** Every part of a fused mesh, in `surfaceOwners.index` order. */
export function framesOf(prims: Prim[]): PaintFrame[] {
  return prims.map(frameOf);
}

/**
 * Compile a `paint` expression, or say why it cannot be.
 *
 * Same contract as `field`: JavaScript over `x`, `y`, `z` in the part's unit
 * box, `s` for the toolkit, `M` for Math, `base` — the part's own colour as
 * [r, g, b] — and `size`, the part's metres along x, y and z, so a pattern can
 * be authored in world units. A bare expression is returned; a body with
 * `return` runs as is.
 *
 * It returns either a colour — an [r, g, b] array in 0..1 or a hex string — or
 * an object `{ color, bump, roughness, metalness, emissive }` whose extra
 * fields become the normal, metallic-roughness and emissive maps of the baked
 * atlas.
 */
export function compilePaint(paint: string): PaintFn {
  const cached = compiledPaint.get(paint);
  if (cached) return cached;
  const body = /\breturn\b/.test(paint) ? paint : `return (${paint});`;
  let fn: PaintFn;
  try {
    fn = new Function('x', 'y', 'z', 's', 'M', 'base', 'size', body) as PaintFn;
  } catch (error) {
    throw Error(`"paint" does not compile: ${(error as Error).message}`);
  }
  const probe = fn(0.1, 0.2, 0.3, paintTools(0), Math, [0.5, 0.5, 0.5], [1, 1, 1]);
  if (!isPaint(probe))
    throw Error(
      '"paint" must return a colour — an [r, g, b] array in 0..1 or a hex string — or an object { color, bump, roughness, metalness, emissive }, and returned ' +
        JSON.stringify(probe) +
        ' at (0.1, 0.2, 0.3).',
    );
  compiledPaint.set(paint, fn);
  return fn;
}

type PaintObject = {
  color?: unknown;
  bump?: unknown;
  roughness?: unknown;
  metalness?: unknown;
  emissive?: unknown;
};

function isColour(value: unknown): value is [number, number, number] | string {
  if (typeof value === 'string') return /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function isPaint(value: unknown): boolean {
  if (isColour(value)) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const object = value as PaintObject;
  if (object.color !== undefined && !isColour(object.color)) return false;
  for (const key of ['bump', 'roughness', 'metalness'] as const)
    if (object[key] !== undefined && typeof object[key] !== 'number') return false;
  if (
    object.emissive !== undefined &&
    typeof object.emissive !== 'number' &&
    !isColour(object.emissive)
  )
    return false;
  return true;
}

/**
 * Which channels an expression writes, found by asking it.
 *
 * The bake needs this before it starts: a normal map is three extra
 * evaluations per texel and is worth nothing for an expression that never
 * returns a `bump`. A branchy expression could in principle return a bump only
 * in one corner of the part, so it is probed at a spread of points rather than
 * at one, and a channel any of them mentions counts.
 */
export type PaintChannels = {
  bump: boolean;
  roughness: boolean;
  metalness: boolean;
  emissive: boolean;
};

const probedChannels = new Map<string, PaintChannels>();

const PROBES: [number, number, number][] = [
  [0, 0, 0],
  [0.31, -0.22, 0.17],
  [-0.4, 0.44, -0.36],
  [0.47, 0.13, -0.29],
  [-0.18, -0.47, 0.41],
  [0.09, 0.38, 0.48],
];

export function paintChannels(paint: string): PaintChannels {
  const cached = probedChannels.get(paint);
  if (cached) return cached;
  const fn = compilePaint(paint);
  const found: PaintChannels = {
    bump: false,
    roughness: false,
    metalness: false,
    emissive: false,
  };
  for (const [x, y, z] of PROBES) {
    let value: unknown;
    try {
      value = fn(x, y, z, paintTools(0), Math, [0.5, 0.5, 0.5], [1, 1, 1]);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      continue;
    const object = value as PaintObject;
    for (const key of ['bump', 'roughness', 'metalness', 'emissive'] as const)
      if (object[key] !== undefined) found[key] = true;
  }
  probedChannels.set(paint, found);
  return found;
}

/** Does this part draw anything a flat colour could not? */
export function framePaints(frame: PaintFrame): boolean {
  return Boolean(frame.paint);
}

const decoded = new T.Color();

function writeColour(
  value: [number, number, number] | string,
  out: PaintOut,
  at: 'rgb' | 'e',
) {
  let r: number, g: number, b: number;
  if (typeof value === 'string') {
    decoded.set(value);
    r = decoded.r;
    g = decoded.g;
    b = decoded.b;
  } else {
    r = value[0];
    g = value[1];
    b = value[2];
  }
  if (at === 'rgb') {
    out.r = r < 0 ? 0 : r > 1 ? 1 : r;
    out.g = g < 0 ? 0 : g > 1 ? 1 : g;
    out.b = b < 0 ? 0 : b > 1 ? 1 : b;
  } else {
    out.er = r < 0 ? 0 : r > 1 ? 1 : r;
    out.eg = g < 0 ? 0 : g > 1 ? 1 : g;
    out.eb = b < 0 ? 0 : b > 1 ? 1 : b;
  }
}

/**
 * Take a world-space point into the part's unit box.
 *
 * The same frame `field` uses, so a paint and a field on the same part agree
 * about where its top is. Written out against the sixteen numbers rather than
 * through `Vector3.applyMatrix4` because this runs once per texel per
 * finite-difference offset, which on a 1024 atlas is millions of calls.
 */
function toLocal(frame: PaintFrame, x: number, y: number, z: number) {
  const e = frame.inverse;
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  const k = w === 0 ? 1 : 1 / w;
  return [
    ((e[0] * x + e[4] * y + e[8] * z + e[12]) * k) / frame.stretch[0],
    ((e[1] * x + e[5] * y + e[9] * z + e[13]) * k) / frame.stretch[1],
    ((e[2] * x + e[6] * y + e[10] * z + e[14]) * k) / frame.stretch[2],
  ] as const;
}

/**
 * Evaluate one part's paint at a world-space point.
 *
 * Without an expression the answer is the part's colour and its material
 * tuple, which is what every unpainted part has always been. With one, the
 * point goes into the part's unit box and the expression decides; anything it
 * does not mention is left for the tuple to fill in.
 */
export function sampleFrame(
  frame: PaintFrame,
  x: number,
  y: number,
  z: number,
  out: PaintOut,
) {
  out.bump = 0;
  out.roughness = -1;
  out.metalness = -1;
  out.er = 0;
  out.eg = 0;
  out.eb = 0;
  out.emissiveSet = false;
  out.r = frame.color[0];
  out.g = frame.color[1];
  out.b = frame.color[2];
  if (!frame.paint) return;
  const [lx, ly, lz] = toLocal(frame, x, y, z);
  const value = compilePaint(frame.paint)(
    lx,
    ly,
    lz,
    paintTools(frame.seed),
    Math,
    frame.color,
    frame.stretch,
  );
  if (isColour(value)) {
    writeColour(value, out, 'rgb');
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const object = value as PaintObject;
  if (isColour(object.color)) writeColour(object.color, out, 'rgb');
  if (typeof object.bump === 'number' && Number.isFinite(object.bump))
    out.bump = object.bump;
  if (typeof object.roughness === 'number')
    out.roughness = Math.min(1, Math.max(0, object.roughness));
  if (typeof object.metalness === 'number')
    out.metalness = Math.min(1, Math.max(0, object.metalness));
  if (typeof object.emissive === 'number') {
    // A number scales the part's own emissive colour — the material decides
    // what colour it glows, the paint decides where. With no emissive on the
    // material it scales the colour the paint just wrote, so `emissive: 1` on
    // a bare part still glows rather than silently doing nothing.
    const k = Math.min(1, Math.max(0, object.emissive));
    const tint = frame.emissive ?? [out.r, out.g, out.b];
    out.er = tint[0] * k;
    out.eg = tint[1] * k;
    out.eb = tint[2] * k;
    out.emissiveSet = true;
  } else if (isColour(object.emissive)) {
    writeColour(object.emissive, out, 'e');
    out.emissiveSet = true;
  }
}

/** The height an expression reports at a point, in metres. Zero without one. */
export function bumpAt(
  frame: PaintFrame,
  x: number,
  y: number,
  z: number,
  out: PaintOut,
) {
  sampleFrame(frame, x, y, z, out);
  return out.bump;
}

const frames = new WeakMap<Prim, PaintFrame>();
const scratch = paintOut();

/**
 * The colour a primitive paints at a world-space point, written into the
 * vertex colour buffer.
 *
 * Vertex colours are the fallback the atlas replaces: an engine that samples
 * the baked texture gets the pattern at texel resolution, and one that only
 * reads COLOR_0 gets the same expression sampled where the vertices happen to
 * be. Both come out of `sampleFrame`, so they can never disagree about what
 * the expression means.
 */
export function paintAt(
  prim: Prim,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  at: number,
) {
  let frame = frames.get(prim);
  if (!frame) {
    frame = frameOf(prim);
    frames.set(prim, frame);
  }
  sampleFrame(frame, x, y, z, scratch);
  out[at] = scratch.r;
  out[at + 1] = scratch.g;
  out[at + 2] = scratch.b;
}
