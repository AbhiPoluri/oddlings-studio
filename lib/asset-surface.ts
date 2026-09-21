import * as T from 'three';
import { creaseSplit } from './asset-smooth';
import { cutSeams, framesOf, paintAt } from './asset-paint';
import { presetPaint } from './asset-materials';
import type { Part } from './asset-spec';
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  applyMaterial,
  isDefaultMaterial,
  materialKey,
  materialOf,
  materialSuffix,
  ownerOf,
  planUv,
  type SurfaceMaterial,
} from './asset-uv';
import { bump, mark, measure } from './perf';
import {
  canonicalExtent,
  distanceTo,
  noise3,
  primArgs,
  smin,
  type Prim,
  type PrimSource,
  deformedBounds,
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
  /**
   * Crease angle in degrees. Set, it replaces `shading`: edges that turn
   * harder than this stay sharp and everything gentler is shaded smooth.
   */
  crease?: number;
  /**
   * Feature size in metres: how far the decimated surface may drift from the
   * field. Details smaller than this flatten; unset keeps 2% of the extent.
   */
  feature?: number;
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
 * The empty attribute buffer `simplifyWithAttributes` takes when the only
 * thing being asked of it is the vertex lock. The attribute machinery is how
 * meshoptimizer exposes locking at all; with a stride of zero and no weights
 * it ranks collapses exactly as `simplify` does.
 */
const NO_ATTRIBUTES = new Float32Array(0);

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
      deform: source.deform,
      subtract: source.subtract,
      material: source.material,
      // A limb has no unit box, so its paint runs in world metres — which is
      // what the guide has always promised and what this line makes true.
      paint: source.paint ?? presetPaint(source.material),
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
  // A bend or a twist reaches outside the box `size` describes, and both the
  // grid bounds and the per-cell cull read this box — without it a bent part
  // marches off flat where it leaves its authored footprint.
  const bent = deformedBounds(shape, source.deform);
  if (bent)
    local.set(
      bent.min.clone().multiply(new T.Vector3(...stretch)),
      bent.max.clone().multiply(new T.Vector3(...stretch)),
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
    deform: source.deform,
    subtract: source.subtract,
    material: source.material,
    field: source.field,
    fieldLipschitz: source.lipschitz,
    // A preset draws its own pattern unless the part brought one.
    paint: source.paint ?? presetPaint(source.material),
    wrap: source.wrap,
  };
}

/**
 * Smooth maximum: the mirror of `smin`, and what a cut is made of.
 *
 * `smax(a, b, k) = −smin(−a, −b, k)`, so the rim where a subtracted part meets
 * the surface it was cut from is rounded by exactly the same radius as a join
 * between two added parts. A cut with a hard rim and joins with soft ones would
 * read as two different materials welded together; one `blend` controls both.
 * `k = 0` gives the plain max, which is a knife edge.
 */
function smax(a: number, b: number, k: number) {
  if (k <= 0) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * Field value at a world-space point: the smooth union of every primitive
 * whose influence reaches it, less every primitive that carves.
 *
 * `candidates` is the pre-culled list for this region. Points outside every
 * primitive's padded box are outside the surface by construction, so the
 * caller can skip them entirely rather than evaluating an empty union.
 *
 * `pad` widens each primitive's own box by its blend reach. Culling on the
 * bare box instead would silently drop exactly the points between two parts —
 * the ones the blend exists to fill — and leave them looking detached.
 *
 * SUBTRACTION IS ORDERED. Parts fold in the spec's own order, and a part with
 * `subtract` is cut from the union of everything *before* it:
 * `f ← smax(f, −d, k)`. So a subtractor after a subtractor cuts the
 * already-cut field, and a part added after a subtractor fills the hole back
 * in. A subtractor with nothing in front of it has nothing to cut and is
 * skipped rather than inverting the world — which is also what keeps a spec
 * whose first part is a cut from producing a solid the size of the grid.
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
    if (prim.subtract) {
      if (first) continue;
      d = smax(d, -di, blend);
      continue;
    }
    d = first ? di : smin(d, di, blend);
    first = false;
  }
  return first ? 1 : d;
}

/**
 * The primitive that owns a point, used to colour and bind the finished mesh.
 *
 * Without subtraction this is plain argmin over the signed distances — the
 * nearest primitive, ties to the lowest index — and that is exactly what it
 * still computes for a spec with no cuts.
 *
 * A cut needs the order. A vertex on a niche's inner wall sits *inside* the
 * wall it was carved from, so the wall's signed distance there is large and
 * negative while the subtractor's is zero: argmin hands the vertex to the
 * wall and the cut comes out painted like solid stone. Replaying the hard CSG
 * in spec order instead — union takes the smaller, a cut takes the larger of
 * the running value and the subtractor's negation — tracks which primitive
 * actually put the surface where it is, so the inner walls take the
 * subtractor's own colour, and a part added after the cut takes the wall back
 * where it fills the hole in.
 *
 * Ownership stays with the subtractor for rigging too: the cut walls follow
 * whatever bone the *subtracting* part is pinned to, which by default is the
 * one it inherits from its parent. A window cut into a wall therefore follows
 * the window's bone, not the wall's — put the cut under the part it belongs
 * to, or set `rigPart` on it, if that is not what you want.
 *
 * Linear over every primitive, and run once per finished vertex. That is cheap
 * at a few thousand vertices against a few dozen parts; a spec with thousands
 * of scattered copies and a large budget would want a spatial index here.
 */
function ownerAt(prims: Prim[], x: number, y: number, z: number) {
  let best = 0;
  // The running CSG value, starting from "nothing has been added yet".
  let field = Infinity;
  for (let i = 0; i < prims.length; i++) {
    const prim = prims[i];
    const d = distanceTo(prim, x, y, z);
    if (prim.subtract) {
      if (-d > field) {
        field = -d;
        best = i;
      }
      continue;
    }
    if (d < field) {
      field = d;
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
function slope(prim: Prim) {
  // A `field` part declares how much faster than distance its expression can
  // change; the block test grows its slack by that so a displaced surface can
  // never hide inside a block the centre sample called uniform. Every other
  // shape is an exact distance.
  return prim.shape === 'field' ? Math.max(1, prim.fieldLipschitz ?? 1) : 1;
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
 *   outside, f > 0 on all of E, if   min_i (D_i − R − A_i) − (|S⁺| − 1)·k/4 > 0
 *   inside,  f < 0 on all of E, if   some i has E inside its padded box
 *                                    and D_i + R + A_i < 0
 *
 * where `S⁺` is the additive part of `S` and `i` ranges over it. The first
 * holds because each `d_i` is 1-Lipschitz, so `d_i ≥ D_i − R` on `E`, the
 * jitter moves it by at most `A_i`, and every `smin` in the fold can depress
 * the running value by at most `k/4` — which compounds, once per blend, hence
 * the `|S⁺| − 1`. The second holds because `smin(a, b, k) ≤ min(a, b)`, so one
 * primitive that is certainly a candidate and certainly negative across `E`
 * caps the whole union below zero.
 *
 * SUBTRACTION BREAKS THE SECOND, NOT THE FIRST. A cut is `f ← smax(f, −d_j, k)`
 * and `smax(a, b, k) ≥ max(a, b) ≥ a`, so a subtractor can only ever raise the
 * field. The outside test therefore stands as written — it is a lower bound,
 * and the subtractors are simply left out of it. The inside test does not: a
 * primitive wholly negative across `E` no longer caps the field, because a cut
 * after it can lift the whole block back out of the solid. So with `S⁻` the
 * subtractors whose padded box meets `E`, the bound becomes
 *
 *   inside,  f < 0 on all of E, if   max( min_i (D_i + R + A_i),
 *                                        max_j (−(D_j − R − A_j)) )
 *                                    + |S⁻|·k/4 < 0
 *
 * taking `i` over the additive primitives that contain `E` and `j` over `S⁻`.
 * Each `smax` takes the larger of the running value and `−d_j ≤ −(D_j − R −
 * A_j)`, and adds at most `k/4` of its own — once per cut, hence `|S⁻|`. With
 * no subtractors the second term is `−∞`, the third is zero, and this is the
 * old test unchanged, which is why a spec with no cuts samples bit for bit as
 * it did. Read in words: a block counts as inside when some part swallows it
 * whole *and* every cut that could reach it stays clear of it by more than the
 * rims those cuts can round.
 *
 * A block whose candidates are all subtractors is a cut with nothing to cut,
 * which `fieldAt` answers with the empty field — so it is settled as outside
 * without sampling, exactly as an empty block is.
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
    // The lowest any added candidate's field can reach anywhere in `E`, and the
    // highest any certainly-present added candidate's can. Both carry the
    // primitive's own jitter amplitude and its own Lipschitz factor.
    let floor_ = Infinity;
    let ceiling = Infinity;
    // How far the nearest cut stays clear of `E`, and how many cuts reach it.
    // `-Infinity` is "no cut can touch this block", which is what makes the
    // inside test below collapse to the one a spec without cuts gets.
    let carve = -Infinity;
    let adds = 0;
    let cuts = 0;
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
      if (prim.subtract) {
        cuts++;
        // The highest `−d_j` can be anywhere in `E`.
        if (-(d - slack) > carve) carve = -(d - slack);
        continue;
      }
      adds++;
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

    // Nothing reaches here — or only cuts do, which carve an empty field into
    // an empty field — so every point is the field's default, the same 1 the
    // brute-force path leaves behind.
    if (!adds) {
      bump(near.length ? 'block.cutonly' : 'block.empty');
      flagRun(i0, i1, j0, j1, k0, k1, POS);
      return POS;
    }
    // Wholly outside: leave the default 1s in place.
    if (floor_ - (adds - 1) * quarter > 0) {
      bump('block.outside');
      flagRun(i0, i1, j0, j1, k0, k1, POS);
      return POS;
    }
    // Wholly inside: any constant of the right sign will do.
    if (Math.max(ceiling, carve) + cuts * quarter < 0) {
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

/**
 * How many grid cells a part may span and still count as a small feature.
 *
 * The decimator measures error against the whole mesh, so a feature that is a
 * fraction of a percent of the longest axis costs almost nothing to erase: the
 * wizard's eyes, a rune on a hem, a fang, all collapse into the face they sit
 * on long before the budget is met. Sixteen cells is where a part stops being
 * a silhouette and starts being a detail, calibrated against the shipped
 * specs: the wizard's eye spans 12.1 cells and its cheek 13.9, its hand spans
 * 20 and its fingers 18, and the lich's fangs span 5. Twelve was the first
 * guess and missed the wizard's own eye by a tenth of a cell.
 *
 * Measured in cells rather than metres on purpose: it is the same threshold
 * whether the asset is a 2 m wizard or a 130 m building, and it tracks
 * `surface.detail`, which is what decides how much of a small part the grid
 * could resolve in the first place.
 *
 * Not a spec field. It is a property of how the decimator weighs error, not of
 * any one asset, and no spec so far has wanted a different number — see the
 * report if that stops being true.
 */
const SMALL_FEATURE_CELLS = 16;

/**
 * Vertices pinned per small part.
 *
 * Enough to keep a shape rather than a bump — an eye held by twenty vertices
 * still reads as a sphere — and few enough that protecting every rune on a hem
 * does not eat the budget the rest of the model needs. The rest of a small
 * part's vertices stay collapsible, so the decimator still simplifies it; it
 * simply cannot delete it.
 */
const PROTECT_PER_PART = 24;

/**
 * The most of the target vertex count that pinning may claim.
 *
 * A lock the decimator cannot honour is worse than no lock: it would blow
 * through the triangle budget the spec asked for. Past this share the smallest
 * parts keep their protection and the larger ones lose it, which is the right
 * order — the larger a part is, the better it survives on its own.
 */
const PROTECT_SHARE = 0.35;

/**
 * Which vertices the decimator may not collapse away.
 *
 * Returns null when nothing qualifies, and the caller then takes the plain
 * `simplify` path it always did — so an asset with no small parts decimates to
 * the same bytes it used to.
 *
 * The work is kept proportional to the small parts rather than to the mesh:
 * only vertices inside some small part's own box are asked who owns them, and
 * that question is the same `ownerAt` the paint pass asks later, so a vertex
 * counted here is one that really will carry the part's colour.
 */
function protectSmallFeatures(
  positions: Float32Array,
  prims: Prim[],
  step: number,
  reach: number,
  targetTriangles: number,
) {
  const limit = SMALL_FEATURE_CELLS * step;
  const size = new T.Vector3();
  const small = prims
    .map((prim, index) => {
      const extents = prim.box.getSize(size).toArray();
      const span = Math.max(...extents);
      // A thin part is as easy to erase as a small one: a ring, a cable or a
      // band a centimetre thick loses its curve to a handful of cheap
      // collapses however long it is. Thin counts as small, and gets locks
      // along its whole length rather than one part's share.
      const thin = Math.min(...extents) < limit / 2;
      return {
        index,
        span,
        thin,
        // Where to look for the vertices this part owns. Not its own box: an
        // eye sunk into a head owns the patch of head surface that bulges over
        // it, and that patch sits outside the eye entirely. One part-width
        // plus the blend's reach covers how far a small part can push its
        // neighbour's skin — and stays a small region, which is the point of
        // filtering at all.
        near: prim.box.clone().expandByScalar(span + reach),
      };
    })
    .filter((entry) => entry.span < limit || entry.thin)
    // Smallest first: they are the ones a collapse erases outright, and the
    // ones that keep their protection when the share below runs out. Ties by
    // primitive index, so the order never depends on the sort's stability.
    .sort((a, b) => a.span - b.span || a.index - b.index);
  if (!small.length) return null;

  const count = positions.length / 3;
  const isSmall = new Uint8Array(prims.length);
  for (const entry of small) isSmall[entry.index] = 1;
  const owned = new Map<number, number[]>();
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    let near = false;
    for (const entry of small) {
      const b = entry.near;
      if (
        x >= b.min.x &&
        x <= b.max.x &&
        y >= b.min.y &&
        y <= b.max.y &&
        z >= b.min.z &&
        z <= b.max.z
      ) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    const owner = ownerAt(prims, x, y, z);
    if (!isSmall[owner]) continue;
    const list = owned.get(owner);
    if (list) list.push(v);
    else owned.set(owner, [v]);
  }

  // A closed mesh has about half as many vertices as triangles, so this is the
  // vertex count the budget is really asking for.
  const room = Math.max(8, Math.floor(((targetTriangles / 2) * PROTECT_SHARE)));
  const lock = new Uint8Array(count);
  let locked = 0;
  for (const entry of small) {
    const list = owned.get(entry.index);
    if (!list?.length) continue;
    const share = entry.thin ? PROTECT_PER_PART * Math.ceil(entry.span / limit) : PROTECT_PER_PART;
    const wanted = Math.min(share, list.length);
    if (locked + wanted > room) break;
    // Strided rather than the first N: the vertices come in grid order, so the
    // first twenty of an eye are one horizontal band of it. Spreading them over
    // the part keeps its whole silhouette, not one slice.
    const stride = list.length / wanted;
    for (let i = 0; i < wanted; i++) {
      const v = list[Math.floor(i * stride)];
      if (lock[v]) continue;
      lock[v] = 1;
      locked++;
    }
  }
  bump('surface.protected', locked);
  return locked ? lock : null;
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

/** `compact` for a seamed mesh: the per-vertex owner records come along. */
function compactSeamed(
  seamed: ReturnType<typeof cutSeams>,
  indices: Uint32Array,
): ReturnType<typeof cutSeams> {
  const remap = new Int32Array(seamed.positions.length / 3).fill(-1);
  const positions: number[] = [];
  const owners: number[] = [];
  const rigOwners: number[] = [];
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) {
      remap[v] = positions.length / 3;
      positions.push(
        seamed.positions[v * 3],
        seamed.positions[v * 3 + 1],
        seamed.positions[v * 3 + 2],
      );
      owners.push(seamed.owners[v]);
      rigOwners.push(seamed.rigOwners[v]);
    }
    out[i] = remap[v];
  }
  return {
    positions: Float32Array.from(positions),
    indices: out,
    owners: Uint16Array.from(owners),
    rigOwners: Uint16Array.from(rigOwners),
    added: seamed.added,
  };
}

/**
 * Point every wrapped primitive at the primitives it hugs.
 *
 * `wrap.on` names parts; a name covers every copy of that part — mirrored,
 * repeated — and everything under it, so "torso" wraps the torso and the pecs
 * hung off it. A wrap that names itself, or a name nothing carries, is an
 * authoring error worth stopping on: the belt would otherwise quietly build
 * as a ring.
 */
function resolveWraps(prims: Prim[], spec: { parts: Part[] } | undefined) {
  if (!prims.some((prim) => prim.wrap)) return;
  if (!spec) throw Error('"wrap" needs the spec to resolve its target names.');
  const byName = new Map<string, number[][]>();
  const walk = (parts: Part[], prefix: number[]) => {
    parts.forEach((part, index) => {
      const path = [...prefix, index];
      if (part.name) byName.set(part.name, [...(byName.get(part.name) ?? []), path]);
      if (part.children) walk(part.children, path);
    });
  };
  walk(spec.parts, []);
  const under = (path: number[] | undefined, root: number[]) =>
    !!path && path.length >= root.length && root.every((v, i) => path[i] === v);
  for (const prim of prims) {
    if (!prim.wrap) continue;
    const names = Array.isArray(prim.wrap.on) ? prim.wrap.on : [prim.wrap.on];
    const targets: Prim[] = [];
    for (const name of names) {
      const roots = byName.get(name);
      if (!roots)
        throw Error(`"wrap" on a part names "${name}", but no part is called that.`);
      for (const other of prims) {
        if (other === prim || other.subtract) continue;
        if (roots.some((root) => under(other.specPath, root))) targets.push(other);
      }
    }
    if (!targets.length)
      throw Error(`"wrap" on a part names only itself or cuts; wrap a solid neighbour instead.`);
    prim.wrapTargets = targets;
  }
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
  resolveWraps(prims, source.userData.spec as { parts: Part[] } | undefined);
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
  const full = compact(raw.positions, raw.indices);
  // How far a collapse may move the surface, as a fraction of the extent.
  // The default is tight enough to keep every fillet; `feature` in metres
  // lets the author say what is too small to matter, and the budget flows
  // from those fillets to silhouette and the large forms.
  const extent = Math.max(grid.nx, grid.ny, grid.nz) * grid.step;
  const tolerance = 0.02;
  // `feature`: before any budget is applied, collapse everything the surface
  // can lose without drifting more than the feature size from where it was.
  // A count target alone never does this — the decimator reaches the count
  // long before the error limit binds — so this pass has no count target at
  // all: it runs until the next collapse would cost more than `feature`.
  // Studs, fillets and ridges below that size go here, and the budget pass
  // then spends every triangle on what is left, which is the large forms.
  let base = full;
  if (settings.feature && settings.feature > 0) {
    const t = mark();
    const flattened = MeshoptSimplifier.simplify(
      full.indices,
      full.positions,
      3,
      3,
      settings.feature / Math.max(extent, 1e-6),
      ['LockBorder'],
    );
    base = compact(full.positions, flattened[0] as Uint32Array);
    measure('surface.feature', t);
  }
  const decimate = (triangles: number) => {
    const budget = Math.max(64, triangles) * 3;
    const full = base;
    if (full.indices.length <= budget) return full;
    // The decimator ranks every collapse by the error it adds to the whole
    // mesh, which is exactly the wrong ranking for a face: erasing an eye
    // costs a hundredth of what flattening a shoulder does, so the eye goes
    // first. Pinning a handful of each small part's vertices takes those
    // collapses off the table without touching the rest of the ranking.
    const lock = protectSmallFeatures(
      full.positions,
      prims,
      grid.step,
      settings.blend + grid.step,
      triangles,
    );
    const simplified = lock
      ? MeshoptSimplifier.simplifyWithAttributes(
          full.indices,
          full.positions,
          3,
          NO_ATTRIBUTES,
          0,
          [],
          lock,
          budget,
          tolerance,
          ['LockBorder'],
        )
      : MeshoptSimplifier.simplify(
          full.indices,
          full.positions,
          3,
          budget,
          tolerance,
          ['LockBorder'],
        );
    return compact(full.positions, simplified[0] as Uint32Array);
  };
  let mesh = decimate(settings.budget);
  measure('surface.decimate', t3);

  const assemble = () => {
    const made = new T.BufferGeometry();
    made.setAttribute('position', new T.BufferAttribute(mesh.positions, 3));
    made.setIndex(new T.BufferAttribute(mesh.indices, 1));
    return made;
  };
  let geometry = assemble();

  options.onPhase?.('painting');
  const t4 = mark();
  paint(
    geometry,
    prims,
    mesh !== full
      ? { budget: settings.budget, step: grid.step, blend: settings.blend, tolerance }
      : undefined,
  );
  // Before the unwrap: grouping reorders the index, and the unwrap's charts
  // and the seam cut are both keyed by triangle position in it.
  const tuples = dressMaterials(geometry, prims);
  measure('surface.paint', t4);
  const creased = settings.crease !== undefined;
  if (settings.shading === 'smooth' && !creased) geometry.computeVertexNormals();
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

  if (creased) {
    // Last, once everything keyed by vertex id has been recorded: the split
    // carries those records across, and the uv plan is keyed by triangle so
    // it rides through untouched.
    const t6 = mark();
    geometry = creaseSplit(geometry, settings.crease!);
    measure('surface.crease', t6);
  }

  let material = new T.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    vertexColors: true,
    flatShading: settings.shading === 'flat' && !creased,
  });
  material.name = 'surface';
  // One tuple for the whole shell needs no groups and no export-time fan-out:
  // it is the mesh's own material, set here. Several is what `geometry.groups`
  // and `surfaceMaterials` describe, and `dressSurfaceMaterials` builds on the
  // way out — see the note on `dressMaterials`.
  if (tuples?.length === 1) {
    if (!isDefaultMaterial(tuples[0]))
      material.name = `surface_${materialSuffix(tuples[0])}`;
    // Assigned: a preset with transmission, clearcoat or sheen hands back a
    // physical material rather than writing into this one.
    material = applyMaterial(material, tuples[0]);
  }

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
 * Split the fused shell by material and carry the numbers per vertex.
 *
 * Surface mode's whole point is one mesh, and one mesh in glTF has one
 * material — unless it has groups, which is how a single primitive buffer
 * carries several. So the index is sorted by material tuple and one group is
 * declared per run: still one mesh, one vertex buffer and one draw per
 * material, which is what an engine wants anyway.
 *
 * Colour stays per vertex, because colour varies inside a group and nothing
 * else does. Roughness, metalness and emission ride along as vertex
 * attributes as well, even though the group already knows them: they are what
 * the atlas bake rasterises into its extra channels, and reading them off the
 * geometry keeps that bake the same loop as the colour bake rather than a
 * second one that looks the answer up somewhere else.
 *
 * Returns the tuples in group order, or null when every part is matte — and
 * null means nothing is written at all. That silence is load-bearing: the
 * exporter copies `geometry.userData` into the GLB, and a groups array, a
 * material table and three attribute buffers full of defaults would change
 * every existing asset's bytes to say exactly what their absence already says.
 */
function dressMaterials(geometry: T.BufferGeometry, prims: Prim[]) {
  const tuples = prims.map((prim) => materialOf(prim.material));
  if (tuples.every(isDefaultMaterial)) return null;

  const position = geometry.attributes.position as T.BufferAttribute;
  const owners = (geometry.userData.surfaceOwners as { index: Uint16Array })
    .index;
  const count = position.count;
  const roughness = new Float32Array(count);
  const metalness = new Float32Array(count);
  const emissive = new Float32Array(count * 3);
  const colour = new T.Color();
  for (let i = 0; i < count; i++) {
    const tuple = tuples[owners[i]];
    roughness[i] = tuple.roughness;
    metalness[i] = tuple.metalness;
    if (!tuple.emissive) continue;
    // Clamped by the colour itself, not by the strength: the map is a colour
    // and cannot hold a factor of four. The strength stays on the material,
    // where glTF has a real extension for it.
    colour.set(tuple.emissive);
    emissive[i * 3] = colour.r;
    emissive[i * 3 + 1] = colour.g;
    emissive[i * 3 + 2] = colour.b;
  }
  geometry.setAttribute('roughness', new T.BufferAttribute(roughness, 1));
  geometry.setAttribute('metalness', new T.BufferAttribute(metalness, 1));
  geometry.setAttribute('emissive', new T.BufferAttribute(emissive, 3));

  // --- one group per distinct tuple, in first-appearance order -------------
  const index = geometry.index as T.BufferAttribute;
  const indices = index.array as Uint32Array;
  const triangles = index.count / 3;
  const order = new Map<string, number>();
  const groups: SurfaceMaterial[] = [];
  const groupOfPrim = new Int32Array(prims.length);
  for (let p = 0; p < prims.length; p++) {
    const key = materialKey(tuples[p]);
    let at = order.get(key);
    if (at === undefined) {
      at = groups.length;
      order.set(key, at);
      groups.push(tuples[p]);
    }
    groupOfPrim[p] = at;
  }
  if (groups.length < 2) return groups;

  const groupOfTriangle = new Int32Array(triangles);
  const counts = new Int32Array(groups.length);
  for (let t = 0; t < triangles; t++) {
    const owner = ownerOf(
      owners[indices[t * 3]],
      owners[indices[t * 3 + 1]],
      owners[indices[t * 3 + 2]],
    );
    const group = groupOfPrim[owner];
    groupOfTriangle[t] = group;
    counts[group]++;
  }
  const start = new Int32Array(groups.length);
  for (let g = 1; g < groups.length; g++) start[g] = start[g - 1] + counts[g - 1];
  const cursor = start.slice();
  const sorted = new Uint32Array(indices.length);
  // A counting sort, so triangles keep their relative order inside a group and
  // the result depends on nothing but the input.
  for (let t = 0; t < triangles; t++) {
    const at = cursor[groupOfTriangle[t]]++;
    sorted[at * 3] = indices[t * 3];
    sorted[at * 3 + 1] = indices[t * 3 + 1];
    sorted[at * 3 + 2] = indices[t * 3 + 2];
  }
  geometry.setIndex(new T.BufferAttribute(sorted, 1));
  geometry.clearGroups();
  for (let g = 0; g < groups.length; g++)
    if (counts[g]) geometry.addGroup(start[g] * 3, counts[g] * 3, g);
  geometry.userData.surfaceMaterials = groups;
  // The same ranges again, as plain numbers on userData rather than only as
  // `geometry.groups`. The studio builds in a worker and the model comes back
  // rebuilt from attributes, index and userData — `groups` is not part of that
  // channel, so without this copy a model that took the worker's route would
  // arrive knowing which materials it has and not which triangles wear them,
  // and its export would collapse back to one material.
  geometry.userData.surfaceGroups = geometry.groups.map((group) => ({
    start: group.start,
    count: group.count,
    materialIndex: group.materialIndex ?? 0,
  }));
  return groups;
}

/**
 * Colour each vertex from the primitive nearest to it, and record which bone
 * that primitive was pinned to.
 *
 * Doing this after decimation rather than carrying attributes through it keeps
 * the bone index exact. Interpolating a bone index halfway between an arm and
 * a head would bind that vertex to whatever bone happens to sit between them.
 */
/** What `paint` needs to hold the triangle budget after it has cut seams. */
type Fit = { budget: number; step: number; blend: number; tolerance: number };

function paint(geometry: T.BufferGeometry, prims: Prim[], fit?: Fit) {
  const position = geometry.attributes.position as T.BufferAttribute;
  const found = new Uint16Array(position.count);
  for (let i = 0; i < position.count; i++)
    found[i] = ownerAt(prims, position.getX(i), position.getY(i), position.getZ(i));
  // Crisp seams: split the triangles that straddle two differently-coloured
  // parts along the curve where ownership changes, so no triangle is ever
  // asked to blend two parts' colours across itself. See `cutSeams`.
  let seamed = cutSeams(
    position.array as Float32Array,
    (geometry.index as T.BufferAttribute).array as Uint32Array,
    found,
    prims,
  );
  if (seamed.added) {
    bump('surface.seamVertices', seamed.added);
    // The cut adds triangles — on a character with long seams as many as half
    // again — and the budget is a promise about the finished mesh. So the
    // mesh is decimated once more, now with the seams in it. Each side of a
    // seam has its own vertices, which makes every seam a topological border,
    // and the decimator locks borders: the interior pays the whole bill and
    // the seam curves come through exactly as cut. Collapses never invent
    // vertices, so the owner of every surviving vertex is still known.
    if (fit && seamed.indices.length / 3 > fit.budget * 1.01) {
      const target = Math.max(64, fit.budget) * 3;
      const lock = protectSmallFeatures(
        seamed.positions,
        prims,
        fit.step,
        fit.blend + fit.step,
        fit.budget,
      );
      const simplified = lock
        ? MeshoptSimplifier.simplifyWithAttributes(
            seamed.indices,
            seamed.positions,
            3,
            NO_ATTRIBUTES,
            0,
            [],
            lock,
            target,
            fit.tolerance,
            ['LockBorder'],
          )
        : MeshoptSimplifier.simplify(
            seamed.indices,
            seamed.positions,
            3,
            target,
            fit.tolerance,
            ['LockBorder'],
          );
      seamed = compactSeamed(seamed, simplified[0] as Uint32Array);
    }
    geometry.setAttribute('position', new T.BufferAttribute(seamed.positions, 3));
    geometry.setIndex(new T.BufferAttribute(seamed.indices, 1));
  }
  const owners = seamed.owners;
  const rigOwners = seamed.rigOwners;
  const count = seamed.positions.length / 3;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    paintAt(
      prims[owners[i]],
      seamed.positions[i * 3],
      seamed.positions[i * 3 + 1],
      seamed.positions[i * 3 + 2],
      colors,
      i * 3,
    );
  geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
  // Every part reduced to what its paint needs — frame, expression, seed,
  // material tuple — as plain data. The atlas bake evaluates the expression
  // once per texel rather than once per vertex, and it runs in the worker, in
  // the CLI and on the main thread; a `Prim` reaches none of those places, and
  // this record reaches all three.
  geometry.userData.surfacePaint = framesOf(prims);
  // The rigger reads this to weight each vertex to the bone its own primitive
  // was pinned to, instead of falling back to one bone for the whole mesh.
  geometry.userData.rigParts = Array.from(rigOwners, (o) => prims[o].rigPart);
  // And the audit reads this to say which authored parts a stray shell is made
  // of. Without it a piece floating free of the body is just an extra lump of
  // triangles in a mesh that otherwise looks fine.
  geometry.userData.surfaceOwners = {
    index: owners,
    paths: prims.map((prim) => prim.specPath),
    // Which of those primitives carve rather than add. The audit needs it to
    // keep `no-surface` quiet about a cut that happened to remove nothing
    // visible: a subtractor owning no vertex is a cut that did not show, which
    // is a note about the cut, not a part the author forgot to expose.
    //
    // Left out entirely when nothing cuts, because the exporter writes
    // `geometry.userData` into the GLB as extras — an always-present array of
    // falses would change every existing asset's bytes to say nothing.
    ...(prims.some((prim) => prim.subtract)
      ? { subtract: prims.map((prim) => Boolean(prim.subtract)) }
      : {}),
  };
}
