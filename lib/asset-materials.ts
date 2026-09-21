import * as T from 'three';

/**
 * The material library: named presets, and the tuple every part resolves to.
 *
 * `material` used to be four numbers an author had to know — roughness,
 * metalness, emissive, emissiveStrength. Those four are what a renderer wants
 * and not what anyone thinks in: "rust" is a roughness, a metalness that drops
 * where the oxide is, an orange crust that follows a noise field, and a
 * millimetre of relief. So a preset is all of that at once — the tuple, the
 * glTF extensions the look needs (transmission for glass, clearcoat for
 * obsidian, sheen for cloth), and a default `paint` expression that draws the
 * pattern. A part with its own `paint` keeps it; the preset only supplies one
 * where the author wrote none.
 *
 * The four-field block still parses and still means exactly what it meant, and
 * `{ "preset": "rust", "roughness": 0.9 }` is the preset with one field moved.
 *
 * This file is the bottom of the material stack: it imports nothing from
 * `asset-uv`, which re-exports the type and the resolver from here so that
 * every existing import path keeps working.
 */

/**
 * The parts of a look that live in a glTF extension rather than in core
 * pbrMetallicRoughness.
 *
 * Three's `MeshPhysicalMaterial` is the only material that carries these, and
 * `GLTFExporter` turns each of them into its KHR extension on the way out:
 * transmission and thickness into KHR_materials_transmission and
 * KHR_materials_volume, a non-default `ior` into KHR_materials_ior, clearcoat
 * and sheen into theirs. Nothing here is written unless a preset asks for it,
 * so an asset that authors plain roughness still exports a plain material.
 */
export type Physical = {
  transmission?: number;
  /** Index of refraction. 1.5 is three's default and is never written out. */
  ior?: number;
  /** Metres of glass the light travels through, for KHR_materials_volume. */
  thickness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenColor?: string;
  sheenRoughness?: number;
  /** Below 1 it dulls the specular highlight of a dielectric. */
  specularIntensity?: number;
};

/**
 * A part's authored surface response, reduced to the tuple that decides which
 * material it can share with another part.
 *
 * `preset` rides along because two presets can agree on all four numbers and
 * still be different materials — iron and steel differ in the pattern they
 * paint, glass and water in the extensions they carry — so the name is part of
 * the identity, not a label on it.
 *
 * `emissiveStrength` is deliberately absent from the key when there is no
 * emissive colour. Zod fills it in at 1 whether or not the author wrote it, so
 * keying on it would split one visible material into two groups over a number
 * that multiplies black.
 */
export type SurfaceMaterial = {
  roughness: number;
  metalness: number;
  emissive?: string;
  emissiveStrength: number;
  /** The preset this was resolved from, when it came from one. */
  preset?: string;
  /** Extension-borne fields, when the preset uses any. */
  physical?: Physical;
};

/** What every part had before `material` existed, and still has without it. */
export const DEFAULT_MATERIAL: SurfaceMaterial = {
  roughness: 1,
  metalness: 0,
  emissiveStrength: 1,
};

/** The shape `material` may take in a spec: a preset name, or a block. */
export type MaterialSpec =
  | string
  | {
      preset?: string;
      roughness?: number;
      metalness?: number;
      emissive?: string;
      emissiveStrength?: number;
    };

type Preset = {
  roughness: number;
  metalness: number;
  emissive?: string;
  emissiveStrength?: number;
  physical?: Physical;
  /** The pattern the preset draws when the part has no `paint` of its own. */
  paint?: string;
  /** One line for the guide and for whoever reads this table next. */
  note: string;
};

/**
 * Every preset paint runs in the part's unit box with `size` — the part's
 * metres — in hand, so a pattern is authored in world units and comes out the
 * same size on a 0.4 m crate and a 12 m wall. They shade `base`, the part's own
 * colour, rather than replacing it: a preset decides how a surface responds to
 * light and what relief it has, and the author still decides what colour it is.
 * The exceptions are the places where the material *is* a colour — rust's
 * oxide, lava's crust and glow — which would be a lie in any other hue.
 */
export const PRESETS: Record<string, Preset> = {
  stone: {
    roughness: 0.95,
    metalness: 0,
    paint:
      "const n = s.fbm(x * size[0] * 6, y * size[1] * 6, z * size[2] * 6, 4); const g = s.fbm(x * size[0] * 40, y * size[1] * 40, z * size[2] * 40, 2); return { color: s.shade(base, 0.82 + n * 0.34 + g * 0.06), bump: n * 0.004 + g * 0.0008 }",
    note: 'matte rock, mottled, 4 mm of relief',
  },
  sandstone: {
    roughness: 0.96,
    metalness: 0,
    paint:
      "const b = s.fbm(x * size[0] * 2, y * size[1] * 22, z * size[2] * 2, 3); const g = s.speckle(x * size[0], y * size[1], z * size[2], 120, 0.5); return { color: s.shade(base, 0.86 + b * 0.26 + g * 0.05), bump: b * 0.002 }",
    note: 'bedded sand, fine horizontal banding',
  },
  marble: {
    roughness: 0.22,
    metalness: 0,
    physical: { clearcoat: 0.35, clearcoatRoughness: 0.2 },
    paint:
      "const v = M.abs(s.fbm(x * size[0] * 3 + s.fbm(x * size[0] * 8, y * size[1] * 8, z * size[2] * 8, 2) * 1.5, y * size[1] * 3, z * size[2] * 3, 4)); const k = 1 - s.step(0, 0.07, v); return { color: s.blend(base, s.shade(base, 0.45), k * 0.8), roughness: 0.22 - k * 0.06 }",
    note: 'polished, dark veining, a light lacquer',
  },
  wood: {
    roughness: 0.72,
    metalness: 0,
    paint:
      "const w = s.fbm(x * size[0] * 3, y * size[1] * 24, z * size[2] * 3, 3); const ring = M.abs(M.sin(y * size[1] * 26 + w * 4)); return { color: s.shade(base, 0.78 + ring * 0.32), bump: (1 - ring) * 0.0014 }",
    note: 'grain rings up the part, 1.4 mm of relief',
  },
  planks: {
    roughness: 0.78,
    metalness: 0,
    paint:
      "const p = s.planks(x * size[0], z * size[2], 0.22, 0.012); const g = s.fbm(x * size[0] * 30, z * size[2] * 6 + p.r * 30, 0, 3); return { color: s.shade(base, (0.78 + p.r * 0.22 + g * 0.16) * (0.35 + p.m * 0.65)), bump: p.m * 0.004 + g * 0.0008 - 0.004 }",
    note: 'boards with gaps, each board its own tone',
  },
  bricks: {
    roughness: 0.92,
    metalness: 0,
    paint:
      "const b = s.bricks(x * size[0], y * size[1], 0.24, 0.022); const g = s.fbm(x * size[0] * 40, y * size[1] * 40, z * size[2] * 40, 2); return { color: b.m > 0.5 ? s.shade(base, 0.82 + b.r * 0.36 + g * 0.08) : s.blend(s.rgb('#b9b3a6'), s.shade(base, 0.6), 0.25), bump: b.m * 0.008 + g * 0.0006, roughness: b.m > 0.5 ? 0.9 : 0.99 }",
    note: 'running-bond courses, mortar 8 mm proud of nothing',
  },
  tiles: {
    roughness: 0.3,
    metalness: 0,
    physical: { clearcoat: 0.5, clearcoatRoughness: 0.12 },
    paint:
      "const t = s.tiles(x * size[0], z * size[2], 0.18, 0.012); return { color: t.m > 0.5 ? s.shade(base, 0.86 + t.r * 0.28) : s.rgb('#cfc9bd'), bump: t.m * 0.005, roughness: t.m > 0.5 ? 0.25 : 0.85 }",
    note: 'glazed squares, matte grout',
  },
  iron: {
    roughness: 0.52,
    metalness: 1,
    paint:
      "const n = s.fbm(x * size[0] * 12, y * size[1] * 12, z * size[2] * 12, 3); return { color: s.shade(base, 0.82 + n * 0.3), roughness: 0.46 + M.abs(n) * 0.3, bump: n * 0.0009 }",
    note: 'cast and hammered, uneven sheen',
  },
  steel: {
    roughness: 0.24,
    metalness: 1,
    paint:
      "const n = s.fbm(x * size[0] * 60, y * size[1] * 4, z * size[2] * 60, 2); return { color: s.shade(base, 0.92 + n * 0.14), roughness: 0.2 + M.abs(n) * 0.14 }",
    note: 'milled and near-mirror, faint brushing',
  },
  rust: {
    roughness: 0.95,
    metalness: 0.9,
    paint:
      "const p = s.step(0.02, 0.4, s.fbm(x * size[0] * 5, y * size[1] * 5, z * size[2] * 5, 4) + 0.12); const f = s.speckle(x * size[0], y * size[1], z * size[2], 90, 0.35); return { color: s.blend(s.shade(base, 0.9), s.rgb('#8c3d18'), M.min(1, p + f * 0.3)), roughness: 0.5 + p * 0.48, metalness: 1 - p * 0.9, bump: p * 0.0016 + f * 0.0006 }",
    note: 'oxide creeping over metal; the crust is not metal any more',
  },
  bronze: {
    roughness: 0.34,
    metalness: 1,
    paint:
      "const p = s.step(0.1, 0.45, s.fbm(x * size[0] * 7, y * size[1] * 7, z * size[2] * 7, 3)); return { color: s.blend(base, s.rgb('#3f7f6a'), p * 0.35), roughness: 0.3 + p * 0.45, metalness: 1 - p * 0.5 }",
    note: 'cast bronze going green in the hollows',
  },
  gold: {
    roughness: 0.18,
    metalness: 1,
    paint:
      "const n = s.fbm(x * size[0] * 20, y * size[1] * 20, z * size[2] * 20, 3); return { color: s.shade(base, 0.9 + n * 0.2), roughness: 0.14 + M.abs(n) * 0.12 }",
    note: 'soft, bright, barely rough',
  },
  bone: {
    roughness: 0.62,
    metalness: 0,
    paint:
      "const g = s.fbm(x * size[0] * 4, y * size[1] * 30, z * size[2] * 4, 3); const p = s.speckle(x * size[0], y * size[1], z * size[2], 200, 0.25); return { color: s.shade(base, 0.88 + g * 0.2 - p * 0.25), bump: g * 0.0012 - p * 0.0008 }",
    note: 'dry, porous, grained along its length',
  },
  cloth: {
    roughness: 0.96,
    metalness: 0,
    physical: { sheen: 0.7, sheenColor: '#ffffff', sheenRoughness: 0.6, specularIntensity: 0.2 },
    paint:
      "const w = s.stripes(x * size[0], 0.006, 0.5) * 0.5 + s.stripes(y * size[1], 0.006, 0.5) * 0.5; const f = s.fbm(x * size[0] * 8, y * size[1] * 8, z * size[2] * 8, 2); return { color: s.shade(base, 0.9 + w * 0.14 + f * 0.08), bump: (w - 0.5) * 0.0008 }",
    note: 'woven, sheen at grazing angles',
  },
  leather: {
    roughness: 0.74,
    metalness: 0,
    paint:
      "const c = s.speckle(x * size[0], y * size[1], z * size[2], 160, 0.5); const w = s.worn(x * size[0], y * size[1], z * size[2], 9, 1); return { color: s.shade(base, 0.8 + c * 0.2 - w * 0.18), roughness: 0.66 + w * 0.3, bump: c * 0.0012 - w * 0.0008 }",
    note: 'pebbled hide, darker where it creases',
  },
  glass: {
    roughness: 0.04,
    metalness: 0,
    physical: { transmission: 1, ior: 1.5, thickness: 0.02 },
    note: 'clear and transmissive; give it a pale colour, not a dark one',
  },
  water: {
    roughness: 0.05,
    metalness: 0,
    physical: { transmission: 0.92, ior: 1.33, thickness: 0.2 },
    paint:
      "const r = s.fbm(x * size[0] * 5, z * size[2] * 5, y * size[1] * 5 + 0.5, 3); return { color: base, bump: r * 0.003, roughness: 0.04 + M.abs(r) * 0.05 }",
    note: 'ripples, refraction at 1.33',
  },
  lava: {
    roughness: 0.88,
    metalness: 0,
    emissive: '#ff5a1e',
    emissiveStrength: 3,
    paint:
      "const c = M.abs(s.fbm(x * size[0] * 2.5, y * size[1] * 2.5, z * size[2] * 2.5, 4)); const hot = 1 - s.step(0, 0.1, c); return { color: s.blend(s.rgb('#241009'), s.rgb('#ff7a24'), hot), emissive: hot * hot, bump: -hot * 0.004, roughness: 0.9 - hot * 0.3 }",
    note: 'black crust split by glowing cracks',
  },
  ember: {
    roughness: 0.85,
    metalness: 0,
    emissive: '#ff8a3c',
    emissiveStrength: 2,
    paint:
      "const n = s.fbm(x * size[0] * 14, y * size[1] * 14, z * size[2] * 14, 3); const hot = s.step(0.05, 0.3, n); return { color: s.blend(s.rgb('#2a1c17'), base, hot), emissive: hot * 0.8, bump: -n * 0.002 }",
    note: 'charcoal with heat still in it',
  },
  obsidian: {
    roughness: 0.12,
    metalness: 0,
    physical: { clearcoat: 1, clearcoatRoughness: 0.05, ior: 1.48 },
    paint:
      "const n = s.fbm(x * size[0] * 9, y * size[1] * 9, z * size[2] * 9, 3); const f = s.step(0.0, 0.25, M.abs(n)); return { color: s.shade(base, 0.45 + f * 0.5), roughness: 0.08 + f * 0.12, bump: n * 0.0015 }",
    note: 'volcanic glass, conchoidal facets under a hard lacquer',
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as [string, ...string[]];

export function isPreset(name: string): boolean {
  return Object.hasOwn(PRESETS, name);
}

/**
 * Resolve whatever `material` was authored into the tuple everything else
 * reads.
 *
 * Three shapes arrive here: nothing (the matte default), a preset name, and a
 * block — which may name a preset and override fields of it, or may be the
 * four plain numbers it always was. An unknown preset name resolves to the
 * default rather than throwing, because the schema is what refuses it and a
 * builder that throws here would take a whole model down over a typo the
 * parser already reported.
 */
export function materialOf(source?: MaterialSpec | null): SurfaceMaterial {
  if (!source) return { ...DEFAULT_MATERIAL };
  const name = typeof source === 'string' ? source : source.preset;
  const preset = name ? PRESETS[name] : undefined;
  const block = typeof source === 'string' ? {} : source;
  const emissive = block.emissive ?? preset?.emissive;
  return {
    roughness: block.roughness ?? preset?.roughness ?? DEFAULT_MATERIAL.roughness,
    metalness: block.metalness ?? preset?.metalness ?? DEFAULT_MATERIAL.metalness,
    ...(emissive ? { emissive } : {}),
    emissiveStrength:
      block.emissiveStrength ??
      preset?.emissiveStrength ??
      DEFAULT_MATERIAL.emissiveStrength,
    ...(preset && name ? { preset: name } : {}),
    ...(preset?.physical ? { physical: preset.physical } : {}),
  };
}

/**
 * The pattern a preset draws, for a part that wrote no `paint` of its own.
 *
 * Resolved where the primitive is built rather than where the spec is parsed,
 * so the spec an author reads back is the spec they wrote.
 */
export function presetPaint(source?: MaterialSpec | null): string | undefined {
  if (!source) return undefined;
  const name = typeof source === 'string' ? source : source.preset;
  return name ? PRESETS[name]?.paint : undefined;
}

/** Does this tuple need a `MeshPhysicalMaterial` to say what it means? */
export function needsPhysical(material: SurfaceMaterial): boolean {
  return Boolean(material.physical);
}

/**
 * Write the extension-borne fields onto a physical material.
 *
 * `ior` is set only when a preset asked for one: three's default is 1.5 and
 * the exporter writes KHR_materials_ior only for anything else, so setting it
 * to 1.5 explicitly would be a no-op that reads like a decision.
 */
export function applyPhysical(
  material: T.MeshPhysicalMaterial,
  physical: Physical,
) {
  // Transmission and transparency are different things, and only one of them
  // belongs here. Three routes anything with `transmission > 0` through its
  // transmissive pass whether or not the material is `transparent`, while
  // `transparent` is what `GLTFExporter` turns into `alphaMode: BLEND` — which
  // would tell every engine to sort and blend a pane of glass that the
  // transmission extension already describes properly.
  if (physical.transmission !== undefined)
    material.transmission = physical.transmission;
  if (physical.ior !== undefined) material.ior = physical.ior;
  if (physical.thickness !== undefined) material.thickness = physical.thickness;
  if (physical.clearcoat !== undefined) material.clearcoat = physical.clearcoat;
  if (physical.clearcoatRoughness !== undefined)
    material.clearcoatRoughness = physical.clearcoatRoughness;
  if (physical.sheen !== undefined) material.sheen = physical.sheen;
  if (physical.sheenColor !== undefined)
    material.sheenColor = new T.Color(physical.sheenColor);
  if (physical.sheenRoughness !== undefined)
    material.sheenRoughness = physical.sheenRoughness;
  if (physical.specularIntensity !== undefined)
    material.specularIntensity = physical.specularIntensity;
  return material;
}

/**
 * The standard-material fields a physical copy has to inherit.
 *
 * `MeshPhysicalMaterial.copy` reads clearcoat, sheen and iridescence off its
 * source, so copying from a plain `MeshStandardMaterial` writes `undefined`
 * into half of them. Naming the fields is duller and correct.
 */
function carryOver(
  from: T.MeshStandardMaterial,
  to: T.MeshPhysicalMaterial,
) {
  to.name = from.name;
  to.color.copy(from.color);
  to.roughness = from.roughness;
  to.metalness = from.metalness;
  to.emissive.copy(from.emissive);
  to.emissiveIntensity = from.emissiveIntensity;
  to.vertexColors = from.vertexColors;
  to.flatShading = from.flatShading;
  to.side = from.side;
  to.wireframe = from.wireframe;
  to.transparent = from.transparent;
  to.opacity = from.opacity;
  to.depthWrite = from.depthWrite;
  to.map = from.map;
  to.normalMap = from.normalMap;
  to.roughnessMap = from.roughnessMap;
  to.metalnessMap = from.metalnessMap;
  to.emissiveMap = from.emissiveMap;
  return to;
}

/**
 * The material a tuple wants, built from a standard one.
 *
 * Returns the same object for everything that fits in core glTF — so the
 * common path allocates nothing and an asset with no preset exports exactly
 * the material it always did — and a `MeshPhysicalMaterial` carrying the same
 * settings for the ones that do not. Callers assign the return value: a
 * standard material cannot grow a transmission field by being written to.
 */
export function materialFrom(
  base: T.MeshStandardMaterial,
  wanted: SurfaceMaterial,
): T.MeshStandardMaterial {
  const material = wanted.physical
    ? carryOver(base, new T.MeshPhysicalMaterial())
    : base;
  material.roughness = wanted.roughness;
  material.metalness = wanted.metalness;
  if (wanted.emissive) {
    material.emissive = new T.Color(wanted.emissive);
    material.emissiveIntensity = wanted.emissiveStrength;
  }
  if (wanted.physical)
    applyPhysical(material as T.MeshPhysicalMaterial, wanted.physical);
  if (material !== base) base.dispose();
  return material;
}
