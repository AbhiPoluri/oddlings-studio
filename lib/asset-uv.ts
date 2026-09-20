import * as T from 'three';
import { bakeSurface } from './asset-bake';

/**
 * Texture coordinates for the fused surface mesh, and a colour atlas baked at
 * them.
 *
 * Surface mode hands back one welded shell with per-vertex colour and nothing
 * else. That shell is correct and untexturable: without a uv channel an engine
 * can put nothing on it but a flat material, and per-vertex colour dies the
 * moment anyone bakes lighting or swaps in a shader that expects a map.
 *
 * The unwrap here is a box projection, not a real parameterisation. Each
 * triangle picks whichever of the six axis directions its normal leans towards,
 * triangles are grouped into charts by (direction x owning primitive), each
 * chart is packed into one atlas with a shelf packer, and the seams between
 * charts are cut by duplicating vertices. It is deterministic, it is linear in
 * triangle count, and it is good enough to paint on. It is not xatlas: charts
 * are rectangles of a projection, so a chart that folds back on itself overlaps
 * itself in uv space. That is harmless for the colour bake — a chart is one
 * primitive, and a primitive is one colour — and would matter for a hand-painted
 * map.
 *
 * WHY THE SEAM CUT IS DEFERRED TO EXPORT
 * A uv seam is a duplicated vertex, and a duplicated vertex is a torn index.
 * The audit reads that index to answer whether the shell is closed
 * (`open-shell`) and whether it is one piece (`detached-shell`), and surface
 * mode exists precisely to make those answers good. Splitting inside
 * `surfaceModel` would make every surface asset report dozens of holes and
 * islands that are not there. So `planUv` runs at build time and parks the
 * result on `geometry.userData.uvLayout`, the welded mesh keeps its topology,
 * and `splitUvSeams` cuts the seams at the export boundary — inside `toGLB` and
 * `objBundle` — where nothing looks at connectivity again.
 */

/**
 * The material tuple, re-exported from the library that now owns it.
 *
 * It used to be declared here, because the atlas is where these numbers stop
 * being material settings and become texture channels. Presets moved the
 * declaration down to `asset-materials`, which knows what "rust" is; the names
 * still answer here so that every importer — the builder, the seam cutter, the
 * exporters and their tests — keeps the import it had.
 */
export type { SurfaceMaterial, MaterialSpec, Physical } from './asset-materials';
export { DEFAULT_MATERIAL, materialOf, materialFrom } from './asset-materials';
import {
  DEFAULT_MATERIAL,
  materialFrom,
  type SurfaceMaterial,
} from './asset-materials';

export function isDefaultMaterial(material: SurfaceMaterial) {
  return (
    material.roughness === DEFAULT_MATERIAL.roughness &&
    material.metalness === DEFAULT_MATERIAL.metalness &&
    !material.emissive &&
    !material.preset
  );
}

/**
 * The identity of a material, for grouping.
 *
 * A preset joins the key because two presets can agree on all four numbers and
 * still be different materials — glass and water are both smooth dielectrics
 * and only one of them refracts at 1.33. The name is appended rather than
 * folded in, so every tuple that was authored as four numbers keys exactly as
 * it did before presets existed and no existing asset regroups.
 */
export function materialKey(material: SurfaceMaterial) {
  const base = material.emissive
    ? `${material.roughness}|${material.metalness}|${material.emissive}|${material.emissiveStrength}`
    : `${material.roughness}|${material.metalness}`;
  return material.preset ? `${base}|p${material.preset}` : base;
}

/**
 * A stable, collision-free suffix for a material's name.
 *
 * Injective on the tuple — full precision, `.` written as `p` and `-` as `n`
 * so the name stays a plain identifier — because a name is what the MTL and
 * the palette index by, and two different materials answering to one name
 * would quietly merge on the way out.
 */
export function materialSuffix(material: SurfaceMaterial) {
  const num = (n: number) => String(n).replace('.', 'p').replace('-', 'n');
  const bits = [`r${num(material.roughness)}`, `m${num(material.metalness)}`];
  if (material.preset) bits.unshift(material.preset);
  if (material.emissive)
    bits.push(
      `e${material.emissive.replace('#', '')}`,
      `s${num(material.emissiveStrength)}`,
    );
  return bits.join('');
}

/**
 * Write one authored tuple onto a three material.
 *
 * `emissiveStrength` becomes `emissiveIntensity`, which the glTF exporter
 * turns into `KHR_materials_emissive_strength` whenever it is not 1 — so a
 * lamp authored at strength 4 arrives in an engine as a lamp, not as a
 * washed-out clamp of one.
 */
export function applyMaterial(
  material: T.MeshStandardMaterial,
  wanted: SurfaceMaterial,
) {
  // Through the library, which hands back a `MeshPhysicalMaterial` instead
  // when the tuple carries transmission, clearcoat or sheen — a standard
  // material has nowhere to put them. Callers assign the result.
  return materialFrom(material, wanted);
}

/** Tunables. No spec field controls these; they are the same for every asset. */
export type UvOptions = {
  /** Atlas edge in texels. UVs are packed for this size and no other. */
  size: number;
  /** Texels of padding around each chart, so dilation cannot bleed across. */
  gutter: number;
  /** Charts smaller than this fold into the largest chart that shares their
   * direction and owner, so gutter overhead does not eat the atlas. */
  minChart: number;
};

export const UV_DEFAULTS: UvOptions = { size: 1024, gutter: 2, minChart: 6 };

export type UvLayout = {
  /** Two floats per triangle corner, parallel to the geometry's index. */
  corners: Float32Array;
  /** Chart id per triangle. The seam cut keys vertex duplication on this. */
  chartOf: Int32Array;
  charts: number;
  /** Packed rectangle area over atlas area, 0..1. */
  efficiency: number;
  size: number;
  gutter: number;
  /** Triangles with no world area. Simplification leaves a few; they get a
   * collapsed uv triangle rather than a NaN one. */
  degenerate: number;
};

/** +X, -X, +Y, -Y, +Z, -Z. Six, not three: with three, the front and back of a
 * part project onto the same rectangle and the bake overwrites itself. */
const DIRECTIONS = 6;

/**
 * Project a point onto the plane of one of the six directions.
 *
 * The axis pairs follow the cube-map convention, so a chart is not mirrored
 * relative to the surface it came from.
 */
function project(direction: number, x: number, y: number, z: number) {
  switch (direction) {
    case 0:
      return [-z, y];
    case 1:
      return [z, y];
    case 2:
      return [x, -z];
    case 3:
      return [x, z];
    case 4:
      return [x, y];
    default:
      return [-x, y];
  }
}

/** The direction a triangle's normal leans towards, with fixed tie-breaks. */
function directionOf(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
) {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  // A zero-area triangle has no normal, and normalising one leaks NaN into
  // every uv downstream. Park it on +Y and let the caller count it.
  if (nx * nx + ny * ny + nz * nz < 1e-24) return { direction: 2, flat: true };
  const lx = Math.abs(nx),
    ly = Math.abs(ny),
    lz = Math.abs(nz);
  let direction: number;
  if (lx >= ly && lx >= lz) direction = nx >= 0 ? 0 : 1;
  else if (ly >= lz) direction = ny >= 0 ? 2 : 3;
  else direction = nz >= 0 ? 4 : 5;
  return { direction, flat: false };
}

/** Which primitive a triangle belongs to: the majority of its corners, ties to
 * the lowest index, so the answer never depends on corner order.
 *
 * Exported so the material grouping in `asset-surface` decides a triangle's
 * owner exactly as the unwrap does. Two rules would put a chart boundary and a
 * material boundary in different places, which is a seam you can see. */
export function ownerOf(a: number, b: number, c: number) {
  if (a === b || a === c) return a;
  if (b === c) return b;
  return Math.min(a, b, c);
}

type Chart = {
  direction: number;
  minU: number;
  minV: number;
  width: number;
  height: number;
  /** Placement in the atlas, in texels, filled in by the packer. */
  x: number;
  y: number;
};

/**
 * Shelf packer: rectangles sorted tall-first, laid left to right in rows.
 *
 * Crude next to a max-rects packer and about twenty lines shorter. Charts from
 * a box projection are mostly similar in size, which is the case shelves handle
 * well, and the atlas only has to hold flat colour.
 */
function shelfPack(sizes: { w: number; h: number }[], size: number) {
  const order = sizes
    .map((_, i) => i)
    .sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w || a - b);
  const placed = new Array<{ x: number; y: number }>(sizes.length);
  let shelfY = 0,
    shelfHeight = 0,
    cursor = 0;
  for (const i of order) {
    const rect = sizes[i];
    if (rect.w > size || rect.h > size) return null;
    if (cursor + rect.w > size) {
      shelfY += shelfHeight;
      shelfHeight = 0;
      cursor = 0;
    }
    if (shelfY + rect.h > size) return null;
    placed[i] = { x: cursor, y: shelfY };
    cursor += rect.w;
    if (rect.h > shelfHeight) shelfHeight = rect.h;
  }
  return placed;
}

/**
 * Plan the unwrap for one welded, indexed surface geometry.
 *
 * Returns the layout rather than writing it, because writing it means cutting
 * seams and cutting seams means losing the topology the audit still needs.
 */
export function planUv(
  geometry: T.BufferGeometry,
  options: Partial<UvOptions> = {},
): UvLayout {
  const { size, gutter, minChart } = { ...UV_DEFAULTS, ...options };
  const index = geometry.index;
  if (!index) throw Error('planUv needs an indexed geometry.');
  const position = geometry.attributes.position as T.BufferAttribute;
  const owners = (
    geometry.userData.surfaceOwners as { index: Uint16Array } | undefined
  )?.index;
  const vertices = position.count;
  const triangles = index.count / 3;
  const points = position.array;
  const indices = index.array;

  // --- one direction and one owner per triangle --------------------------
  const direction = new Uint8Array(triangles);
  const group = new Int32Array(triangles);
  const primitives = owners ? owners.reduce((m, o) => Math.max(m, o), 0) + 1 : 1;
  let degenerate = 0;
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3],
      b = indices[t * 3 + 1],
      c = indices[t * 3 + 2];
    const picked = directionOf(
      points[a * 3],
      points[a * 3 + 1],
      points[a * 3 + 2],
      points[b * 3],
      points[b * 3 + 1],
      points[b * 3 + 2],
      points[c * 3],
      points[c * 3 + 1],
      points[c * 3 + 2],
    );
    if (picked.flat) degenerate++;
    direction[t] = picked.direction;
    const owner = owners ? ownerOf(owners[a], owners[b], owners[c]) : 0;
    group[t] = picked.direction * primitives + owner;
  }

  // --- charts: connected runs of triangles inside one group --------------
  // A group is usually several islands — the six patches of a sphere's own
  // projection, a limb crossing its parent — and packing one rectangle around
  // islands that sit at opposite ends of the model wastes most of the atlas.
  const parent = new Int32Array(triangles);
  for (let t = 0; t < triangles; t++) parent[t] = t;
  const find = (t: number): number => {
    while (parent[t] !== t) t = parent[t] = parent[parent[t]];
    return t;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const firstOnEdge = new Map<number, number>();
  for (let t = 0; t < triangles; t++)
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e];
      const b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * vertices + b : b * vertices + a;
      const other = firstOnEdge.get(key);
      if (other === undefined) firstOnEdge.set(key, t);
      else if (group[other] === group[t]) union(other, t);
    }

  // Fold slivers into the biggest chart that shares their direction and owner.
  // Same group means same projection and same colour, so the merge cannot show.
  const sizes = new Map<number, number>();
  for (let t = 0; t < triangles; t++) {
    const root = find(t);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const biggest = new Map<number, number>();
  for (const [root, count] of sizes) {
    const key = group[root];
    const held = biggest.get(key);
    if (held === undefined || count > (sizes.get(held) ?? 0)) biggest.set(key, root);
  }
  for (const [root, count] of sizes) {
    if (count >= minChart) continue;
    const host = biggest.get(group[root]);
    if (host !== undefined && host !== root) union(host, root);
  }

  // --- measure each chart in world units ---------------------------------
  const chartOf = new Int32Array(triangles).fill(-1);
  const charts: Chart[] = [];
  const rootToChart = new Map<number, number>();
  for (let t = 0; t < triangles; t++) {
    const root = find(t);
    let id = rootToChart.get(root);
    if (id === undefined) {
      id = charts.length;
      rootToChart.set(root, id);
      charts.push({
        direction: direction[root],
        minU: Infinity,
        minV: Infinity,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      });
    }
    chartOf[t] = id;
  }
  const maxU = new Float64Array(charts.length).fill(-Infinity);
  const maxV = new Float64Array(charts.length).fill(-Infinity);
  for (let t = 0; t < triangles; t++) {
    const chart = charts[chartOf[t]];
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e];
      const [u, w] = project(
        chart.direction,
        points[v * 3],
        points[v * 3 + 1],
        points[v * 3 + 2],
      );
      if (u < chart.minU) chart.minU = u;
      if (w < chart.minV) chart.minV = w;
      if (u > maxU[chartOf[t]]) maxU[chartOf[t]] = u;
      if (w > maxV[chartOf[t]]) maxV[chartOf[t]] = w;
    }
  }
  let area = 0;
  for (let i = 0; i < charts.length; i++) {
    charts[i].width = Math.max(maxU[i] - charts[i].minU, 0);
    charts[i].height = Math.max(maxV[i] - charts[i].minV, 0);
    area += charts[i].width * charts[i].height;
  }

  // --- pick a texel density that fits, then pack -------------------------
  // Texel density is the one number that decides how much of the atlas the
  // model actually gets, so it is worth searching for rather than guessing.
  // Shrink from an optimistic start until a pack succeeds, then push back up
  // while it keeps succeeding: shelves leave ragged space at the top, and the
  // first scale that fits typically leaves a fifth of the atlas unused.
  const attempt = (scale: number) => {
    const rects = charts.map((chart) => ({
      w: Math.max(1, Math.ceil(chart.width * scale)) + gutter * 2,
      h: Math.max(1, Math.ceil(chart.height * scale)) + gutter * 2,
    }));
    const placed = shelfPack(rects, size);
    return placed
      ? { placed, packed: rects.reduce((sum, r) => sum + r.w * r.h, 0) }
      : null;
  };

  let scale = area > 0 ? Math.sqrt((size * size * 0.5) / area) : 1;
  let fit = attempt(scale);
  for (let step = 0; step < 64 && !fit; step++) {
    scale *= 0.85;
    fit = attempt(scale);
  }
  if (!fit)
    throw Error(
      `The unwrap could not fit ${charts.length} charts into a ${size}px atlas.`,
    );
  for (let step = 0; step < 32; step++) {
    const bigger = attempt(scale * 1.06);
    if (!bigger) break;
    scale *= 1.06;
    fit = bigger;
  }
  for (let i = 0; i < charts.length; i++) {
    charts[i].x = fit.placed[i].x;
    charts[i].y = fit.placed[i].y;
  }
  const packed = fit.packed;

  // --- write one uv per triangle corner ----------------------------------
  const corners = new Float32Array(index.count * 2);
  for (let t = 0; t < triangles; t++) {
    const chart = charts[chartOf[t]];
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e];
      const [u, w] = project(
        chart.direction,
        points[v * 3],
        points[v * 3 + 1],
        points[v * 3 + 2],
      );
      const corner = (t * 3 + e) * 2;
      corners[corner] = clamp01(
        (chart.x + gutter + (u - chart.minU) * scale) / size,
      );
      corners[corner + 1] = clamp01(
        (chart.y + gutter + (w - chart.minV) * scale) / size,
      );
    }
  }

  return {
    corners,
    chartOf,
    charts: charts.length,
    efficiency: packed / (size * size),
    size,
    gutter,
    degenerate,
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Copy the rows of an attribute named by `order`, keeping its exact type. */
function reorder(source: T.BufferAttribute, order: Uint32Array) {
  const array = source.array;
  const made = new (array.constructor as new (length: number) => typeof array)(
    order.length * source.itemSize,
  );
  for (let i = 0; i < order.length; i++)
    for (let c = 0; c < source.itemSize; c++)
      made[i * source.itemSize + c] =
        array[order[i] * source.itemSize + c];
  return new T.BufferAttribute(made, source.itemSize, source.normalized);
}

/**
 * Cut the uv seams planned by `planUv` and write the uv channel.
 *
 * Every vertex shared by two charts becomes one vertex per chart, and every
 * per-vertex array grows with it: the geometry's own attributes — position,
 * normal, colour, and the skin binding a rig has already written — plus the
 * `rigParts` and `surfaceOwners` arrays that live on userData and that the rig
 * and the audit index by vertex. Growing the attributes and forgetting userData
 * is the whole trap here: nothing throws, the rig just binds the wrong half of
 * the model to the wrong bone.
 *
 * Idempotent, and safe to call on a faceted model: a mesh with no planned
 * layout is left exactly as it is, three's primitives already carry uvs.
 */
export function splitUvSeams(model: T.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const geometry = object.geometry;
    const layout = geometry.userData.uvLayout as UvLayout | undefined;
    if (!layout) return;
    const index = geometry.index;
    if (!index) return;
    const indices = index.array;
    const vertices = (geometry.attributes.position as T.BufferAttribute).count;

    // (source vertex, chart) -> split vertex. One vertex per chart it touches.
    const seen = new Map<number, number>();
    const source: number[] = [];
    const next = new Uint32Array(index.count);
    for (let t = 0; t < index.count / 3; t++)
      for (let e = 0; e < 3; e++) {
        const corner = t * 3 + e;
        const vertex = indices[corner];
        const key = vertex * layout.charts + layout.chartOf[t];
        let made = seen.get(key);
        if (made === undefined) {
          made = source.length;
          seen.set(key, made);
          source.push(vertex);
        }
        next[corner] = made;
      }
    const order = Uint32Array.from(source);

    const split = new T.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (!(attribute instanceof T.BufferAttribute))
        throw Error(`Cannot split interleaved attribute "${name}" for uvs.`);
      split.setAttribute(name, reorder(attribute, order));
    }
    const uv = new Float32Array(order.length * 2);
    for (let corner = 0; corner < index.count; corner++) {
      uv[next[corner] * 2] = layout.corners[corner * 2];
      uv[next[corner] * 2 + 1] = layout.corners[corner * 2 + 1];
    }
    split.setAttribute('uv', new T.BufferAttribute(uv, 2));
    split.setIndex(new T.BufferAttribute(next, 1));

    split.userData = { ...geometry.userData };
    delete split.userData.uvLayout;
    const rigParts = geometry.userData.rigParts as
      | (string | undefined)[]
      | undefined;
    if (rigParts)
      split.userData.rigParts = Array.from(order, (v) => rigParts[v]);
    const owners = geometry.userData.surfaceOwners as
      | {
          index: Uint16Array;
          paths: (number[] | undefined)[];
          subtract?: boolean[];
        }
      | undefined;
    if (owners)
      split.userData.surfaceOwners = {
        index: Uint16Array.from(order, (v) => owners.index[v]),
        paths: owners.paths,
        ...(owners.subtract ? { subtract: owners.subtract } : {}),
      };
    // Material groups are ranges over the index, and the split rewrites the
    // index corner for corner in place, so every range still covers the same
    // triangles. Losing them here would collapse a multi-material export back
    // to one material at the last moment.
    for (const group of geometry.groups)
      split.addGroup(group.start, group.count, group.materialIndex);
    // Which welded vertex each split vertex came from. A weld map for anyone
    // downstream, and the only honest way to check that duplicating a vertex
    // did not change what it is bound to.
    split.userData.uvSource = order;
    split.userData.uvAtlas = {
      charts: layout.charts,
      efficiency: layout.efficiency,
      size: layout.size,
      gutter: layout.gutter,
      welded: vertices,
    };

    object.geometry = split;
    geometry.dispose();
  });
  return model;
}

export type ColorAtlas = {
  width: number;
  height: number;
  /** RGBA, row 0 at v = 1. Alpha is the coverage mask: 0 is empty atlas. */
  rgba: Uint8Array;
  /** Texels the triangles themselves wrote, before dilation. */
  covered: number;
  /**
   * The other channels the same rasteriser drew, when the model varies in
   * them. Absent by default and absent one at a time: a model whose parts are
   * all matte ships one PNG, exactly as it always did, and a model with one
   * glowing lens ships a colour map and an emissive map and no others.
   *
   * Roughness and metalness are written linearly, because they are data an
   * engine reads as numbers; colour and emission go through sRGB, because they
   * are light.
   */
  maps?: {
    roughness?: ColorAtlas;
    metalness?: ColorAtlas;
    emissive?: ColorAtlas;
    /** Tangent-space normals, from the heights a paint expression returned. */
    normal?: ColorAtlas;
    /**
     * Roughness in green and metalness in blue, the way glTF packs them.
     *
     * Never written to disk — the per-channel PNGs above are what an OBJ
     * importer can use — but it is the one image `metallicRoughnessTexture`
     * can be, and three samples the same two channels, so it is what the GLB
     * and the viewport both get.
     */
    metalRough?: ColorAtlas;
  };
};

/**
 * Bake the atlas a model's uvs point at.
 *
 * Kept as the name everything used to call; the work moved to
 * `bakeSurface` in `asset-bake`, which evaluates each part's paint at every
 * texel instead of interpolating vertex colours across a triangle. Returns
 * null when the model has no atlas to bake — a faceted asset has flat
 * materials and no fused shell, so there is nothing a texture would add.
 *
 * Works either side of `splitUvSeams`: before it the uv plan is on
 * `userData.uvLayout`, after it the uvs are on the vertices, and the baker
 * reads whichever is there.
 */
export function bakeColorAtlas(model: T.Object3D): ColorAtlas | null {
  // One baker, in `asset-bake`. This name is the door it used to be reached
  // through, and it still opens: a split model carries its uvs on its vertices
  // and the baker reads them there, exactly as this function did.
  return bakeSurface(model);
}

/**
 * Grow painted texels into the gutter, one ring per pass.
 *
 * Without this a bilinear sample at a chart's edge mixes in the empty
 * background, which shows up as a dark seam wherever two charts meet on the
 * model. `gutter` passes exactly fill the padding the packer reserved.
 */
export function dilate(
  rgba: Uint8Array,
  mask: Uint8Array,
  size: number,
  passes: number,
) {
  for (let pass = 0; pass < passes; pass++) {
    const grown = mask.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const pixel = y * size + x;
        if (mask[pixel]) continue;
        let r = 0,
          g = 0,
          b = 0,
          hits = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const neighbour = ny * size + nx;
            if (!mask[neighbour]) continue;
            r += rgba[neighbour * 4];
            g += rgba[neighbour * 4 + 1];
            b += rgba[neighbour * 4 + 2];
            hits++;
          }
        if (!hits) continue;
        rgba[pixel * 4] = Math.round(r / hits);
        rgba[pixel * 4 + 1] = Math.round(g / hits);
        rgba[pixel * 4 + 2] = Math.round(b / hits);
        rgba[pixel * 4 + 3] = 255;
        grown[pixel] = 1;
      }
    mask.set(grown);
  }
}
