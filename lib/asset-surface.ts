import * as T from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { planUv } from './asset-uv';
import { bump, mark, measure } from './perf';
import {
  canonicalExtent,
  distanceTo,
  noise3,
  primArgs,
  smin,
  type Prim,
  type PrimSource,
} from './asset-sdf';

/**
 * Surface mode: one continuous polygon mesh instead of stacked primitives.
 *
 * The faceted builder produces a kitbash — N closed solids pushed into each
 * other. That is fine to look at and wrong to ship: the buried faces cost
 * triangles nobody can see, there is no single surface to unwrap, and the
 * solids tear apart from each other the moment a skeleton bends them.
 *
 * Here the same primitives become a signed distance field instead of geometry.
 * They are blended with a smooth minimum, sampled on a grid, and turned back
 * into triangles with surface nets. What comes out is one manifold shell with
 * continuous topology across every joint, which is what a game engine wants.
 *
 * The authored spec does not change at all. Only the backend does.
 */

export type SurfaceSettings = {
  /** Blend radius in metres. 0 welds parts with a hard crease. */
  blend: number;
  /** Grid resolution along the model's longest axis. */
  detail: number;
  /** Triangle count to decimate down to. */
  budget: number;
  shading: 'flat' | 'smooth';
};

/** Knobs that change how a surface is built without changing what it is. */
export type SurfaceOptions = {
  /** Sample every grid point instead of walking blocks. Tests only. */
  brute?: boolean;
  /**
   * Plan the texture atlas. Only an export needs one, and a preview that skips
   * it is the same mesh with one fewer entry in `geometry.userData`.
   */
  uv?: boolean;
  /**
   * Called as the build moves between stages, so a worker can say what it is
   * doing while it holds its own thread for a second and a half.
   *
   * Deliberately coarse — four or five calls per build. Anything finer would
   * mean checking a clock inside the sampling loop, which is the loop this
   * whole file exists to keep tight.
   */
  onPhase?: (phase: BuildPhase) => void;
};

export type BuildPhase =
  | 'parts'
  | 'sampling'
  | 'meshing'
  | 'decimating'
  | 'painting'
  | 'skinning';

const ready = MeshoptSimplifier.ready;

/**
 * Load the decimator's WebAssembly module.
 *
 * `buildSpec` is synchronous — the editor recomputes the audit inside a memo,
 * and every test calls it directly — so surface mode cannot await anything.
 * Callers that might build a surface asset await this once at startup instead,
 * and a spec that asks for surface mode before it resolves fails loudly rather
 * than silently skipping decimation and producing a different mesh.
 */
export async function readySurface() {
  await ready;
  loaded = true;
}
let loaded = false;

/** Collect the analytic primitives behind a built model, in world space. */
export function primsOf(model: T.Object3D, fallback: T.Color): Prim[] {
  const prims: Prim[] = [];
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const source = object.userData.prim as PrimSource | undefined;
    if (!source) return;
    const material = object.material as T.MeshStandardMaterial;
    const prim = primFor(
      source,
      object.matrixWorld,
      material?.color ?? fallback,
      object.userData.rigPart as string | undefined,
      object.userData.specPath as number[] | undefined,
      prims.length,
    );
    if (prim) prims.push(prim);
  });
  return prims;
}

function primFor(
  source: PrimSource,
  matrix: T.Matrix4,
  color: T.Color,
  rigPart: string | undefined,
  specPath: number[] | undefined,
  index: number,
): Prim | null {
  const shape = source.shape;
  const jitter = source.jitter ?? 0;
  const seed = (index * 7919 + 104729) | 0;
  const box = new T.Box3();

  if (shape === 'limb') {
    const a = new T.Vector3(...(source.from ?? [0, 0, 0])).applyMatrix4(matrix);
    const b = new T.Vector3(...(source.to ?? [0, 1, 0])).applyMatrix4(matrix);
    const r1 = source.radius ?? 0.1;
    const r2 = r1 * (source.taper ?? 1);
    const pad = Math.max(r1, r2);
    // A bent limb sags outside the box its endpoints span, and `fieldAt`
    // culls on this box — so the control point has to be in it too.
    const via =
      source.via && new T.Vector3(...source.via).applyMatrix4(matrix);
    box.setFromPoints(via ? [a, via, b] : [a, b]).expandByScalar(pad);
    return {
      inverse: new T.Matrix4(),
      stretch: [1, 1, 1],
      lipschitz: 1,
      shape,
      // Round cone radii run from `from` to `to`, matching limbGeometry, which
      // puts the full radius at `from` and the tapered one at `to`.
      args: [r1, r2],
      segment: via
        ? [a.x, a.y, a.z, via.x, via.y, via.z, b.x, b.y, b.z]
        : [a.x, a.y, a.z, b.x, b.y, b.z],
      box,
      color: color.clone(),
      rigPart,
      specPath,
      jitter,
      seed,
    };
  }

  const size = source.size ?? [1, 1, 1];
  const extent = canonicalExtent(shape);
  const stretch: [number, number, number] = [
    Math.max(size[0] / extent[0], 1e-5),
    Math.max(size[1] / extent[1], 1e-5),
    Math.max(size[2] / extent[2], 1e-5),
  ];
  // A plane is authored flat; give the field a thickness it can actually
  // enclose, or marching the grid across it produces nothing at all.
  if (shape === 'plane') stretch[2] = Math.max(stretch[2], 0.02);

  const local = new T.Box3(
    new T.Vector3(-size[0] / 2, -size[1] / 2, -size[2] / 2),
    new T.Vector3(size[0] / 2, size[1] / 2, size[2] / 2),
  );
  if (shape === 'plane') local.expandByVector(new T.Vector3(0, 0, 0.02));
  box.copy(local).applyMatrix4(matrix);

  return {
    inverse: new T.Matrix4().copy(matrix).invert(),
    stretch,
    lipschitz: Math.min(stretch[0], stretch[1], stretch[2]),
    shape,
    args: primArgs(shape, source),
    box,
    color: color.clone(),
    rigPart,
    specPath,
    jitter,
    seed,
  };
}

/**
 * Field value at a world-space point: the smooth union of every primitive
 * whose influence reaches it.
 *
 * `candidates` is the pre-culled list for this region. Points outside every
 * primitive's padded box are outside the surface by construction, so the
 * caller can skip them entirely rather than evaluating an empty union.
 *
 * `pad` widens each primitive's own box by its blend reach. Culling on the
 * bare box instead would silently drop exactly the points between two parts —
 * the ones the blend exists to fill — and leave them looking detached.
 */
function fieldAt(
  candidates: Prim[],
  x: number,
  y: number,
  z: number,
  blend: number,
  pad: number,
) {
  let d = 1;
  let first = true;
  for (let i = 0; i < candidates.length; i++) {
    const prim = candidates[i];
    const b = prim.box;
    if (
      x < b.min.x - pad ||
      x > b.max.x + pad ||
      y < b.min.y - pad ||
      y > b.max.y + pad ||
      z < b.min.z - pad ||
      z > b.max.z + pad
    )
      continue;
    let di = distanceTo(prim, x, y, z);
    if (prim.jitter)
      di +=
        noise3(x * 11, y * 11, z * 11, prim.seed) *
        prim.jitter *
        0.06 *
        Math.max(0.01, prim.lipschitz);
    d = first ? di : smin(d, di, blend);
    first = false;
  }
  return first ? 1 : d;
}

/**
 * The primitive nearest a point, used to colour and bind the finished mesh.
 *
 * Linear over every primitive, and run once per finished vertex. That is cheap
 * at a few thousand vertices against a few dozen parts; a spec with thousands
 * of scattered copies and a large budget would want a spatial index here.
 */
function nearestPrim(prims: Prim[], x: number, y: number, z: number) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < prims.length; i++) {
    const d = distanceTo(prims[i], x, y, z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Which blocks of the grid can possibly hold a piece of surface.
 *
 * One entry per block of `size` cells on a side. `neg` and `pos` say whether
 * the block's own grid points held a negative and a non-negative value; the
 * extractor ORs a block with its far neighbours before deciding, because a
 * sign change can fall on the seam between two blocks that are each uniform.
 */
type Blocks = {
  size: number;
  bx: number;
  by: number;
  bz: number;
  neg: Uint8Array;
  pos: Uint8Array;
};

export type Grid = {
  origin: T.Vector3;
  step: number;
  nx: number;
  ny: number;
  nz: number;
  values: Float32Array;
  /** Absent on the brute-force path, which scans every cell. */
  blocks?: Blocks;
};

/**
 * Fine cells per block, per axis.
 *
 * Eight is where the two costs cross for the specs in this project. Smaller
 * blocks reject more of the volume but pay the per-block setup more often;
 * larger ones make the radius `R` below — and so the distance a block has to
 * keep from the surface before it can be rejected — grow linearly, until
 * nothing near the model qualifies.
 */
const BLOCK = 8;

/**
 * Cells per side of the map the extractor reads.
 *
 * Finer than the walk's own blocks on purpose. Rejecting a region is cheapest
 * in big bites, but the extractor pays for every cell in a block it cannot
 * skip, and a block is unskippable as soon as one corner of it touches the
 * surface — so the two want opposite sizes. Four is the smallest that still
 * keeps the map itself small next to the grid.
 */
const FLAG = 4;

/** What `descend` reports upward: which signs its run actually contains. */
const NEG = 1;
const POS = 2;

/**
 * How far the jitter can move one primitive's field, in metres.
 *
 * `noise3` returns [-1, 1] and `fieldAt` scales it by exactly this, so a
 * jittered distance is within `amplitude` of the plain one at every point.
 * That is all the block test needs: bounding the noise's slope would need its
 * Lipschitz constant, which at frequency 11 is far worse than its amplitude.
 */
function amplitude(prim: Prim) {
  return prim.jitter
    ? Math.abs(prim.jitter) * 0.06 * Math.max(0.01, prim.lipschitz)
    : 0;
}

/**
 * The factor by which a primitive's distance can outrun true distance.
 *
 * Every shape here is written to be 1-Lipschitz — `asset-sdf` says so, and
 * `tests/surface.test.ts` measures it — so this is 1 for all of them today.
 * It exists so that a shape that turns out not to be gets a one-line fix
 * instead of a silently wrong block test.
 */
function slope(_prim: Prim) {
  return 1;
}

/**
 * Sample the field on a regular grid.
 *
 * The grid is padded by one voxel plus the blend radius so the surface never
 * touches the boundary; a shell clipped by the grid edge is not closed, and an
 * open shell is exactly the defect this whole mode exists to remove.
 *
 * Hierarchical: the grid is walked a block of 8³ cells at a time, and most
 * blocks are settled by a single sample at the block's centre instead of 512.
 * At detail 320 the model occupies a thin shell of a 33-million-point volume,
 * so almost every block is entirely inside or entirely outside the shape.
 *
 * The rejection is exact, not approximate. Write `E` for the block's grid
 * points grown by one cell on every face — one cell, because the extractor
 * only ever reads a skipped point against its immediate neighbours — `c` for
 * the centre of `E`, `R` for its half-diagonal, and `S` for the primitives
 * whose padded box meets `E`, which is a superset of the candidates `fieldAt`
 * would consider at any point of `E`. With `D_i` the plain distance from `c`
 * to primitive `i`, `A_i` its jitter amplitude and `k` the blend radius:
 *
 *   outside, f > 0 on all of E, if   min_i (D_i − R − A_i) − (|S| − 1)·k/4 > 0
 *   inside,  f < 0 on all of E, if   some i has E inside its padded box
 *                                    and D_i + R + A_i < 0
 *
 * The first holds because each `d_i` is 1-Lipschitz, so `d_i ≥ D_i − R` on
 * `E`, the jitter moves it by at most `A_i`, and every `smin` in the fold can
 * depress the running value by at most `k/4` — which compounds, once per
 * blend, hence the `|S| − 1`. The second holds because `smin(a, b, k) ≤
 * min(a, b)`, so one primitive that is certainly a candidate and certainly
 * negative across `E` caps the whole union below zero.
 *
 * A rejected block gets a constant of the right sign, not the true distance.
 * That is enough because `surfaceNets` reads a value's magnitude only when it
 * interpolates across a sign change, and by construction there is none within
 * one cell of a rejected block. Every block that fails both tests is sampled
 * exactly as the brute-force path would, point for point, in the same
 * coordinates, through the same `fieldAt` — so the mesh is unchanged.
 */
export function sampleGrid(
  prims: Prim[],
  settings: SurfaceSettings,
  options: SurfaceOptions = {},
): Grid {
  const bounds = new T.Box3();
  for (const prim of prims) bounds.union(prim.box);
  const span = bounds.getSize(new T.Vector3());
  const longest = Math.max(span.x, span.y, span.z, 1e-3);
  const step = longest / Math.max(8, settings.detail);
  const pad = settings.blend + step * 2;
  bounds.expandByScalar(pad);

  const size = bounds.getSize(new T.Vector3());
  const nx = Math.ceil(size.x / step) + 1;
  const ny = Math.ceil(size.y / step) + 1;
  const nz = Math.ceil(size.z / step) + 1;
  const values = new Float32Array(nx * ny * nz).fill(1);

  // Primitives influence the field out to `blend` past their own surface.
  const reach = settings.blend + step;

  if (options.brute) {
    const padded = prims.map((prim) => ({
      prim,
      box: prim.box.clone().expandByScalar(reach),
    }));
    bruteSample(padded, values, bounds.min, step, nx, ny, nz, settings, reach);
    return { origin: bounds.min, step, nx, ny, nz, values };
  }
  // Cached on the primitive rather than in a parallel array: the recursion
  // below passes primitive lists down, and a list of pairs would allocate a
  // wrapper per level per block.
  for (const prim of prims) prim.padded = prim.box.clone().expandByScalar(reach);

  const bx = Math.ceil(nx / FLAG);
  const by = Math.ceil(ny / FLAG);
  const bz = Math.ceil(nz / FLAG);
  const neg = new Uint8Array(bx * by * bz);
  const pos = new Uint8Array(bx * by * bz);
  const blend = settings.blend;
  const quarter = blend * 0.25;
  const origin = bounds.min;
  const region = new T.Box3();
  const centre = new T.Vector3();
  /**
   * One scratch candidate list per level of the walk, reused across blocks.
   *
   * The recursion runs a few hundred thousand times on a detailed spec and
   * each level narrows its parent's list; allocating that array fresh each
   * time costs more in collection than the samples it saves. A child only ever
   * writes the level below its parent's, so a parent's list stays intact while
   * its children run.
   */
  const pool: Prim[][] = [];

  /** Record which signs a settled run holds, over every map cell it touches. */
  function flagRun(
    i0: number,
    i1: number,
    j0: number,
    j1: number,
    k0: number,
    k1: number,
    seen: number,
  ) {
    const n = seen & NEG ? 1 : 0;
    const p = seen & POS ? 1 : 0;
    for (let k = (k0 / FLAG) | 0; k <= ((k1 / FLAG) | 0); k++)
      for (let j = (j0 / FLAG) | 0; j <= ((j1 / FLAG) | 0); j++) {
        const base = (k * by + j) * bx;
        for (let i = (i0 / FLAG) | 0; i <= ((i1 / FLAG) | 0); i++) {
          neg[base + i] |= n;
          pos[base + i] |= p;
        }
      }
  }

  /**
   * Settle one axis-aligned run of grid points, splitting it when the test is
   * inconclusive.
   *
   * `cands` is the parent's candidate list — already a superset of anything
   * that can reach here, and in primitive order, which is what keeps `fieldAt`
   * folding the same blends in the same sequence a full scan would.
   *
   * Returns the two sign flags for the run, which the caller ORs upwards.
   */
  function descend(
    i0: number,
    i1: number,
    j0: number,
    j1: number,
    k0: number,
    k1: number,
    cands: Prim[],
    depth: number,
  ): number {
    // `E`: these points grown by the one cell the extractor can read across.
    region.min.set(
      origin.x + (i0 - 1) * step,
      origin.y + (j0 - 1) * step,
      origin.z + (k0 - 1) * step,
    );
    region.max.set(
      origin.x + (i1 + 1) * step,
      origin.y + (j1 + 1) * step,
      origin.z + (k1 + 1) * step,
    );
    region.getCenter(centre);
    const radius = region.min.distanceTo(region.max) * 0.5;
    const cx = centre.x;
    const cy = centre.y;
    const cz = centre.z;
    const lo = region.min;
    const hi = region.max;

    const near = (pool[depth] ??= []);
    near.length = 0;
    // The lowest any candidate's field can reach anywhere in `E`, and the
    // highest any certainly-present candidate's can. Both carry the
    // primitive's own jitter amplitude and its own Lipschitz factor.
    let floor_ = Infinity;
    let ceiling = Infinity;
    for (let c = 0; c < cands.length; c++) {
      const prim = cands[c];
      const box = prim.padded as T.Box3;
      if (
        box.max.x < lo.x ||
        box.min.x > hi.x ||
        box.max.y < lo.y ||
        box.min.y > hi.y ||
        box.max.z < lo.z ||
        box.min.z > hi.z
      )
        continue;
      near.push(prim);
      const d = distanceTo(prim, cx, cy, cz);
      const slack = radius * slope(prim) + amplitude(prim);
      if (d - slack < floor_) floor_ = d - slack;
      if (
        box.min.x <= lo.x &&
        box.max.x >= hi.x &&
        box.min.y <= lo.y &&
        box.max.y >= hi.y &&
        box.min.z <= lo.z &&
        box.max.z >= hi.z &&
        d + slack < ceiling
      )
        ceiling = d + slack;
    }

    // Nothing reaches here, so every point is the field's default — the same 1
    // the brute-force path leaves behind.
    if (!near.length) {
      bump('block.empty');
      flagRun(i0, i1, j0, j1, k0, k1, POS);
      return POS;
    }
    // Wholly outside: leave the default 1s in place.
    if (floor_ - (near.length - 1) * quarter > 0) {
      bump('block.outside');
      flagRun(i0, i1, j0, j1, k0, k1, POS);
      return POS;
    }
    // Wholly inside: any constant of the right sign will do.
    if (ceiling < 0) {
      bump('block.inside');
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++) {
          const base = (k * ny + j) * nx;
          values.fill(-1, base + i0, base + i1 + 1);
        }
      flagRun(i0, i1, j0, j1, k0, k1, NEG);
      return NEG;
    }

    // Too close to call. Halve it and ask again: a run that straddles the
    // surface is mostly made of halves that do not, and each halving shrinks
    // `radius` — the reason the test failed — by two.
    const wi = i1 - i0 + 1;
    const wj = j1 - j0 + 1;
    const wk = k1 - k0 + 1;
    if (wi > 2 || wj > 2 || wk > 2) {
      const mi = wi > 1 ? i0 + (wi >> 1) : i1 + 1;
      const mj = wj > 1 ? j0 + (wj >> 1) : j1 + 1;
      const mk = wk > 1 ? k0 + (wk >> 1) : k1 + 1;
      let seen = 0;
      for (let k = 0; k < 2; k++) {
        const ka = k ? mk : k0;
        const kb = k ? k1 : mk - 1;
        if (ka > kb) continue;
        for (let j = 0; j < 2; j++) {
          const ja = j ? mj : j0;
          const jb = j ? j1 : mj - 1;
          if (ja > jb) continue;
          for (let i = 0; i < 2; i++) {
            const ia = i ? mi : i0;
            const ib = i ? i1 : mi - 1;
            if (ia > ib) continue;
            seen |= descend(ia, ib, ja, jb, ka, kb, near, depth + 1);
          }
        }
      }
      return seen;
    }

    // Small enough that another test would cost more than the samples.
    bump('block.sampled');
    bump('block.candidates', near.length);
    let seen = 0;
    for (let k = k0; k <= k1; k++) {
      const z = origin.z + k * step;
      for (let j = j0; j <= j1; j++) {
        const y = origin.y + j * step;
        const base = (k * ny + j) * nx;
        for (let i = i0; i <= i1; i++) {
          const x = origin.x + i * step;
          const v = fieldAt(near, x, y, z, blend, reach);
          values[base + i] = v;
          seen |= v < 0 ? NEG : POS;
        }
      }
    }
    flagRun(i0, i1, j0, j1, k0, k1, seen);
    return seen;
  }

  const wx = Math.ceil(nx / BLOCK);
  const wy = Math.ceil(ny / BLOCK);
  const wz = Math.ceil(nz / BLOCK);
  for (let bk = 0; bk < wz; bk++)
    for (let bj = 0; bj < wy; bj++)
      for (let bi = 0; bi < wx; bi++) {
        descend(
          bi * BLOCK,
          Math.min(bi * BLOCK + BLOCK, nx) - 1,
          bj * BLOCK,
          Math.min(bj * BLOCK + BLOCK, ny) - 1,
          bk * BLOCK,
          Math.min(bk * BLOCK + BLOCK, nz) - 1,
          prims,
          0,
        );
      }

  return {
    origin: bounds.min,
    step,
    nx,
    ny,
    nz,
    values,
    blocks: { size: FLAG, bx, by, bz, neg, pos },
  };
}

/**
 * The original scan, kept whole.
 *
 * Nothing in the studio calls this; `tests/surface.test.ts` does, to prove the
 * hierarchical sampler agrees with it point for point wherever the extractor
 * can tell the difference.
 */
function bruteSample(
  padded: { prim: Prim; box: T.Box3 }[],
  values: Float32Array,
  origin: T.Vector3,
  step: number,
  nx: number,
  ny: number,
  nz: number,
  settings: SurfaceSettings,
  reach: number,
) {
  for (let k = 0; k < nz; k++) {
    const z = origin.z + k * step;
    const slab = padded.filter((p) => z >= p.box.min.z && z <= p.box.max.z);
    if (!slab.length) continue;
    for (let j = 0; j < ny; j++) {
      const y = origin.y + j * step;
      const row = slab.filter((p) => y >= p.box.min.y && y <= p.box.max.y);
      if (!row.length) continue;
      const candidates = row.map((p) => p.prim);
      const boxes = row.map((p) => p.box);
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const x = origin.x + i * step;
        let touched = false;
        for (let c = 0; c < boxes.length; c++)
          if (x >= boxes[c].min.x && x <= boxes[c].max.x) {
            touched = true;
            break;
          }
        if (!touched) continue;
        values[base + i] = fieldAt(candidates, x, y, z, settings.blend, reach);
      }
    }
  }
}

/**
 * Blocks the extractor has to walk cell by cell.
 *
 * A block qualifies when the values over it *and its far neighbours* include
 * both signs. The neighbours are in because a block's own points can be all
 * positive while the cell joining its last point to the next block's first
 * point straddles. Widening to the whole neighbouring block rather than to its
 * first plane only ever marks more blocks live, which costs time and cannot
 * cost correctness.
 */
function liveBlocks(blocks: Blocks) {
  const { bx, by, bz, neg, pos } = blocks;
  const live = new Uint8Array(bx * by * bz);
  const rows = new Uint8Array(by * bz);
  const slabs = new Uint8Array(bz);
  for (let k = 0; k < bz; k++)
    for (let j = 0; j < by; j++)
      for (let i = 0; i < bx; i++) {
        let anyNeg = 0;
        let anyPos = 0;
        for (let dk = 0; dk < 2; dk++)
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const x = i + di;
              const y = j + dj;
              const z = k + dk;
              if (x >= bx || y >= by || z >= bz) continue;
              const at = (z * by + y) * bx + x;
              anyNeg |= neg[at];
              anyPos |= pos[at];
            }
        if (anyNeg && anyPos) {
          live[(k * by + j) * bx + i] = 1;
          rows[k * by + j] = 1;
          slabs[k] = 1;
        }
      }
  return { live, rows, slabs };
}

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
const EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/**
 * Surface nets.
 *
 * One vertex per cell that straddles the surface, placed at the average of the
 * crossings on that cell's edges, then quads stitched around every sign-change
 * edge. It produces far better-shaped triangles than marching cubes — no
 * slivers to survive decimation — and the vertex placement keeps sharp edges
 * readable instead of staircasing them.
 *
 * The result is always closed: every edge belongs to two triangles, so there
 * are no holes. It is not always manifold. One vertex per cell cannot describe
 * a crease that cuts diagonally through that cell, so a knife-edged shape — an
 * unblended tetrahedron is the worst case — pinches into a few non-manifold
 * edges along its creases. Raising `detail` does not remove them, because the
 * crease is infinitely sharp at every scale. Blending rounds it away, which is
 * what surface mode is for.
 */
function surfaceNets(grid: Grid) {
  const { nx, ny, nz, values, origin, step } = grid;
  const index = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellIndex = (i: number, j: number, k: number) =>
    (k * (ny - 1) + j) * (nx - 1) + i;
  const positions: number[] = [];

  // Where the surface can be, at block resolution. Both passes below walk the
  // grid in exactly the order they always did and simply step over the runs
  // the sampler proved uniform — vertex numbering, and so the finished mesh,
  // is bit for bit what a full scan produces. Absent for a brute-force grid,
  // which falls back to scanning everything.
  const map = grid.blocks ? liveBlocks(grid.blocks) : null;
  // One block covering everything when there is no map, so both passes read as
  // the same loop nest either way.
  const B = grid.blocks?.size ?? Math.max(nx, ny, nz);
  const bx = map ? grid.blocks!.bx : 1;
  const by = map ? grid.blocks!.by : 1;
  const live = map ? map.live : null;

  const corner = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) {
    const fk = (k / B) | 0;
    if (map && !map.slabs[fk]) {
      k = fk * B + B - 1;
      continue;
    }
    for (let j = 0; j < ny - 1; j++) {
      const fj = (j / B) | 0;
      if (map && !map.rows[fk * by + fj]) {
        j = fj * B + B - 1;
        continue;
      }
      const row = (fk * by + fj) * bx;
      for (let fi = 0; fi < bx; fi++) {
        if (live && !live[row + fi]) continue;
        const iEnd = map ? Math.min((fi + 1) * B, nx - 1) : nx - 1;
        for (let i = map ? fi * B : 0; i < iEnd; i++) {
        let negatives = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNERS[c];
          const v = values[index(i + o[0], j + o[1], k + o[2])];
          corner[c] = v;
          if (v < 0) negatives++;
        }
        if (negatives === 0 || negatives === 8) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          hits = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          hits++;
        }
        cellVertex[cellIndex(i, j, k)] = positions.length / 3;
        positions.push(
          origin.x + (i + sx / hits) * step,
          origin.y + (j + sy / hits) * step,
          origin.z + (k + sz / hits) * step,
        );
        }
      }
    }
  }

  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };

  for (let k = 0; k < nz; k++) {
    const fk = (k / B) | 0;
    if (map && !map.slabs[fk]) {
      k = fk * B + B - 1;
      continue;
    }
    for (let j = 0; j < ny; j++) {
      const fj = (j / B) | 0;
      if (map && !map.rows[fk * by + fj]) {
        j = fj * B + B - 1;
        continue;
      }
      const row = (fk * by + fj) * bx;
      for (let fi = 0; fi < bx; fi++) {
        if (live && !live[row + fi]) continue;
        const iEnd = map ? Math.min((fi + 1) * B, nx) : nx;
        for (let i = map ? fi * B : 0; i < iEnd; i++) {
        const here = values[index(i, j, k)] < 0;
        // X edge: the four cells around it differ in j and k.
        if (i + 1 < nx && here !== values[index(i + 1, j, k)] < 0 && j > 0 && k > 0)
          quad(
            cellVertex[cellIndex(i, j - 1, k - 1)],
            cellVertex[cellIndex(i, j, k - 1)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i, j - 1, k)],
            here,
          );
        if (j + 1 < ny && here !== values[index(i, j + 1, k)] < 0 && i > 0 && k > 0)
          quad(
            cellVertex[cellIndex(i - 1, j, k - 1)],
            cellVertex[cellIndex(i, j, k - 1)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i - 1, j, k)],
            !here,
          );
        if (k + 1 < nz && here !== values[index(i, j, k + 1)] < 0 && i > 0 && j > 0)
          quad(
            cellVertex[cellIndex(i - 1, j - 1, k)],
            cellVertex[cellIndex(i, j - 1, k)],
            cellVertex[cellIndex(i, j, k)],
            cellVertex[cellIndex(i - 1, j, k)],
            here,
          );
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/** Drop vertices no triangle references, so the mesh carries no dead weight. */
function compact(positions: Float32Array, indices: Uint32Array) {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const keptPositions: number[] = [];
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) {
      remap[v] = keptPositions.length / 3;
      keptPositions.push(
        positions[v * 3],
        positions[v * 3 + 1],
        positions[v * 3 + 2],
      );
    }
    out[i] = remap[v];
  }
  return { positions: new Float32Array(keptPositions), indices: out };
}

/**
 * Turn a built model's primitives into one polygon mesh.
 *
 * Returns a group holding a single mesh so the rest of the pipeline — rigging,
 * stats, audit, export — keeps treating it like any other model.
 */
export function surfaceModel(
  source: T.Object3D,
  settings: SurfaceSettings,
  fallback: T.Color,
  name = 'surface',
  options: SurfaceOptions = {},
) {
  if (!loaded)
    throw Error(
      'Surface mode needs its decimator loaded first. Await readySurface() before building.',
    );
  const t0 = mark();
  const prims = primsOf(source, fallback);
  if (!prims.length) throw Error('Surface mode found no primitives to blend.');
  measure('surface.prims', t0);

  options.onPhase?.('sampling');
  const t1 = mark();
  const grid = sampleGrid(prims, settings, options);
  measure('surface.sample', t1);
  options.onPhase?.('meshing');
  const t2 = mark();
  const raw = surfaceNets(grid);
  measure('surface.nets', t2);
  if (!raw.indices.length)
    throw Error(
      'Surface mode produced an empty mesh. Raise `surface.detail` or check the part sizes.',
    );

  options.onPhase?.('decimating');
  const t3 = mark();
  let mesh = compact(raw.positions, raw.indices);
  const budget = Math.max(64, settings.budget) * 3;
  if (mesh.indices.length > budget) {
    const simplified = MeshoptSimplifier.simplify(
      mesh.indices,
      mesh.positions,
      3,
      budget,
      0.02,
      ['LockBorder'],
    );
    mesh = compact(mesh.positions, simplified[0] as Uint32Array);
  }
  measure('surface.decimate', t3);

  const geometry = new T.BufferGeometry();
  geometry.setAttribute(
    'position',
    new T.BufferAttribute(mesh.positions, 3),
  );
  geometry.setIndex(new T.BufferAttribute(mesh.indices, 1));

  options.onPhase?.('painting');
  const t4 = mark();
  paint(geometry, prims);
  measure('surface.paint', t4);
  if (settings.shading === 'smooth') geometry.computeVertexNormals();
  // Plan the unwrap now, while the primitives that own each vertex are still
  // in hand, but leave the mesh welded: cutting the uv seams here would tear
  // the index the audit reads to prove the shell is closed and connected.
  // `splitUvSeams` does the cutting at the export boundary instead.
  // The unwrap is export-only work: nothing the viewport, the audit or the
  // Projects list reads touches it, and `splitUvSeams` is what turns it into
  // real uvs on the way out. A preview that skips it is the same mesh.
  if (options.uv !== false) {
    const t5 = mark();
    geometry.userData.uvLayout = planUv(geometry);
    measure('surface.uv', t5);
  }

  const material = new T.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    vertexColors: true,
    flatShading: settings.shading === 'flat',
  });
  material.name = 'surface';

  const finished = new T.Mesh(geometry, material);
  // The faceted path names meshes in finishModel, which surface mode skips.
  // An unnamed node shows up blank in an engine's hierarchy.
  finished.name = name;
  finished.castShadow = true;
  finished.receiveShadow = true;
  finished.userData.surface = true;

  const group = new T.Group();
  group.name = source.name;
  group.userData = source.userData;
  group.add(finished);
  return group;
}

/**
 * Colour each vertex from the primitive nearest to it, and record which bone
 * that primitive was pinned to.
 *
 * Doing this after decimation rather than carrying attributes through it keeps
 * the bone index exact. Interpolating a bone index halfway between an arm and
 * a head would bind that vertex to whatever bone happens to sit between them.
 */
function paint(geometry: T.BufferGeometry, prims: Prim[]) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const owners = new Uint16Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const nearest = nearestPrim(
      prims,
      position.getX(i),
      position.getY(i),
      position.getZ(i),
    );
    owners[i] = nearest;
    const color = prims[nearest].color;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
  // The rigger reads this to weight each vertex to the bone its own primitive
  // was pinned to, instead of falling back to one bone for the whole mesh.
  geometry.userData.rigParts = Array.from(owners, (o) => prims[o].rigPart);
  // And the audit reads this to say which authored parts a stray shell is made
  // of. Without it a piece floating free of the body is just an extra lump of
  // triangles in a mesh that otherwise looks fine.
  geometry.userData.surfaceOwners = {
    index: owners,
    paths: prims.map((prim) => prim.specPath),
  };
}
