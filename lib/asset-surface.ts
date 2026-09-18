import * as T from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { planUv } from './asset-uv';
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

type Grid = {
  origin: T.Vector3;
  step: number;
  nx: number;
  ny: number;
  nz: number;
  values: Float32Array;
};

/**
 * Sample the field on a regular grid.
 *
 * The grid is padded by one voxel plus the blend radius so the surface never
 * touches the boundary; a shell clipped by the grid edge is not closed, and an
 * open shell is exactly the defect this whole mode exists to remove.
 */
function sampleGrid(prims: Prim[], settings: SurfaceSettings): Grid {
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
  const padded = prims.map((prim) => {
    const box = prim.box.clone().expandByScalar(reach);
    return { prim, box };
  });

  for (let k = 0; k < nz; k++) {
    const z = bounds.min.z + k * step;
    const slab = padded.filter((p) => z >= p.box.min.z && z <= p.box.max.z);
    if (!slab.length) continue;
    for (let j = 0; j < ny; j++) {
      const y = bounds.min.y + j * step;
      const row = slab.filter((p) => y >= p.box.min.y && y <= p.box.max.y);
      if (!row.length) continue;
      const candidates = row.map((p) => p.prim);
      const boxes = row.map((p) => p.box);
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const x = bounds.min.x + i * step;
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
  return { origin: bounds.min, step, nx, ny, nz, values };
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

  const corner = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
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

  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };

  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
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
) {
  if (!loaded)
    throw Error(
      'Surface mode needs its decimator loaded first. Await readySurface() before building.',
    );
  const prims = primsOf(source, fallback);
  if (!prims.length) throw Error('Surface mode found no primitives to blend.');

  const grid = sampleGrid(prims, settings);
  const raw = surfaceNets(grid);
  if (!raw.indices.length)
    throw Error(
      'Surface mode produced an empty mesh. Raise `surface.detail` or check the part sizes.',
    );

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

  const geometry = new T.BufferGeometry();
  geometry.setAttribute(
    'position',
    new T.BufferAttribute(mesh.positions, 3),
  );
  geometry.setIndex(new T.BufferAttribute(mesh.indices, 1));

  paint(geometry, prims);
  if (settings.shading === 'smooth') geometry.computeVertexNormals();
  // Plan the unwrap now, while the primitives that own each vertex are still
  // in hand, but leave the mesh welded: cutting the uv seams here would tear
  // the index the audit reads to prove the shell is closed and connected.
  // `splitUvSeams` does the cutting at the export boundary instead.
  geometry.userData.uvLayout = planUv(geometry);

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
