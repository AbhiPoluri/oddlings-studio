import * as T from 'three';
import {
  paintChannels,
  paintOut,
  sampleFrame,
  type PaintFrame,
  type PaintOut,
} from './asset-paint';
import { dilate, type ColorAtlas, type UvLayout } from './asset-uv';
import { mark, measure } from './perf';

/**
 * The atlas bake, one texel at a time.
 *
 * Paint used to be evaluated per vertex and interpolated across the triangle.
 * That is exactly as sharp as the mesh is dense, which on a decimated shell is
 * not sharp at all: a brick pattern on a wall that survived simplification as
 * forty triangles comes out as forty smears. Here the pattern is evaluated
 * where it is going to be *seen* — at every texel of every chart. Each
 * triangle is rasterised in uv space, the texel's barycentric weights are
 * turned back into a world-space point on the welded triangle, and the owning
 * part's expression is asked what it paints there. Triangle count stops
 * mattering; atlas resolution takes over.
 *
 * The same evaluation answers four more questions at once. A paint expression
 * may return `{ color, bump, roughness, metalness, emissive }` instead of a
 * colour, and each of those becomes a channel: `bump` is a height in metres,
 * finite-differenced along the triangle's own uv tangents to make a
 * tangent-space normal map, and the other three override the part's material
 * tuple per texel. The maps a model does not use are never allocated, so an
 * asset that paints nothing bakes exactly the one colour atlas it always did.
 *
 * WHY THIS RUNS ON THE WELDED MESH
 * `planUv` parks its plan on `geometry.userData.uvLayout` and `splitUvSeams`
 * only cuts the vertices at the export boundary. The plan already holds one uv
 * per triangle corner, which is all a rasteriser wants, so the bake can happen
 * before the cut — which is what lets the studio bake a preview in the worker
 * and still hand the main thread a welded mesh the audit can read. It works
 * after the cut too, off the real uv attribute, because the CLI splits first.
 */

/** Everything the rasteriser reads, however the caller happened to store it. */
type Source = {
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  /** Two floats per triangle corner, parallel to the index. */
  corners: Float32Array;
  /** Which part owns each vertex. */
  owners: Uint16Array;
  frames: PaintFrame[];
  size: number;
  gutter: number;
};

/** Which channels this model actually needs an image for. */
type Wanted = {
  roughness: boolean;
  metalness: boolean;
  emissive: boolean;
  normal: boolean;
};

export type BakeOptions = {
  /** Atlas edge in texels. Defaults to whatever the uv plan was packed for. */
  size?: number;
};

/**
 * Find the fused mesh and the record of its parts.
 *
 * Returns null for anything that is not a painted surface asset: a faceted
 * model has flat materials and no frames, and there is nothing a texture would
 * add to it.
 */
function sourceOf(model: T.Object3D, options: BakeOptions): Source | null {
  let found: Source | null = null;
  model.traverse((object) => {
    if (found || !(object instanceof T.Mesh)) return;
    const geometry = object.geometry;
    const frames = geometry.userData.surfacePaint as PaintFrame[] | undefined;
    const owners = (
      geometry.userData.surfaceOwners as { index: Uint16Array } | undefined
    )?.index;
    const index = geometry.index;
    if (!frames || !owners || !index) return;
    const positions = (geometry.attributes.position as T.BufferAttribute).array;

    const layout = geometry.userData.uvLayout as UvLayout | undefined;
    const atlas = geometry.userData.uvAtlas as
      | { size: number; gutter: number }
      | undefined;
    const uv = geometry.attributes.uv as T.BufferAttribute | undefined;
    let corners: Float32Array;
    let size: number;
    let gutter: number;
    if (layout) {
      corners = layout.corners;
      size = layout.size;
      gutter = layout.gutter;
    } else if (atlas && uv) {
      // Already split: the uvs live on the vertices, so gather them back into
      // one pair per corner and the loop below cannot tell the difference.
      corners = new Float32Array(index.count * 2);
      for (let corner = 0; corner < index.count; corner++) {
        const vertex = index.array[corner];
        corners[corner * 2] = uv.array[vertex * 2];
        corners[corner * 2 + 1] = uv.array[vertex * 2 + 1];
      }
      size = atlas.size;
      gutter = atlas.gutter;
    } else return;

    // A smaller atlas keeps the gutter the same fraction of the sheet, so the
    // dilation still fills exactly the padding the packer reserved.
    const wanted = options.size ?? size;
    found = {
      positions,
      index: index.array,
      corners,
      owners,
      frames,
      size: wanted,
      gutter: Math.max(1, Math.round((gutter * wanted) / size)),
    };
  });
  return found;
}

/**
 * Which channels are worth an image, decided before a texel is drawn.
 *
 * Asked of the parts rather than measured afterwards, because the alternative
 * is allocating five megabytes per channel to discover that four of them are
 * flat. A channel some part varies in is kept even if the variation turns out
 * to be invisible; a channel nothing mentions is never allocated at all.
 */
function wantedOf(frames: PaintFrame[]): Wanted {
  const wanted: Wanted = {
    roughness: false,
    metalness: false,
    emissive: false,
    normal: false,
  };
  const first = frames[0];
  for (const frame of frames) {
    if (frame.roughness !== first?.roughness) wanted.roughness = true;
    if (frame.metalness !== first?.metalness) wanted.metalness = true;
    if (frame.emissive) wanted.emissive = true;
    if (!frame.paint) continue;
    const channels = paintChannels(frame.paint);
    if (channels.roughness) wanted.roughness = true;
    if (channels.metalness) wanted.metalness = true;
    if (channels.emissive) wanted.emissive = true;
    if (channels.bump) wanted.normal = true;
  }
  return wanted;
}

/** Linear working colour to sRGB, the space a colour map is sampled in. */
function toSrgb(c: number) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function byte(v: number) {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

type Sheet = { rgba: Uint8Array; mask: Uint8Array };

function sheet(size: number): Sheet {
  return { rgba: new Uint8Array(size * size * 4), mask: new Uint8Array(size * size) };
}

function finish(drawn: Sheet, size: number, gutter: number): ColorAtlas {
  let covered = 0;
  for (let i = 0; i < drawn.mask.length; i++) if (drawn.mask[i]) covered++;
  dilate(drawn.rgba, drawn.mask, size, gutter);
  return { width: size, height: size, rgba: drawn.rgba, covered };
}

/**
 * Bake the atlas for a fused surface: colour, and whatever else it paints.
 *
 * Returns null for a model with no painted surface mesh. The result is a
 * `ColorAtlas` exactly as `bakeColorAtlas` returns one, so every writer
 * downstream — the PNG encoder, the OBJ material library, the zip — takes it
 * without knowing which baker produced it.
 */
export function bakeSurface(
  model: T.Object3D,
  options: BakeOptions = {},
): ColorAtlas | null {
  const source = sourceOf(model, options);
  if (!source) return null;
  const { positions, index, corners, owners, frames, size, gutter } = source;
  const wanted = wantedOf(frames);

  const colour = sheet(size);
  const roughness = wanted.roughness ? sheet(size) : null;
  const metalness = wanted.metalness ? sheet(size) : null;
  const emissive = wanted.emissive ? sheet(size) : null;
  const normal = wanted.normal ? sheet(size) : null;

  const out = paintOut();
  // Four more evaluations per texel, so they are only made where a height was
  // asked for, and only for the parts that ask.
  const slope = wanted.normal ? paintOut() : null;
  const bumps = frames.map((frame) =>
    Boolean(frame.paint && paintChannels(frame.paint).bump),
  );

  let lit = false;
  let roughVaries = false;
  let metalVaries = false;

  const write = (
    pixel: number,
    frame: PaintFrame,
    sample: PaintOut,
    normalXyz: readonly [number, number, number] | null,
  ) => {
    const set = (target: Sheet, r: number, g: number, b: number) => {
      target.rgba[pixel * 4] = r;
      target.rgba[pixel * 4 + 1] = g;
      target.rgba[pixel * 4 + 2] = b;
      target.rgba[pixel * 4 + 3] = 255;
      target.mask[pixel] = 1;
    };
    set(colour, byte(toSrgb(sample.r)), byte(toSrgb(sample.g)), byte(toSrgb(sample.b)));
    if (roughness) {
      // Linear, not sRGB: roughness and metalness are numbers an engine reads,
      // not light it shows.
      const v = sample.roughness < 0 ? frame.roughness : sample.roughness;
      if (v !== frames[0].roughness) roughVaries = true;
      const b = byte(v);
      set(roughness, b, b, b);
    }
    if (metalness) {
      const v = sample.metalness < 0 ? frame.metalness : sample.metalness;
      if (v !== frames[0].metalness) metalVaries = true;
      const b = byte(v);
      set(metalness, b, b, b);
    }
    if (emissive) {
      let er = sample.er,
        eg = sample.eg,
        eb = sample.eb;
      // A part whose material glows and whose paint said nothing about it
      // glows evenly, exactly as it did when the channel came off the vertices.
      if (!sample.emissiveSet && frame.emissive) {
        er = frame.emissive[0];
        eg = frame.emissive[1];
        eb = frame.emissive[2];
      }
      if (er > 1e-6 || eg > 1e-6 || eb > 1e-6) lit = true;
      set(emissive, byte(toSrgb(er)), byte(toSrgb(eg)), byte(toSrgb(eb)));
    }
    if (normal) {
      const n = normalXyz ?? FLAT;
      set(normal, byte(n[0] * 0.5 + 0.5), byte(n[1] * 0.5 + 0.5), byte(n[2] * 0.5 + 0.5));
    }
  };

  const triangles = index.length / 3;
  for (let t = 0; t < triangles; t++) {
    const a = index[t * 3],
      b = index[t * 3 + 1],
      c = index[t * 3 + 2];
    // Seam cutting makes every triangle single-owner, so any corner answers.
    const frame = frames[owners[a]] ?? frames[0];
    if (!frame) continue;
    const ax = corners[t * 6] * size,
      ay = (1 - corners[t * 6 + 1]) * size;
    const bx = corners[t * 6 + 2] * size,
      by = (1 - corners[t * 6 + 3]) * size;
    const cx = corners[t * 6 + 4] * size,
      cy = (1 - corners[t * 6 + 5]) * size;
    const p0x = positions[a * 3],
      p0y = positions[a * 3 + 1],
      p0z = positions[a * 3 + 2];
    const p1x = positions[b * 3],
      p1y = positions[b * 3 + 1],
      p1z = positions[b * 3 + 2];
    const p2x = positions[c * 3],
      p2y = positions[c * 3 + 1],
      p2z = positions[c * 3 + 2];

    // The triangle's own frame: how far the surface moves, in metres, per unit
    // of u and of v. One texel's worth of each is the finite-difference step
    // that turns a height field into a normal.
    let tux = 0,
      tuy = 0,
      tuz = 0,
      tvx = 0,
      tvy = 0,
      tvz = 0,
      tangents = false;
    if (normal && bumps[owners[a]]) {
      const u1 = corners[t * 6 + 2] - corners[t * 6],
        v1 = corners[t * 6 + 3] - corners[t * 6 + 1],
        u2 = corners[t * 6 + 4] - corners[t * 6],
        v2 = corners[t * 6 + 5] - corners[t * 6 + 1];
      const det = u1 * v2 - u2 * v1;
      if (Math.abs(det) > 1e-12) {
        const r = 1 / det;
        const e1x = p1x - p0x,
          e1y = p1y - p0y,
          e1z = p1z - p0z;
        const e2x = p2x - p0x,
          e2y = p2y - p0y,
          e2z = p2z - p0z;
        tux = (e1x * v2 - e2x * v1) * r;
        tuy = (e1y * v2 - e2y * v1) * r;
        tuz = (e1z * v2 - e2z * v1) * r;
        tvx = (e2x * u1 - e1x * u2) * r;
        tvy = (e2y * u1 - e1y * u2) * r;
        tvz = (e2z * u1 - e1z * u2) * r;
        tangents = true;
      }
    }

    const twice = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    let drawn = 0;
    if (Math.abs(twice) > 1e-9) {
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          // Texel centres sit at +0.5, so the raster grid is offset by half a
          // texel from uv space. Row 0 is v = 1: OBJ and glTF disagree about
          // which way v runs and the atlas is written the way the OBJ reads it.
          const px = x + 0.5,
            py = y + 0.5;
          const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / twice;
          const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / twice;
          const wc = 1 - wa - wb;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          const wx = wa * p0x + wb * p1x + wc * p2x;
          const wy = wa * p0y + wb * p1y + wc * p2y;
          const wz = wa * p0z + wb * p1z + wc * p2z;
          sampleFrame(frame, wx, wy, wz, out);
          write(
            y * size + x,
            frame,
            out,
            slope && tangents
              ? normalAt(frame, wx, wy, wz, tux, tuy, tuz, tvx, tvy, tvz, size, slope)
              : null,
          );
          drawn++;
        }
    }
    // A triangle thinner than a texel can miss every centre. Leaving it blank
    // would punch a hole the dilation then fills with a neighbour's colour, so
    // stamp its corners instead.
    if (!drawn)
      for (let e = 0; e < 3; e++) {
        const vertex = index[t * 3 + e];
        const x = Math.min(size - 1, Math.max(0, Math.floor(corners[t * 6 + e * 2] * size)));
        const y = Math.min(
          size - 1,
          Math.max(0, Math.floor((1 - corners[t * 6 + e * 2 + 1]) * size)),
        );
        sampleFrame(
          frame,
          positions[vertex * 3],
          positions[vertex * 3 + 1],
          positions[vertex * 3 + 2],
          out,
        );
        write(y * size + x, frame, out, null);
      }
  }

  const base = finish(colour, size, gutter);
  const maps: NonNullable<ColorAtlas['maps']> = {};
  if (roughness && roughVaries) maps.roughness = finish(roughness, size, gutter);
  if (metalness && metalVaries) maps.metalness = finish(metalness, size, gutter);
  if (emissive && lit) maps.emissive = finish(emissive, size, gutter);
  if (normal) maps.normal = finish(normal, size, gutter);
  // glTF packs roughness into green and metalness into blue of one image, and
  // three samples exactly those channels, so the packed sheet serves the export
  // and the viewport at once — and one texture instead of two is what lets
  // GLTFExporter write `metallicRoughnessTexture` at all.
  if (maps.roughness || maps.metalness)
    maps.metalRough = pack(maps.roughness, maps.metalness, size, frames);
  if (Object.keys(maps).length) base.maps = maps;
  return base;
}

const FLAT = [0, 0, 1] as const;
const normalXyz: [number, number, number] = [0, 0, 1];

/**
 * The tangent-space normal a height field implies at one texel.
 *
 * Central differences one texel apart along the triangle's own uv tangents,
 * divided by the metres those texels actually span, which makes the slope a
 * real gradient rather than a number that changes meaning with atlas size.
 *
 * The signs are glTF's, which is the convention the file has to be in: red
 * falls as the surface rises along +u, and green RISES as it rises along +v.
 * Green looks backwards written down and is not: glTF puts v = 0 at the top of
 * the image, so "green up" — up in the picture — is the direction of
 * decreasing v. Three derives its tangent frame from the same uvs with the
 * bitangent along +v, which is the opposite reading, and `dressTextures` hands
 * it `normalScale.y = -1` to turn this back — exactly what `GLTFLoader` does
 * to every tangent-less mesh it imports.
 */
function normalAt(
  frame: PaintFrame,
  x: number,
  y: number,
  z: number,
  tux: number,
  tuy: number,
  tuz: number,
  tvx: number,
  tvy: number,
  tvz: number,
  size: number,
  out: PaintOut,
): readonly [number, number, number] {
  const du = 1 / size,
    dv = 1 / size;
  const ux = tux * du,
    uy = tuy * du,
    uz = tuz * du;
  const vx = tvx * dv,
    vy = tvy * dv,
    vz = tvz * dv;
  const uLen = Math.hypot(ux, uy, uz);
  const vLen = Math.hypot(vx, vy, vz);
  if (uLen < 1e-9 || vLen < 1e-9) return FLAT;
  sampleFrame(frame, x + ux, y + uy, z + uz, out);
  const uPlus = out.bump;
  sampleFrame(frame, x - ux, y - uy, z - uz, out);
  const uMinus = out.bump;
  sampleFrame(frame, x + vx, y + vy, z + vz, out);
  const vPlus = out.bump;
  sampleFrame(frame, x - vx, y - vy, z - vz, out);
  const vMinus = out.bump;
  const dhdu = (uPlus - uMinus) / (2 * uLen);
  const dhdv = (vPlus - vMinus) / (2 * vLen);
  const nx = -dhdu,
    ny = dhdv,
    nz = 1;
  const length = Math.hypot(nx, ny, nz);
  normalXyz[0] = nx / length;
  normalXyz[1] = ny / length;
  normalXyz[2] = nz / length;
  return normalXyz;
}

/**
 * One image with roughness in green and metalness in blue.
 *
 * A channel with no image of its own is filled with the value every part
 * shares, so the packed sheet is always the whole answer and the material can
 * leave both factors at 1 and let the texture decide.
 */
function pack(
  roughness: ColorAtlas | undefined,
  metalness: ColorAtlas | undefined,
  size: number,
  frames: PaintFrame[],
): ColorAtlas {
  const rgba = new Uint8Array(size * size * 4);
  const flatRough = byte(frames[0]?.roughness ?? 1);
  const flatMetal = byte(frames[0]?.metalness ?? 0);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = roughness ? roughness.rgba[i * 4] : flatRough;
    rgba[i * 4 + 2] = metalness ? metalness.rgba[i * 4] : flatMetal;
    rgba[i * 4 + 3] = 255;
  }
  return {
    width: size,
    height: size,
    rgba,
    covered: roughness?.covered ?? metalness?.covered ?? 0,
  };
}

/**
 * The atlas as three textures.
 *
 * Every sheet is written with row 0 at v = 1, which is the convention the OBJ
 * and its PNG have always used. A GL texture samples v = 0 from its first row,
 * so the rows are reversed on the way into a `DataTexture` and `flipY` stays
 * off — rather than the other way round, because `flipY` on a data texture is
 * applied with a canvas transform that `putImageData` ignores, so the flip
 * three's exporter thinks it is doing never happens.
 */
export type AtlasTextures = {
  map: T.DataTexture;
  normalMap?: T.DataTexture;
  metalRough?: T.DataTexture;
  emissiveMap?: T.DataTexture;
};

function flipRows(atlas: ColorAtlas) {
  const { width, height, rgba } = atlas;
  const stride = width * 4;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y++)
    out.set(rgba.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  return out;
}

function texture(atlas: ColorAtlas, srgb: boolean) {
  const made = new T.DataTexture(flipRows(atlas), atlas.width, atlas.height);
  made.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
  made.wrapS = T.ClampToEdgeWrapping;
  made.wrapT = T.ClampToEdgeWrapping;
  made.magFilter = T.LinearFilter;
  made.minFilter = T.LinearMipmapLinearFilter;
  made.generateMipmaps = true;
  made.anisotropy = 4;
  made.flipY = false;
  made.needsUpdate = true;
  return made;
}

export function atlasTextures(atlas: ColorAtlas): AtlasTextures {
  const maps = atlas.maps;
  return {
    map: texture(atlas, true),
    ...(maps?.normal ? { normalMap: texture(maps.normal, false) } : {}),
    ...(maps?.metalRough ? { metalRough: texture(maps.metalRough, false) } : {}),
    ...(maps?.emissive ? { emissiveMap: texture(maps.emissive, true) } : {}),
  };
}

/**
 * Hang the baked maps on whatever materials the fused mesh is wearing.
 *
 * Every factor a map covers goes to 1, because a renderer multiplies the two:
 * leaving roughness at the part's own 0.3 with a roughness map on top would
 * darken the map by that much again. The colour map replaces the vertex
 * colours for the same reason — glTF multiplies COLOR_0 into the base colour,
 * so a mesh carrying both shows the pattern squared.
 */
export function dressTextures(model: T.Object3D, textures: AtlasTextures) {
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (!object.geometry.userData.surfacePaint) return;
    const worn = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of worn) {
      const standard = material as T.MeshStandardMaterial;
      if (!standard.isMeshStandardMaterial) continue;
      standard.map = textures.map;
      standard.color = new T.Color(0xffffff);
      standard.vertexColors = false;
      if (textures.normalMap) {
        standard.normalMap = textures.normalMap;
        // Green points the other way when three derives the tangent frame in
        // the shader instead of reading a TANGENT attribute — which is the
        // case for every mesh this studio builds. `GLTFLoader` negates exactly
        // this on import (see its note on three.js#11438), so negating it here
        // means the atlas is written in glTF's convention, the viewport shows
        // what a glTF viewer will, and `GLTFExporter` passes the image through
        // untouched rather than rebuilding it through a canvas.
        standard.normalScale = new T.Vector2(1, -1);
      }
      if (textures.metalRough) {
        standard.roughnessMap = textures.metalRough;
        standard.metalnessMap = textures.metalRough;
        standard.roughness = 1;
        standard.metalness = 1;
      }
      if (textures.emissiveMap) {
        standard.emissiveMap = textures.emissiveMap;
        // The map carries the colour; the factor has to be white or it tints
        // the image a second time. Strength stays where the author put it.
        standard.emissive = new T.Color(0xffffff);
      }
      standard.needsUpdate = true;
    }
  });
  return model;
}

/** Does any part of this model paint something a flat colour cannot say? */
export function paintsTexels(model: T.Object3D): boolean {
  let paints = false;
  model.traverse((object) => {
    if (paints || !(object instanceof T.Mesh)) return;
    const frames = object.geometry.userData.surfacePaint as
      | PaintFrame[]
      | undefined;
    if (frames?.some((frame) => frame.paint)) paints = true;
  });
  return paints;
}

/**
 * Throw away the vertex colours a baked colour atlas has replaced.
 *
 * glTF multiplies COLOR_0 into the base colour, and three's loader turns
 * vertex colours back on whenever the attribute is there, so a mesh that
 * shipped both would show every pattern squared — dark where the atlas is
 * dark, and darker still. The atlas says strictly more than the attribute did,
 * at texel resolution rather than vertex resolution, so the attribute goes.
 * Only on the export copy: the built model keeps its colours, which is what
 * the viewport falls back to and what the OBJ has always been written from.
 */
export function dropVertexColours(model: T.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const material = Array.isArray(object.material)
      ? object.material[0]
      : object.material;
    if (!(material as T.MeshStandardMaterial)?.map) return;
    object.geometry.deleteAttribute('color');
  });
  return model;
}

/**
 * Take the bake's working notes off the geometry before it is written out.
 *
 * `GLTFExporter` copies `geometry.userData` into the primitive's `extras` as
 * JSON, so anything parked there for the studio's own use ends up in the file.
 * A baked atlas is four megabytes of bytes, and four megabytes of bytes as a
 * JSON object is not something anyone should find inside a GLB.
 */
export function stripBakeData(model: T.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    delete object.geometry.userData.bakedMaps;
  });
  return model;
}

/**
 * Has this model already been given its maps?
 *
 * `writeAsset` exports the same model twice when it is asked for a GLB and a
 * Unity zip, and the second pass must not bake a second atlas and hand the
 * first one's textures to the garbage collector.
 */
export function alreadyTextured(model: T.Object3D): boolean {
  let dressed = false;
  model.traverse((object) => {
    if (dressed || !(object instanceof T.Mesh)) return;
    const worn = Array.isArray(object.material) ? object.material : [object.material];
    if (worn.some((material) => (material as T.MeshStandardMaterial).map))
      dressed = true;
  });
  return dressed;
}

/**
 * The atlas as plain arrays, for the trip back from the build worker.
 *
 * Structured clone carries typed arrays and nothing else, so the bake crosses
 * the wire as bytes and is turned back into textures on the other side. Only
 * the maps a viewport can draw travel: the per-channel roughness and metalness
 * sheets exist to be written as PNGs beside an OBJ and the packed one is what
 * a renderer samples.
 */
export type BakedMaps = {
  size: number;
  color: Uint8Array;
  normal?: Uint8Array;
  metalRough?: Uint8Array;
  emissive?: Uint8Array;
};

export function packMaps(atlas: ColorAtlas): BakedMaps {
  return {
    size: atlas.width,
    color: atlas.rgba,
    ...(atlas.maps?.normal ? { normal: atlas.maps.normal.rgba } : {}),
    ...(atlas.maps?.metalRough ? { metalRough: atlas.maps.metalRough.rgba } : {}),
    ...(atlas.maps?.emissive ? { emissive: atlas.maps.emissive.rgba } : {}),
  };
}

function sheetOf(rgba: Uint8Array, size: number): ColorAtlas {
  return { width: size, height: size, rgba, covered: 0 };
}

export function unpackMaps(maps: BakedMaps): ColorAtlas {
  const atlas = sheetOf(maps.color, maps.size);
  const rest: NonNullable<ColorAtlas['maps']> = {};
  if (maps.normal) rest.normal = sheetOf(maps.normal, maps.size);
  if (maps.metalRough) rest.metalRough = sheetOf(maps.metalRough, maps.size);
  if (maps.emissive) rest.emissive = sheetOf(maps.emissive, maps.size);
  if (Object.keys(rest).length) atlas.maps = rest;
  return atlas;
}

/**
 * Bake the preview atlas and park it on the geometry, in whatever thread the
 * build is running in.
 *
 * The studio builds in a worker and the model comes back as attributes, index
 * and userData, so this is the one place the bake can happen without the main
 * thread stopping to rasterise a million texels between keystrokes. Half the
 * export resolution, because a preview is looked at and not shipped.
 */
export const PREVIEW_SIZE = 1024;

export function bakePreview(model: T.Object3D, size = PREVIEW_SIZE) {
  if (!paintsTexels(model)) return model;
  const started = mark();
  const atlas = bakeSurface(model, { size });
  measure('surface.bake', started);
  if (!atlas) return model;
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (!object.geometry.userData.surfacePaint) return;
    object.geometry.userData.bakedMaps = packMaps(atlas);
  });
  return model;
}
