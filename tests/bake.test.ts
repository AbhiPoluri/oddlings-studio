import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import * as T from 'three';
import { buildSpec, parseSpec, type AssetSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { bakePreview, bakeSurface, packMaps, unpackMaps } from '../lib/asset-bake';
import { paintOut, sampleFrame, type PaintFrame } from '../lib/asset-paint';
import type { UvLayout } from '../lib/asset-uv';
import { disposeScene } from '../lib/three-world';

await readySurface();

const SIZE = 256;

function scene(parts: AssetSpec['parts'], budget = 900): AssetSpec {
  return parseSpec({
    version: 1,
    name: 'Bake Scene',
    kind: 'prop',
    seed: 5,
    scale: 1,
    color: '#b4a894',
    surface: { blend: 0.02, detail: 64, budget, shading: 'smooth' },
    parts,
  });
}

function fusedMesh(model: T.Object3D) {
  let found: T.Mesh | null = null;
  model.traverse((object) => {
    if (!found && object instanceof T.Mesh && object.geometry.userData.uvLayout)
      found = object;
  });
  if (!found) throw Error('no fused mesh with a uv plan');
  return found as T.Mesh;
}

/** The encoding the bake writes colour in, restated rather than imported. */
function srgbByte(linear: number) {
  const v = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

describe('paint is baked per texel', () => {
  test('a texel holds the expression evaluated at its own point', () => {
    // A pattern with a hard edge and no relation to where the vertices are:
    // an interpolated bake cannot reproduce it, and a per-texel one can only
    // get it right by asking the expression at the texel's own position.
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'slab',
          size: [2, 0.4, 2],
          paint:
            "const b = s.bricks(x * size[0], z * size[2], 0.3, 0.04); return b.m > 0.5 ? s.rgb('#c04a2a') : s.rgb('#d8d2c4')",
        },
      ]),
    );
    try {
      const mesh = fusedMesh(model);
      const atlas = bakeSurface(model, { size: SIZE })!;
      expect(atlas).not.toBeNull();
      const geometry = mesh.geometry;
      const layout = geometry.userData.uvLayout as UvLayout;
      const frames = geometry.userData.surfacePaint as PaintFrame[];
      const owners = (geometry.userData.surfaceOwners as { index: Uint16Array })
        .index;
      const position = (geometry.attributes.position as T.BufferAttribute).array;
      const index = geometry.index!.array;
      const out = paintOut();

      let checked = 0;
      let matched = 0;
      for (let t = 0; t < index.length / 3; t++) {
        // The triangle's centroid, in uv and in the world, which are the same
        // point under the barycentric map the bake uses.
        const u =
          (layout.corners[t * 6] +
            layout.corners[t * 6 + 2] +
            layout.corners[t * 6 + 4]) /
          3;
        const v =
          (layout.corners[t * 6 + 1] +
            layout.corners[t * 6 + 3] +
            layout.corners[t * 6 + 5]) /
          3;
        const x = Math.floor(u * SIZE);
        const y = Math.floor((1 - v) * SIZE);
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const pixel = (y * SIZE + x) * 4;
        if (!atlas.rgba[pixel + 3]) continue;
        let px = 0,
          py = 0,
          pz = 0;
        for (let e = 0; e < 3; e++) {
          const vertex = index[t * 3 + e];
          px += position[vertex * 3] / 3;
          py += position[vertex * 3 + 1] / 3;
          pz += position[vertex * 3 + 2] / 3;
        }
        sampleFrame(frames[owners[index[t * 3]]], px, py, pz, out);
        checked++;
        const near =
          Math.abs(atlas.rgba[pixel] - srgbByte(out.r)) <= 2 &&
          Math.abs(atlas.rgba[pixel + 1] - srgbByte(out.g)) <= 2 &&
          Math.abs(atlas.rgba[pixel + 2] - srgbByte(out.b)) <= 2;
        if (near) matched++;
      }
      expect(checked).toBeGreaterThan(30);
      // Not every centroid lands in its own triangle's covered texels — a
      // sliver can round into a neighbour's — so this is a strong majority
      // rather than a certainty. Interpolation would fail nearly all of them.
      expect(matched / checked).toBeGreaterThan(0.9);
    } finally {
      disposeScene(model);
    }
  }, 60000);

  test('the pattern stays crisp on a mesh with almost no triangles', () => {
    const model = buildSpec(
      scene(
        [
          {
            shape: 'box',
            name: 'slab',
            size: [2, 0.4, 2],
            paint:
              "return M.floor((x * size[0]) / 0.25) % 2 === 0 ? s.rgb('#ff0000') : s.rgb('#0000ff')",
          },
        ],
        400,
      ),
    );
    try {
      const mesh = fusedMesh(model);
      const triangles = mesh.geometry.index!.count / 3;
      const atlas = bakeSurface(model, { size: SIZE })!;
      let red = 0,
        blue = 0,
        other = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (!atlas.rgba[i * 4 + 3]) continue;
        const r = atlas.rgba[i * 4],
          g = atlas.rgba[i * 4 + 1],
          b = atlas.rgba[i * 4 + 2];
        if (r > 240 && g < 15 && b < 15) red++;
        else if (b > 240 && g < 15 && r < 15) blue++;
        else other++;
      }
      const covered = red + blue + other;
      // A 2 m slab of eight stripes on this few triangles: per vertex, the
      // stripes would be a gradient and almost every texel would be "other".
      expect(triangles).toBeLessThan(700);
      expect(red / covered).toBeGreaterThan(0.25);
      expect(blue / covered).toBeGreaterThan(0.25);
      // What is left is the edge between two stripes and the dilated gutter.
      expect(other / covered).toBeLessThan(0.2);
    } finally {
      disposeScene(model);
    }
  }, 60000);

  test('a part with no paint fills with its flat colour', () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'painted',
          size: [1.2, 0.4, 1.2],
          paint: "s.rgb('#ff00ff')",
        },
        {
          shape: 'box',
          name: 'plain',
          size: [1.2, 0.4, 1.2],
          position: [0, 0.4, 0],
          color: '#204080',
        },
      ]),
    );
    try {
      const atlas = bakeSurface(model, { size: SIZE })!;
      const flat = new T.Color('#204080');
      const wanted = [srgbByte(flat.r), srgbByte(flat.g), srgbByte(flat.b)];
      let exact = 0;
      for (let i = 0; i < SIZE * SIZE; i++)
        if (
          atlas.rgba[i * 4] === wanted[0] &&
          atlas.rgba[i * 4 + 1] === wanted[1] &&
          atlas.rgba[i * 4 + 2] === wanted[2]
        )
          exact++;
      expect(exact).toBeGreaterThan(200);
    } finally {
      disposeScene(model);
    }
  }, 60000);
});

describe('the normal map', () => {
  test('encodes the slope a bump describes, and stays flat without one', () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'ramp',
          size: [2, 0.4, 2],
          // A height that rises a quarter of a metre per metre along the
          // part's own x. Every face but the two facing x sees that slope.
          paint: 'return { color: base, bump: 0.25 * x * size[0] }',
        },
      ]),
    );
    try {
      const atlas = bakeSurface(model, { size: SIZE })!;
      const normal = atlas.maps?.normal;
      expect(normal).toBeDefined();
      let sloped = 0,
        flat = 0,
        covered = 0,
        inward = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (!normal!.rgba[i * 4 + 3]) continue;
        covered++;
        const nx = (normal!.rgba[i * 4] / 255) * 2 - 1;
        const ny = (normal!.rgba[i * 4 + 1] / 255) * 2 - 1;
        const nz = (normal!.rgba[i * 4 + 2] / 255) * 2 - 1;
        // Whatever else it is, an encoded normal is a unit vector out of the
        // surface — except in the dilated gutter, where texels are the average
        // of their neighbours and an average of unit vectors is shorter.
        if (nz <= 0 || Math.abs(Math.hypot(nx, ny, nz) - 1) > 0.02) inward++;
        const tilt = Math.hypot(nx, ny);
        // atan of the slope: 0.25 metres per metre reads as a tilt of
        // 0.25 / sqrt(1 + 0.25^2) = 0.2425 in the xy plane.
        if (Math.abs(tilt - 0.2425) < 0.03) sloped++;
        else if (tilt < 0.02) flat++;
      }
      expect(covered).toBeGreaterThan(1000);
      expect(inward / covered).toBeLessThan(0.05);
      // Four of the six faces of the slab see the ramp; the two facing x see a
      // constant height and come out flat.
      expect(sloped / covered).toBeGreaterThan(0.6);
      expect(flat).toBeGreaterThan(0);
    } finally {
      disposeScene(model);
    }
  }, 60000);

  test('green follows glTF, not the frame three derives in the shader', () => {
    // The one sign in this pipeline that cannot be checked by eye at atlas
    // resolution, and the one every normal-map bug is made of. The atlas is
    // written in glTF's convention - red falls as the surface rises along +u,
    // green RISES as it rises along +v, because glTF puts v = 0 at the top of
    // the image - and `dressTextures` hands three `normalScale.y = -1` to read
    // it back, exactly as `GLTFLoader` does for a mesh with no tangents.
    const slope = 0.25;
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'ramp',
          size: [2, 0.4, 2],
          paint: `return { color: base, bump: ${slope} * z * size[2] }`,
        },
      ]),
    );
    try {
      const geometry = fusedMesh(model).geometry;
      const atlas = bakeSurface(model, { size: SIZE })!;
      const normal = atlas.maps!.normal!;
      const layout = geometry.userData.uvLayout as UvLayout;
      const position = (geometry.attributes.position as T.BufferAttribute).array;
      const index = geometry.index!.array;

      let checked = 0,
        matched = 0;
      for (let t = 0; t < index.length / 3; t++) {
        const u0 = layout.corners[t * 6],
          v0 = layout.corners[t * 6 + 1];
        const u1 = layout.corners[t * 6 + 2] - u0,
          vv1 = layout.corners[t * 6 + 3] - v0;
        const u2 = layout.corners[t * 6 + 4] - u0,
          vv2 = layout.corners[t * 6 + 5] - v0;
        const det = u1 * vv2 - u2 * vv1;
        if (Math.abs(det) < 1e-9) continue;
        const a = index[t * 3],
          b = index[t * 3 + 1],
          c = index[t * 3 + 2];
        const e1 = [
          position[b * 3] - position[a * 3],
          position[b * 3 + 1] - position[a * 3 + 1],
          position[b * 3 + 2] - position[a * 3 + 2],
        ];
        const e2 = [
          position[c * 3] - position[a * 3],
          position[c * 3 + 1] - position[a * 3 + 1],
          position[c * 3 + 2] - position[a * 3 + 2],
        ];
        // The surface's own axes: metres per unit of u, and per unit of v.
        const du = e1.map((v, i) => ((v * vv2 - e2[i] * vv1) / det) as number);
        const dv = e1.map((v, i) => ((e2[i] * u1 - v * u2) / det) as number);
        const uLen = Math.hypot(...du),
          vLen = Math.hypot(...dv);
        if (uLen < 1e-9 || vLen < 1e-9) continue;
        // The height is `slope` metres per metre of world z, so its gradient
        // is a constant vector and its slope along any direction is a dot
        // product. No finite differences here: this is the answer the bake
        // should have arrived at, worked out independently.
        const dhdu = (slope * du[2]) / uLen;
        const dhdv = (slope * dv[2]) / vLen;
        const length = Math.hypot(dhdu, dhdv, 1);
        const wantX = Math.round((-dhdu / length) * 0.5 * 255 + 127.5);
        const wantY = Math.round((dhdv / length) * 0.5 * 255 + 127.5);

        const x = Math.floor(
          ((layout.corners[t * 6] +
            layout.corners[t * 6 + 2] +
            layout.corners[t * 6 + 4]) /
            3) *
            SIZE,
        );
        const y = Math.floor(
          (1 -
            (layout.corners[t * 6 + 1] +
              layout.corners[t * 6 + 3] +
              layout.corners[t * 6 + 5]) /
              3) *
            SIZE,
        );
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const pixel = (y * SIZE + x) * 4;
        if (!atlas.rgba[pixel + 3]) continue;
        checked++;
        if (
          Math.abs(normal.rgba[pixel] - wantX) <= 3 &&
          Math.abs(normal.rgba[pixel + 1] - wantY) <= 3
        )
          matched++;
      }
      expect(checked).toBeGreaterThan(20);
      expect(matched / checked).toBeGreaterThan(0.9);
    } finally {
      disposeScene(model);
    }
  }, 60000);

  test('no bump anywhere means no normal map at all', () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'slab',
          size: [1.2, 0.4, 1.2],
          paint: "s.shade(base, 0.5 + 0.5 * s.step(-0.2, 0.2, x))",
        },
      ]),
    );
    try {
      const atlas = bakeSurface(model, { size: SIZE })!;
      expect(atlas.maps?.normal).toBeUndefined();
      expect(atlas.maps?.metalRough).toBeUndefined();
    } finally {
      disposeScene(model);
    }
  }, 60000);
});

describe('roughness and metalness per texel', () => {
  test('a paint expression overrides the part tuple, and packs the glTF way', () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'slab',
          size: [2, 0.4, 2],
          material: { roughness: 1, metalness: 0 },
          paint:
            'const k = x > 0 ? 1 : 0; return { color: base, roughness: k, metalness: k }',
        },
      ]),
    );
    try {
      const atlas = bakeSurface(model, { size: SIZE })!;
      const packed = atlas.maps?.metalRough;
      expect(packed).toBeDefined();
      let rough = 0,
        smooth = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (!atlas.rgba[i * 4 + 3]) continue;
        // Green is roughness and blue is metalness, which is how glTF packs
        // them and which channels three samples.
        const g = packed!.rgba[i * 4 + 1];
        const b = packed!.rgba[i * 4 + 2];
        if (g > 250 && b > 250) rough++;
        if (g < 5 && b < 5) smooth++;
      }
      expect(rough).toBeGreaterThan(100);
      expect(smooth).toBeGreaterThan(100);
    } finally {
      disposeScene(model);
    }
  }, 60000);
});

describe('the preview bake', () => {
  test('parks the maps on the geometry and survives the trip as bytes', () => {
    const model = buildSpec(
      scene([
        {
          shape: 'box',
          name: 'slab',
          size: [1.2, 0.4, 1.2],
          material: 'bricks',
        },
      ]),
    );
    try {
      bakePreview(model, 128);
      const maps = fusedMesh(model).geometry.userData.bakedMaps as
        | ReturnType<typeof packMaps>
        | undefined;
      expect(maps).toBeDefined();
      expect(maps!.size).toBe(128);
      expect(maps!.color.length).toBe(128 * 128 * 4);
      expect(maps!.normal).toBeDefined();
      const back = unpackMaps(maps!);
      expect(back.width).toBe(128);
      expect(back.maps?.normal?.rgba).toBe(maps!.normal);
    } finally {
      disposeScene(model);
    }
  }, 60000);

  test('an unpainted spec bakes no preview at all', () => {
    const model = buildSpec(
      scene([{ shape: 'box', name: 'slab', size: [1, 0.4, 1], color: '#889988' }]),
    );
    try {
      bakePreview(model, 128);
      expect(fusedMesh(model).geometry.userData.bakedMaps).toBeUndefined();
    } finally {
      disposeScene(model);
    }
  }, 60000);
});
