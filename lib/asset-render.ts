import * as T from 'three';
import { encodePng } from './asset-png';
import {
  bakeSurface,
  packMaps,
  paintsTexels,
  unpackMaps,
  type BakedMaps,
} from './asset-bake';
import { type ColorAtlas, type UvLayout } from './asset-uv';

/**
 * A software rasteriser for finished models.
 *
 * Agents iterate on an asset by looking at it, and looking at it has meant
 * driving a browser: start a viewer, wait for WebGL, screenshot, read the
 * image back. Six rounds of that is the bulk of what authoring an asset costs.
 * A few hundred lines of z-buffer answer the same question in milliseconds,
 * with no GPU, no headless-gl and no native dependency to install — and,
 * unlike a screenshot, it can hand back the buffers behind the image: which
 * authored part owns each pixel, and how far away it was. Those are what
 * `asset-audit-visual` turns into numbers an agent can act on without
 * looking at anything at all.
 *
 * Orthographic on purpose. Perspective would need a focal length chosen per
 * asset, and every measurement taken off the image would then depend on it.
 */

/** Camera directions, named the way an art note names them. */
export const VIEWS = [
  'front',
  'back',
  'side',
  'left',
  'top',
  'bottom',
  'three-quarter',
] as const;
export type ViewName = (typeof VIEWS)[number];

/** What a render shows by default: the four angles a turnaround sheet has. */
export const DEFAULT_VIEWS: ViewName[] = [
  'front',
  'three-quarter',
  'side',
  'top',
];

/**
 * The six axis views, which together see every outward-facing triangle of a
 * convex part. The unseen-triangle budget is measured against these, because
 * measured against four it would report the whole far side of every model.
 */
export const AXIS_VIEWS: ViewName[] = [
  'front',
  'back',
  'side',
  'left',
  'top',
  'bottom',
];

/**
 * Where each camera stands, in world space, looking at the model's centre.
 *
 * Assets face +z, so `front` is the +z camera. The three-quarter is the
 * standard one: swung 35° around the model and lifted 20°, which shows two
 * sides and the top plane without foreshortening any of them away.
 */
const DIRECTIONS: Record<ViewName, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  side: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  'three-quarter': [
    Math.sin(Math.PI * (35 / 180)) * Math.cos(Math.PI * (20 / 180)),
    Math.sin(Math.PI * (20 / 180)),
    Math.cos(Math.PI * (35 / 180)) * Math.cos(Math.PI * (20 / 180)),
  ],
};

/** A camera looking straight down has no "up" in the xz plane; give it -z. */
function upFor(view: ViewName): [number, number, number] {
  return view === 'top' || view === 'bottom' ? [0, 0, -1] : [0, 1, 0];
}

export type RenderOptions = {
  /** Frame edge in pixels. Square. Default 512. */
  size?: number;
  views?: ViewName[];
  /** Empty-frame colour, as sRGB bytes. Default a light studio grey. */
  background?: [number, number, number];
  /** Clear space left around the model, as a fraction of the frame. */
  margin?: number;
};

/** One authored part, as the pixel buffers refer to it. */
export type RenderPart = {
  /** `specPath.join('.')`, matching the keys the geometry audit uses. */
  key: string;
  path?: number[];
  /** Triangles this part owns across the whole model. */
  triangles: number;
};

export type ViewRender = {
  view: ViewName;
  size: number;
  /** RGBA, eight bits a channel, row 0 at the top. Opaque everywhere. */
  rgba: Uint8Array;
  /** Index into `Render.parts` per pixel, or -1 where the model is not. */
  part: Int32Array;
  /** Index into the flattened triangle soup per pixel, or -1. */
  triangle: Int32Array;
  /** Distance from the camera plane per pixel; +Infinity for background. */
  depth: Float32Array;
  /** Fraction of the frame the model covers. */
  fill: number;
};

export type Render = {
  parts: RenderPart[];
  /** Triangles in the whole model, which is what `unseen` is a share of. */
  triangles: number;
  /**
   * Three part indices a triangle, in the order the `triangle` buffers index
   * them. The visual audit needs it to say which part a triangle nobody can
   * see belonged to; the pixel buffers alone only name what is visible.
   */
  owners: Int32Array;
  views: ViewRender[];
  ms: number;
};

/**
 * The model as one flat triangle soup in world space.
 *
 * Per vertex rather than per triangle for colour and ownership: a fused
 * surface carries both per vertex, and keeping them there lets a pixel take
 * the colour it actually has and the part whose corner it sits nearest,
 * instead of one answer for the whole triangle.
 */
type Soup = {
  /** 9 floats a triangle: three world-space positions. */
  position: Float32Array;
  /** 9 floats a triangle: three linear-space RGB colours. */
  color: Float32Array;
  /** 3 ints a triangle: the part index of each vertex. */
  owner: Int32Array;
  /** 6 floats a triangle: the atlas uv of each corner. Zero where unused. */
  uv: Float32Array;
  /** 1 a triangle: whether to read `atlas` rather than `color`. */
  textured: Uint8Array;
  /** The baked colour atlas, when this model has paint worth sampling. */
  atlas: ColorAtlas | null;
  parts: RenderPart[];
  count: number;
};

type SurfaceOwners = {
  index: Uint16Array;
  paths: (number[] | undefined)[];
};

/**
 * The baked colour atlas, if this model has one worth reading.
 *
 * Paint is evaluated per texel, not per vertex: a stripe, a brick course or a
 * rust bloom is exactly as sharp as the atlas, and on a decimated shell that
 * is far sharper than the vertex colours the same model carries. Rendering
 * from the attribute therefore shows a smear where the studio and the shipped
 * GLB both show crisp bands, which is the one thing a render is for.
 *
 * Gated on `paintsTexels` rather than on being a surface build at all. An
 * unpainted surface — including one wearing a material preset, which varies
 * roughness and metalness but not colour — bakes to the same flat colours the
 * vertices already hold, so the bake would be a few hundred milliseconds spent
 * to arrive back where we started.
 *
 * Cached the way the studio caches it, on `geometry.userData.bakedMaps`, so a
 * model the build worker already baked is not baked again, and the six extra
 * axis views the visual audit renders pay for the atlas once between them.
 */
function atlasFor(model: T.Object3D): ColorAtlas | null {
  if (!paintsTexels(model)) return null;
  let held: BakedMaps | undefined;
  model.traverse((object) => {
    if (held || !(object instanceof T.Mesh)) return;
    held = object.geometry.userData.bakedMaps as BakedMaps | undefined;
  });
  if (held) return unpackMaps(held);
  const baked = bakeSurface(model);
  if (!baked) return null;
  const maps = packMaps(baked);
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (!object.geometry.userData.surfacePaint) return;
    object.geometry.userData.bakedMaps = maps;
  });
  return baked;
}

/**
 * The uv of each of a triangle's corners, however this mesh stores them.
 *
 * Before the export boundary the unwrap is a plan on `userData.uvLayout` with
 * one uv per corner already, and the mesh is still welded — which is the state
 * a built model is in, and the reason nothing here calls `splitUvSeams`. After
 * it the uvs are on the vertices. Both answer the same question.
 */
function uvReader(geometry: T.BufferGeometry) {
  const layout = geometry.userData.uvLayout as UvLayout | undefined;
  if (layout?.corners.length)
    return (corner: number) =>
      [layout.corners[corner * 2], layout.corners[corner * 2 + 1]] as const;
  const uv = geometry.attributes.uv as T.BufferAttribute | undefined;
  const index = geometry.index;
  if (!uv || !index) return null;
  return (corner: number) => {
    const vertex = index.getX(corner);
    return [uv.getX(vertex), uv.getY(vertex)] as const;
  };
}

/** sRGB byte to linear, all 256 of them, so the pixel loop never calls pow. */
const LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    table[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return table;
})();

function trianglesOf(geometry: T.BufferGeometry) {
  const position = geometry.attributes.position as T.BufferAttribute;
  return Math.floor((geometry.index ? geometry.index.count : position.count) / 3);
}

/**
 * Flatten a built model into the soup.
 *
 * Both build modes land here. A faceted asset is many meshes, each with one
 * material colour and one `specPath`; a surface asset is one fused mesh with
 * a colour and an owning primitive per vertex. Neither is special-cased
 * further down: by the time a triangle reaches the rasteriser it carries three
 * colours and three owners either way.
 */
function readModel(model: T.Object3D): Soup {
  model.updateMatrixWorld(true);
  let total = 0;
  model.traverse((object) => {
    if (object instanceof T.Mesh) total += trianglesOf(object.geometry);
  });

  const atlas = atlasFor(model);
  const soup: Soup = {
    position: new Float32Array(total * 9),
    color: new Float32Array(total * 9),
    owner: new Int32Array(total * 3),
    uv: new Float32Array(atlas ? total * 6 : 0),
    textured: new Uint8Array(atlas ? total : 0),
    atlas,
    parts: [],
    count: 0,
  };
  const partIndex = new Map<string, number>();
  const partOf = (key: string, path?: number[]) => {
    const found = partIndex.get(key);
    if (found !== undefined) return found;
    partIndex.set(key, soup.parts.length);
    soup.parts.push({ key, ...(path ? { path } : {}), triangles: 0 });
    return soup.parts.length - 1;
  };

  const vertex = new T.Vector3();
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.attributes.position as T.BufferAttribute;
    const colors = geometry.attributes.color as T.BufferAttribute | undefined;
    const owners = geometry.userData.surfaceOwners as SurfaceOwners | undefined;
    const specPath = object.userData.specPath as number[] | undefined;
    // A faceted mesh answers for its whole self; only a fused one answers per
    // vertex. `object.name` is the fallback so a model built from a recipe,
    // which stamps no spec paths, still separates into nameable parts.
    const meshPart = owners
      ? -1
      : partOf(specPath ? specPath.join('.') : object.name, specPath);
    const material = Array.isArray(object.material)
      ? object.material[0]
      : object.material;
    const flat = (material as T.MeshStandardMaterial | undefined)?.color;
    const index = geometry.index;
    // Only the mesh the paint was baked from reads the atlas. A model can
    // carry a fused shell and loose faceted props at once, and the props keep
    // their material colours.
    const uvAt =
      atlas && geometry.userData.surfacePaint ? uvReader(geometry) : null;
    const faces = trianglesOf(geometry);
    for (let t = 0; t < faces; t++) {
      const at = soup.count * 9;
      const seen = new Set<number>();
      if (uvAt) {
        soup.textured[soup.count] = 1;
        for (let corner = 0; corner < 3; corner++) {
          const [u, v] = uvAt(t * 3 + corner);
          soup.uv[soup.count * 6 + corner * 2] = u;
          soup.uv[soup.count * 6 + corner * 2 + 1] = v;
        }
      }
      for (let corner = 0; corner < 3; corner++) {
        const v = index ? index.getX(t * 3 + corner) : t * 3 + corner;
        vertex.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld);
        soup.position[at + corner * 3] = vertex.x;
        soup.position[at + corner * 3 + 1] = vertex.y;
        soup.position[at + corner * 3 + 2] = vertex.z;
        if (colors) {
          soup.color[at + corner * 3] = colors.getX(v);
          soup.color[at + corner * 3 + 1] = colors.getY(v);
          soup.color[at + corner * 3 + 2] = colors.getZ(v);
        } else {
          soup.color[at + corner * 3] = flat?.r ?? 1;
          soup.color[at + corner * 3 + 1] = flat?.g ?? 1;
          soup.color[at + corner * 3 + 2] = flat?.b ?? 1;
        }
        let part = meshPart;
        if (owners) {
          const prim = owners.index[v];
          const path = owners.paths[prim];
          part = partOf(path ? path.join('.') : `${object.name}#${prim}`, path);
        }
        soup.owner[soup.count * 3 + corner] = part;
        seen.add(part);
      }
      // A triangle that straddles two parts is counted for each of them, so
      // the per-part totals the unseen budget divides by are the triangles
      // that part could lose if it were deleted.
      for (const part of seen) soup.parts[part].triangles++;
      soup.count++;
    }
  });
  return soup;
}

/** Linear working colour to sRGB, the space an image is looked at in. */
function toSrgb(c: number) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Lighting, fixed in camera space rather than world space.
 *
 * World-space lights would leave the top view flat and the back view black,
 * which is exactly the view an author asked for because something looked
 * wrong there. Keyed from over the camera's left shoulder with a weak fill
 * from the opposite side, so every view is lit the same way and two views of
 * the same part can be compared.
 */
const KEY = normalise(-0.4, 0.62, 0.68);
const FILL = normalise(0.55, -0.25, 0.4);
const AMBIENT = 0.3;

function normalise(x: number, y: number, z: number) {
  const n = Math.hypot(x, y, z) || 1;
  return [x / n, y / n, z / n] as const;
}

const BACKGROUND: [number, number, number] = [0xe9, 0xea, 0xed];

/**
 * Render one view into its four buffers.
 *
 * The frame is fitted to the model's own projected extent, not to its
 * three-dimensional box: a box fitted in 3D leaves a rotated model swimming in
 * empty pixels, and the silhouette fraction measured off that image would say
 * more about the rotation than about the model.
 */
function renderView(
  soup: Soup,
  view: ViewName,
  size: number,
  margin: number,
  background: [number, number, number],
): ViewRender {
  const [dx, dy, dz] = normalise(...DIRECTIONS[view]);
  const [ux, uy, uz] = upFor(view);
  // Camera basis: z toward the viewer, x to the right, y up.
  const zx = dx,
    zy = dy,
    zz = dz;
  const [rx, ry, rz] = normalise(
    uy * zz - uz * zy,
    uz * zx - ux * zz,
    ux * zy - uy * zx,
  );
  const [vx, vy, vz] = normalise(
    zy * rz - zz * ry,
    zz * rx - zx * rz,
    zx * ry - zy * rx,
  );

  const n = soup.count * 3;
  const cam = new Float32Array(n * 3);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = soup.position[i * 3],
      py = soup.position[i * 3 + 1],
      pz = soup.position[i * 3 + 2];
    const x = px * rx + py * ry + pz * rz;
    const y = px * vx + py * vy + pz * vz;
    cam[i * 3] = x;
    cam[i * 3 + 1] = y;
    cam[i * 3 + 2] = px * zx + py * zy + pz * zz;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const span =
    Math.max(maxX - minX, maxY - minY, 1e-6) / Math.max(1e-3, 1 - 2 * margin);
  const scale = size / span;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const half = size / 2;

  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = background[0];
    rgba[i * 4 + 1] = background[1];
    rgba[i * 4 + 2] = background[2];
    rgba[i * 4 + 3] = 255;
  }
  const part = new Int32Array(size * size).fill(-1);
  const triangle = new Int32Array(size * size).fill(-1);
  const depth = new Float32Array(size * size).fill(Infinity);
  const texels = soup.atlas?.rgba;
  const aw = soup.atlas?.width ?? 0;
  const ah = soup.atlas?.height ?? 0;

  for (let t = 0; t < soup.count; t++) {
    const a = t * 3,
      b = t * 3 + 1,
      c = t * 3 + 2;
    const ax = (cam[a * 3] - midX) * scale + half;
    const ay = half - (cam[a * 3 + 1] - midY) * scale;
    const bx = (cam[b * 3] - midX) * scale + half;
    const by = half - (cam[b * 3 + 1] - midY) * scale;
    const cx = (cam[c * 3] - midX) * scale + half;
    const cy = half - (cam[c * 3 + 1] - midY) * scale;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Dividing the edge functions by a signed area makes them positive inside
    // the triangle whichever way it winds, so a mirrored part — which the
    // builder produces with a negative scale — draws like any other rather
    // than being culled. Nothing is back-face culled here; the z-buffer is
    // what decides who is in front.
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    if (x1 < x0 || y1 < y0) continue;

    // Flat shading off the geometric normal, turned to face the camera so a
    // triangle seen from behind is lit rather than black.
    const e1x = cam[b * 3] - cam[a * 3],
      e1y = cam[b * 3 + 1] - cam[a * 3 + 1],
      e1z = cam[b * 3 + 2] - cam[a * 3 + 2];
    const e2x = cam[c * 3] - cam[a * 3],
      e2y = cam[c * 3 + 1] - cam[a * 3 + 1],
      e2z = cam[c * 3 + 2] - cam[a * 3 + 2];
    let fx = e1y * e2z - e1z * e2y,
      fy = e1z * e2x - e1x * e2z,
      fz = e1x * e2y - e1y * e2x;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;
    if (fz < 0) {
      fx = -fx;
      fy = -fy;
      fz = -fz;
    }
    const light =
      AMBIENT +
      0.85 * Math.max(0, fx * KEY[0] + fy * KEY[1] + fz * KEY[2]) +
      0.25 * Math.max(0, fx * FILL[0] + fy * FILL[1] + fz * FILL[2]);

    const az = cam[a * 3 + 2],
      bz = cam[b * 3 + 2],
      cz = cam[c * 3 + 2];
    const textured = soup.textured[t] === 1;
    const uvAt = t * 6;
    const u0 = textured ? soup.uv[uvAt] : 0,
      v0 = textured ? soup.uv[uvAt + 1] : 0,
      u1 = textured ? soup.uv[uvAt + 2] : 0,
      v1 = textured ? soup.uv[uvAt + 3] : 0,
      u2 = textured ? soup.uv[uvAt + 4] : 0,
      v2 = textured ? soup.uv[uvAt + 5] : 0;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 =
          ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * inv;
        if (w0 < 0) continue;
        const w1 =
          ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * inv;
        if (w1 < 0) continue;
        const w2 =
          ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
        if (w2 < 0) continue;
        // Orthographic, so depth is linear in the barycentrics and the
        // interpolation is exact rather than an approximation to correct.
        const d = -(w0 * az + w1 * bz + w2 * cz);
        const at = y * size + x;
        if (d >= depth[at]) continue;
        depth[at] = d;
        triangle[at] = t;
        // The nearest corner owns the pixel, which keeps a border between two
        // parts where the geometry puts it instead of halfway across the
        // triangle that spans them.
        const near = w0 >= w1 ? (w0 >= w2 ? 0 : 2) : w1 >= w2 ? 1 : 2;
        part[at] = soup.owner[t * 3 + near];
        let r: number, g: number, bl: number;
        if (textured) {
          // Nearest texel. The atlas is drawn at a thousand texels a side and
          // the frame at five hundred pixels, so it is already oversampled;
          // filtering would cost a pass and show nothing.
          const u = w0 * u0 + w1 * u1 + w2 * u2;
          const v = w0 * v0 + w1 * v1 + w2 * v2;
          // Row 0 of an atlas is v = 1, which is the convention every writer
          // downstream of the bake uses. Clamped because a collapsed uv
          // triangle — decimation leaves a few — can land just outside.
          const tx = Math.min(aw - 1, Math.max(0, Math.floor(u * aw)));
          const ty = Math.min(ah - 1, Math.max(0, Math.floor((1 - v) * ah)));
          const texel = (ty * aw + tx) * 4;
          // The bake writes sRGB bytes; light is a linear factor. Multiplying
          // the byte directly would darken the pattern by a gamma.
          r = LINEAR[texels![texel]];
          g = LINEAR[texels![texel + 1]];
          bl = LINEAR[texels![texel + 2]];
        } else {
          const base = t * 9;
          r =
            w0 * soup.color[base] +
            w1 * soup.color[base + 3] +
            w2 * soup.color[base + 6];
          g =
            w0 * soup.color[base + 1] +
            w1 * soup.color[base + 4] +
            w2 * soup.color[base + 7];
          bl =
            w0 * soup.color[base + 2] +
            w1 * soup.color[base + 5] +
            w2 * soup.color[base + 8];
        }
        rgba[at * 4] = Math.round(toSrgb(r * light) * 255);
        rgba[at * 4 + 1] = Math.round(toSrgb(g * light) * 255);
        rgba[at * 4 + 2] = Math.round(toSrgb(bl * light) * 255);
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < part.length; i++) if (part[i] >= 0) covered++;
  return {
    view,
    size,
    rgba,
    part,
    triangle,
    depth,
    fill: covered / (size * size),
  };
}

/**
 * Render a built model from a set of angles.
 *
 * Deterministic: the same model renders to the same bytes, because nothing
 * here is sampled, jittered or timed. `ms` is the only field that varies, and
 * it is reported rather than drawn.
 */
export function renderModel(
  model: T.Object3D,
  options: RenderOptions = {},
): Render {
  const started = Date.now();
  const size = Math.max(16, Math.min(2048, Math.round(options.size ?? 512)));
  const views = options.views?.length ? options.views : DEFAULT_VIEWS;
  const margin = options.margin ?? 0.05;
  const background = options.background ?? BACKGROUND;
  const soup = readModel(model);
  return {
    parts: soup.parts,
    triangles: soup.count,
    owners: soup.owner,
    views: views.map((view) =>
      renderView(soup, view, size, margin, background),
    ),
    ms: Date.now() - started,
  };
}

/** The same renders, as encoded PNGs ready to be written or returned. */
export function renderPngs(model: T.Object3D, options: RenderOptions = {}) {
  const render = renderModel(model, options);
  return {
    ...render,
    images: render.views.map((view) => ({
      view: view.view,
      fill: view.fill,
      png: encodePng({ width: view.size, height: view.size, rgba: view.rgba }),
    })),
  };
}
