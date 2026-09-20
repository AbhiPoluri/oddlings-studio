'use client';
/**
 * The viewport's filter stack, as three.js passes.
 *
 * One `EffectComposer` whose buffers are sized to the *filter* resolution
 * rather than to the canvas. That is the whole trick behind Pixelate: with a
 * block size of 4 the scene is rendered into a buffer a quarter as wide, and
 * the final pass magnifies it onto the canvas with nearest taps — so a block
 * is four CSS pixels whatever the panel is doing and whatever `devicePixelRatio`
 * says, and a quarter of the fragments are shaded. The old "Pixel preview"
 * shrank the drawing buffer to 0.45× and left the browser to scale it, which
 * meant the block size was whatever the layout happened to make it.
 *
 * The chain is built once and never rebuilt: a filter turning off flips
 * `pass.enabled`, a slider writes a uniform, and a block size change is a
 * `setSize`. Nothing here allocates per frame, and the viewport does not build
 * a chain at all until the first filter is switched on.
 *
 * Pass order, which `filters.ts` documents as the fixed one:
 *
 *   RenderPass → OutputPass → Outline → Posterize/Dither → Screen
 *
 * `OutputPass` sits second on purpose. It is where tone mapping and the sRGB
 * transfer happen, and everything after it therefore works in the colours you
 * can see: quantising linear light crushes the darks into one band, and a
 * near-black outline ink written into a linear buffer comes back grey.
 */
import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Filters } from '@/components/studio/filters';

/** Every pass shares this: a full-screen triangle's worth of UVs. */
const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Ordered Bayer thresholds, in closed form.
 *
 * A `const float[64]` indexed by a computed index is not something a WebGL1
 * GLSL shader may do, and `ShaderMaterial` compiles as GLSL ES 1.00 unless it
 * is asked not to — so the matrices are generated instead of tabulated. The
 * recursion is the standard one: `bayer2` is [[0,2],[3,1]]/4, and each larger
 * matrix is the next one down, quartered, plus the 2×2 again.
 *
 * The coordinate is folded to 0..8 before it gets here. `a.y * a.y` at a
 * thousand pixels down the screen is large enough that `fract` of it has lost
 * the low bits, which shows up as the pattern drifting down the image.
 */
const BAYER = /* glsl */ `
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(a * 0.5) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(a * 0.5) * 0.25 + bayer2(a); }
float bayer(vec2 a, float size) {
  vec2 p = mod(floor(a), 8.0);
  if (size < 3.0) return bayer2(p);
  if (size < 6.0) return bayer4(p);
  return bayer8(p);
}
`;

/**
 * Edge lines from the depth and normal buffers.
 *
 * Both are needed and neither is enough: depth alone misses the crease where
 * two faces of one box meet, and normals alone miss the silhouette of a shape
 * standing in front of another at the same angle. The depth comparison is
 * relative to the distance at the fragment, so a line does not thin out as the
 * camera pulls back.
 */
const OUTLINE_SHADER = {
  name: 'OddlingsOutline',
  uniforms: {
    tDiffuse: { value: null as T.Texture | null },
    tNormal: { value: null as T.Texture | null },
    tDepth: { value: null as T.Texture | null },
    uResolution: { value: new T.Vector2(1, 1) },
    uThickness: { value: 1 },
    uThreshold: { value: 0.35 },
    uMix: { value: 1 },
    uColor: { value: new T.Color('#0b0f10') },
    uNear: { value: 0.1 },
    uFar: { value: 100 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uThickness;
uniform float uThreshold;
uniform float uMix;
uniform vec3 uColor;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

/** Window depth to distance in front of the eye. */
float distanceAt(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return (uNear * uFar) / (uFar - d * (uFar - uNear));
}

vec3 normalAt(vec2 uv) {
  return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec2 texel = uThickness / uResolution;
  vec2 offsets[4];
  offsets[0] = vec2(texel.x, 0.0);
  offsets[1] = vec2(-texel.x, 0.0);
  offsets[2] = vec2(0.0, texel.y);
  offsets[3] = vec2(0.0, -texel.y);

  float here = distanceAt(vUv);
  vec3 normal = normalAt(vUv);
  float depthEdge = 0.0;
  float normalEdge = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 uv = clamp(vUv + offsets[i], vec2(0.0), vec2(1.0));
    depthEdge = max(depthEdge, abs(distanceAt(uv) - here));
    normalEdge = max(normalEdge, 1.0 - dot(normal, normalAt(uv)));
  }
  depthEdge /= max(here, 1e-4);

  // The two thresholds move together off one slider, because "more lines" is
  // the only thing anyone actually wants to ask for.
  float depthLimit = mix(0.002, 0.06, uThreshold);
  float normalLimit = mix(0.06, 0.9, uThreshold);
  float edge = max(step(depthLimit, depthEdge), step(normalLimit, normalEdge));
  gl_FragColor = vec4(mix(base.rgb, uColor, edge * uMix), base.a);
}
`,
};

/**
 * Posterise and dither, in one pass because they are one operation.
 *
 * Dithering is a way of choosing which of the two nearest levels a colour
 * lands on, so it cannot be a pass of its own that runs before or after the
 * quantiser — it is an offset added inside it.
 */
const QUANTIZE_SHADER = {
  name: 'OddlingsQuantize',
  uniforms: {
    tDiffuse: { value: null as T.Texture | null },
    uResolution: { value: new T.Vector2(1, 1) },
    uLevels: { value: 8 },
    uMix: { value: 1 },
    uDither: { value: 0 },
    uMatrix: { value: 4 },
    uDitherMix: { value: 0.7 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uLevels;
uniform float uMix;
uniform float uDither;
uniform float uMatrix;
uniform float uDitherMix;
varying vec2 vUv;

${BAYER}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float steps = max(1.0, uLevels - 1.0);
  // One Bayer cell per rendered pixel, which under Pixelate is one cell per
  // block — the look the pattern is for.
  float threshold = uDither > 0.5
    ? (bayer(vUv * uResolution, uMatrix) - 0.5) * uDitherMix
    : 0.0;
  vec3 quantized = clamp(
    floor(base.rgb * steps + 0.5 + threshold) / steps,
    0.0,
    1.0
  );
  gl_FragColor = vec4(mix(base.rgb, quantized, uMix), base.a);
}
`,
};

/**
 * The one pass that runs at the size of the canvas.
 *
 * Everything before it drew into the filter-resolution buffers; this magnifies
 * that onto the drawing buffer, and does the effects that are only meaningful
 * in final pixels — scanline spacing, the vignette, the sharpen kernel. It is
 * always in the chain, even with every filter off, because it is also the only
 * thing that puts the composer's output on the screen.
 */
const SCREEN_SHADER = {
  name: 'OddlingsScreen',
  uniforms: {
    tDiffuse: { value: null as T.Texture | null },
    /** The drawing buffer, in device pixels. */
    uResolution: { value: new T.Vector2(1, 1) },
    /** The buffer being magnified, in its own pixels. */
    uSource: { value: new T.Vector2(1, 1) },
    /** Device pixels per block, when blocks are locked to whole pixels. */
    uBlock: { value: 1 },
    uSnap: { value: 0 },
    /** 1 keeps the hard block edges; below that they soften toward bilinear. */
    uCrisp: { value: 1 },
    uSharpen: { value: 0 },
    uScan: { value: 0 },
    uScanSpacing: { value: 3 },
    uVignette: { value: 0 },
    uVignetteSoft: { value: 0.55 },
  },
  vertexShader: VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform vec2 uSource;
uniform float uBlock;
uniform float uSnap;
uniform float uCrisp;
uniform float uSharpen;
uniform float uScan;
uniform float uScanSpacing;
uniform float uVignette;
uniform float uVignetteSoft;
varying vec2 vUv;

/**
 * Bilinear by hand.
 *
 * The buffers are nearest-filtered, which is the point — but the Pixelate mix
 * slider wants to be able to ask for the smooth upscale as well, and that is
 * four taps rather than a second copy of every render target.
 */
vec3 smoothSample(vec2 uv) {
  vec2 p = uv * uSource - 0.5;
  vec2 f = fract(p);
  vec2 base = (floor(p) + 0.5) / uSource;
  vec2 texel = 1.0 / uSource;
  vec3 a = texture2D(tDiffuse, base).rgb;
  vec3 b = texture2D(tDiffuse, base + vec2(texel.x, 0.0)).rgb;
  vec3 c = texture2D(tDiffuse, base + vec2(0.0, texel.y)).rgb;
  vec3 d = texture2D(tDiffuse, base + texel).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = vUv;
  if (uSnap > 0.5) {
    // Blocks anchored to whole device pixels, so none of them comes out a
    // pixel wider than its neighbour on the way up.
    vec2 cell = floor(vUv * uResolution / max(uBlock, 1.0));
    uv = (min(cell, uSource - 1.0) + 0.5) / uSource;
  }
  vec3 color = texture2D(tDiffuse, uv).rgb;
  if (uCrisp < 1.0) color = mix(smoothSample(vUv), color, uCrisp);

  if (uSharpen > 0.0) {
    vec2 texel = 1.0 / uSource;
    vec3 blurred =
      (texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb +
       texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb +
       texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb +
       texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb) * 0.25;
    color = mix(color, clamp(color + (color - blurred) * 1.4, 0.0, 1.0), uSharpen);
  }

  if (uScan > 0.0) {
    float line = 0.5 + 0.5 * cos(6.2831853 * vUv.y * uResolution.y / max(uScanSpacing, 1.0));
    color *= 1.0 - uScan * line;
  }

  if (uVignette > 0.0) {
    float radius = length(vUv - 0.5) * 1.41421356;
    float shade = 1.0 - smoothstep(uVignetteSoft * 0.85, 1.05, radius);
    color *= mix(1.0, shade, uVignette);
  }

  gl_FragColor = vec4(color, 1.0);
}
`,
};

export type FilterChain = {
  /** Draw one frame through the stack, onto the canvas. */
  render: () => void;
  /**
   * Tell the chain how big the viewport is.
   *
   * `width`/`height` are CSS pixels — a block size is in those — and `ratio`
   * is what the renderer's drawing buffer is scaled by.
   */
  setSize: (width: number, height: number, ratio: number) => void;
  /** Push the settings into the passes. Cheap; nothing is rebuilt. */
  apply: (filters: Filters) => void;
  dispose: () => void;
};

type Size = { width: number; height: number; ratio: number };

/** Nearest everywhere, so magnifying the small buffer gives edges not blur. */
function buffer(width: number, height: number): T.WebGLRenderTarget {
  return new T.WebGLRenderTarget(width, height, {
    type: T.HalfFloatType,
    minFilter: T.NearestFilter,
    magFilter: T.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
}

export function createFilterChain(options: {
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  camera: T.PerspectiveCamera;
  /**
   * Hide the grid, the gizmo, the outlines and the bone handles, and put them
   * back.
   *
   * The outline prepass paints the whole scene with one normal material, which
   * would happily draw normals for a `GridHelper` and then outline it. The
   * viewport owns the list of what is furniture and what is the asset, so it
   * hands the chain a way to ask rather than the chain guessing at names.
   */
  hideFurniture: () => () => void;
}): FilterChain {
  const { renderer, scene, camera, hideFurniture } = options;
  const size: Size = { width: 1, height: 1, ratio: 1 };
  let source = new T.Vector2(1, 1);
  let block = 1;

  const composer = new EffectComposer(renderer, buffer(1, 1));
  const renderPass = new RenderPass(scene, camera);
  const outputPass = new OutputPass();
  const outlinePass = new ShaderPass(OUTLINE_SHADER);
  const quantizePass = new ShaderPass(QUANTIZE_SHADER);
  const screenPass = new ShaderPass(SCREEN_SHADER);
  outlinePass.enabled = false;
  quantizePass.enabled = false;
  composer.addPass(renderPass);
  composer.addPass(outputPass);
  composer.addPass(outlinePass);
  composer.addPass(quantizePass);
  composer.addPass(screenPass);

  // Normals in the colour attachment, depth in a texture beside it: one extra
  // draw of the model, and only while Outline is on.
  const depth = new T.DepthTexture(1, 1);
  depth.format = T.DepthFormat;
  depth.type = T.UnsignedIntType;
  const normals = new T.WebGLRenderTarget(1, 1, {
    minFilter: T.NearestFilter,
    magFilter: T.NearestFilter,
    depthTexture: depth,
  });
  const normalMaterial = new T.MeshNormalMaterial();
  outlinePass.uniforms.tNormal.value = normals.texture;
  outlinePass.uniforms.tDepth.value = depth;

  const ink = new T.Color();
  let wanted: Filters | null = null;

  function resize(filters: Filters): void {
    const out = new T.Vector2(
      Math.max(1, Math.round(size.width * size.ratio)),
      Math.max(1, Math.round(size.height * size.ratio)),
    );
    const pixelate = filters.on && filters.pixelate.on;
    if (!pixelate) {
      source = out.clone();
      block = 1;
    } else if (filters.pixelate.snap) {
      // A whole number of device pixels per block, and enough blocks to cover
      // the canvas — so the shader's integer division never reaches past the
      // last column.
      block = Math.max(1, Math.round(filters.pixelate.size * size.ratio));
      source = new T.Vector2(
        Math.max(1, Math.ceil(out.x / block)),
        Math.max(1, Math.ceil(out.y / block)),
      );
    } else {
      // Best fit instead: blocks average the asked-for size in CSS pixels, and
      // the aspect ratio of the buffer stays closest to the camera's.
      source = new T.Vector2(
        Math.max(1, Math.round(size.width / filters.pixelate.size)),
        Math.max(1, Math.round(size.height / filters.pixelate.size)),
      );
      block = out.x / source.x;
    }
    composer.setSize(source.x, source.y);
    if (normals.width !== source.x || normals.height !== source.y)
      normals.setSize(source.x, source.y);
    const screen = screenPass.uniforms;
    screen.uResolution.value.copy(out);
    screen.uSource.value.copy(source);
    screen.uBlock.value = block;
    outlinePass.uniforms.uResolution.value.copy(source);
    quantizePass.uniforms.uResolution.value.copy(source);
  }

  function apply(filters: Filters): void {
    wanted = filters;
    resize(filters);
    const on = filters.on;

    outlinePass.enabled = on && filters.outline.on;
    if (outlinePass.enabled) {
      const uniforms = outlinePass.uniforms;
      uniforms.uThickness.value = filters.outline.thickness;
      uniforms.uThreshold.value = filters.outline.threshold;
      uniforms.uMix.value = filters.outline.mix;
      ink.set(filters.outline.color);
      uniforms.uColor.value.copy(ink);
    }

    const posterize = on && filters.posterize.on;
    const dither = on && filters.dither.on;
    quantizePass.enabled = posterize || dither;
    if (quantizePass.enabled) {
      const uniforms = quantizePass.uniforms;
      uniforms.uLevels.value = filters.posterize.levels;
      // With Posterize off the quantiser is the dither's own, so the dither's
      // mix is what says how far the image moves.
      uniforms.uMix.value = posterize ? filters.posterize.mix : filters.dither.mix;
      uniforms.uDither.value = dither ? 1 : 0;
      uniforms.uMatrix.value = filters.dither.matrix;
      uniforms.uDitherMix.value = filters.dither.mix;
    }

    const screen = screenPass.uniforms;
    const pixelate = on && filters.pixelate.on;
    screen.uSnap.value = pixelate && filters.pixelate.snap ? 1 : 0;
    screen.uCrisp.value = pixelate ? filters.pixelate.mix : 1;
    screen.uSharpen.value = on && filters.sharpen.on ? filters.sharpen.mix : 0;
    screen.uScan.value =
      on && filters.scanlines.on
        ? filters.scanlines.mix * filters.scanlines.darkness
        : 0;
    screen.uScanSpacing.value = Math.max(1, filters.scanlines.spacing * size.ratio);
    screen.uVignette.value = on && filters.vignette.on ? filters.vignette.mix : 0;
    screen.uVignetteSoft.value = filters.vignette.softness;
  }

  /**
   * Draw the asset's normals and depth into their own target.
   *
   * The background goes away so empty sky reads as "infinitely far", which is
   * what turns the model's silhouette into an edge; shadow maps go away too,
   * because none of this pass can see a shadow and rendering them twice a
   * frame is the sort of cost that only shows up on someone else's laptop.
   */
  function drawNormals(): void {
    const restore = hideFurniture();
    const background = scene.background;
    const shadows = renderer.shadowMap.enabled;
    scene.background = null;
    scene.overrideMaterial = normalMaterial;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(normals);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.shadowMap.enabled = shadows;
    scene.overrideMaterial = null;
    scene.background = background;
    restore();
  }

  return {
    render() {
      if (outlinePass.enabled) {
        drawNormals();
        outlinePass.uniforms.uNear.value = camera.near;
        outlinePass.uniforms.uFar.value = camera.far;
      }
      composer.render();
    },
    setSize(width, height, ratio) {
      size.width = Math.max(1, width);
      size.height = Math.max(1, height);
      size.ratio = ratio > 0 ? ratio : 1;
      if (wanted) apply(wanted);
    },
    apply,
    dispose() {
      composer.dispose();
      outlinePass.dispose();
      quantizePass.dispose();
      screenPass.dispose();
      outputPass.dispose();
      renderPass.dispose();
      normals.dispose();
      depth.dispose();
      normalMaterial.dispose();
    },
  };
}
