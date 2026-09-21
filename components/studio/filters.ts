/**
 * The viewport's post-processing stack, as plain data.
 *
 * Deliberately React-free and three-free, for the same reason `reducer.ts` is:
 * what a preset means, what a slider is allowed to hold and how many filters
 * are on are rules, and rules that can only be checked by dragging a slider in
 * a browser are rules nobody checks. `components/viewport-filters.ts` turns
 * this into passes; `filters-panel.tsx` turns it into controls; neither owns it.
 *
 * The stack replaces the old "Pixel preview" toggle, which rendered the whole
 * viewport at 0.45× and let the browser upscale it — a look that changed with
 * the panel width and with `devicePixelRatio`, because it was a resolution
 * rather than a filter.
 */

/** Bayer matrix edge length. Bigger is smoother and more obviously patterned. */
export type DitherMatrix = 2 | 4 | 8;

/** The filters, in the fixed order they are applied. */
export const FILTER_KINDS = [
  'outline',
  'pixelate',
  'posterize',
  'dither',
  'scanlines',
  'sharpen',
  'vignette',
] as const;

export type FilterKind = (typeof FILTER_KINDS)[number];

export type Filters = {
  /**
   * The master switch, which `P` flips.
   *
   * Separate from the per-filter toggles so turning the stack off and on again
   * gets you back what you had set up, rather than a stack you have to rebuild.
   */
  on: boolean;
  /** Screen-space edge lines from depth and normal discontinuities. */
  outline: {
    on: boolean;
    mix: number;
    /** Line width, in pixels of the buffer the scene is rendered at. */
    thickness: number;
    /** How big a discontinuity counts as an edge. Lower draws more lines. */
    threshold: number;
    /** The ink, as `#rrggbb`. */
    color: string;
  };
  /** Render the scene into a small buffer and magnify it with nearest taps. */
  pixelate: {
    on: boolean;
    /** 1 is hard blocks; below that the block is mixed with a smooth upscale. */
    mix: number;
    /** Block size in CSS pixels. */
    size: number;
    /** Lock blocks to whole device pixels, so none of them is a pixel wider. */
    snap: boolean;
  };
  /** Colour quantisation: the retro palette. */
  posterize: { on: boolean; mix: number; levels: number };
  /**
   * Ordered dithering, applied as an offset before the quantiser.
   *
   * It has no meaning on its own — dithering *is* a way of quantising — so with
   * Posterize off this one quantises to the same `levels` and blends by its own
   * mix, which is the classic pixel-art result rather than a no-op.
   */
  dither: { on: boolean; mix: number; matrix: DitherMatrix };
  /** Horizontal CRT lines, measured in CSS pixels of the final image. */
  scanlines: { on: boolean; mix: number; spacing: number; darkness: number };
  /** Unsharp mask, applied after the upscale. */
  sharpen: { on: boolean; mix: number };
  /** Corner darkening. `softness` is where the falloff starts. */
  vignette: { on: boolean; mix: number; softness: number };
};

/** Every numeric parameter's bounds, shared by the panel and by `clamped`. */
export const FILTER_RANGE = {
  mix: { min: 0, max: 1, step: 0.05 },
  'outline.thickness': { min: 1, max: 3, step: 1 },
  'outline.threshold': { min: 0.05, max: 1, step: 0.05 },
  'pixelate.size': { min: 1, max: 16, step: 1 },
  'posterize.levels': { min: 2, max: 32, step: 1 },
  'scanlines.spacing': { min: 2, max: 12, step: 1 },
  'scanlines.darkness': { min: 0, max: 1, step: 0.05 },
  'vignette.softness': { min: 0.1, max: 1, step: 0.05 },
} as const;

export const FILTER_LABEL: Record<FilterKind, string> = {
  outline: 'Outline',
  pixelate: 'Pixelate',
  posterize: 'Posterize',
  dither: 'Dither',
  scanlines: 'Scanlines',
  sharpen: 'Sharpen',
  vignette: 'Vignette',
};

export const DITHER_MATRICES: DitherMatrix[] = [2, 4, 8];

export const DEFAULT_FILTERS: Filters = {
  on: false,
  outline: {
    on: false,
    mix: 1,
    thickness: 1,
    threshold: 0.35,
    color: '#0b0f10',
  },
  pixelate: { on: false, mix: 1, size: 4, snap: true },
  posterize: { on: false, mix: 1, levels: 8 },
  dither: { on: false, mix: 0.7, matrix: 4 },
  scanlines: { on: false, mix: 0.45, spacing: 3, darkness: 0.5 },
  sharpen: { on: false, mix: 0.4 },
  vignette: { on: false, mix: 0.35, softness: 0.55 },
};

/** A patch names only what changed; everything else keeps its value. */
export type FiltersPatch = { on?: boolean } & {
  [K in FilterKind]?: Partial<Filters[K]>;
};

export type PresetId = 'off' | 'pixel-art' | 'retro-crt' | 'ink-outline';

function clamp(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const snapped = Math.round(value / step) * step;
  // Two decimals is enough for a 0.05 step and keeps 0.30000000000000004 out
  // of both the panel's readout and `localStorage`.
  return Math.min(max, Math.max(min, Math.round(snapped * 100) / 100));
}

function clampBy(key: keyof typeof FILTER_RANGE, value: number): number {
  const range = FILTER_RANGE[key];
  return clamp(value, range.min, range.max, range.step);
}

/**
 * Put one set of filters inside its bounds.
 *
 * Every door into the state goes through this: the reducer's patch, the preset
 * table and the restore from `localStorage` — which is the one that matters,
 * because a stored blob is whatever an older build of the studio wrote, or
 * whatever someone typed into the console.
 */
export function clamped(filters: Filters): Filters {
  const color = /^#[0-9a-fA-F]{6}$/.test(filters.outline.color)
    ? filters.outline.color.toLowerCase()
    : DEFAULT_FILTERS.outline.color;
  return {
    on: filters.on,
    outline: {
      on: filters.outline.on,
      mix: clampBy('mix', filters.outline.mix),
      thickness: clampBy('outline.thickness', filters.outline.thickness),
      threshold: clampBy('outline.threshold', filters.outline.threshold),
      color,
    },
    pixelate: {
      on: filters.pixelate.on,
      mix: clampBy('mix', filters.pixelate.mix),
      size: clampBy('pixelate.size', filters.pixelate.size),
      snap: filters.pixelate.snap,
    },
    posterize: {
      on: filters.posterize.on,
      mix: clampBy('mix', filters.posterize.mix),
      levels: clampBy('posterize.levels', filters.posterize.levels),
    },
    dither: {
      on: filters.dither.on,
      mix: clampBy('mix', filters.dither.mix),
      matrix: DITHER_MATRICES.includes(filters.dither.matrix)
        ? filters.dither.matrix
        : DEFAULT_FILTERS.dither.matrix,
    },
    scanlines: {
      on: filters.scanlines.on,
      mix: clampBy('mix', filters.scanlines.mix),
      spacing: clampBy('scanlines.spacing', filters.scanlines.spacing),
      darkness: clampBy('scanlines.darkness', filters.scanlines.darkness),
    },
    sharpen: { on: filters.sharpen.on, mix: clampBy('mix', filters.sharpen.mix) },
    vignette: {
      on: filters.vignette.on,
      mix: clampBy('mix', filters.vignette.mix),
      softness: clampBy('vignette.softness', filters.vignette.softness),
    },
  };
}

/** Apply a patch, clamped. Returns the same object when nothing moved. */
export function patchFilters(filters: Filters, patch: FiltersPatch): Filters {
  const next: Filters = clamped({
    ...filters,
    ...(patch.on === undefined ? null : { on: patch.on }),
    outline: { ...filters.outline, ...patch.outline },
    pixelate: { ...filters.pixelate, ...patch.pixelate },
    posterize: { ...filters.posterize, ...patch.posterize },
    dither: { ...filters.dither, ...patch.dither },
    scanlines: { ...filters.scanlines, ...patch.scanlines },
    sharpen: { ...filters.sharpen, ...patch.sharpen },
    vignette: { ...filters.vignette, ...patch.vignette },
  });
  // Identity matters downstream: the store persists on every new object, and
  // the viewport pushes uniforms on every new object. A slider dragged back to
  // where it started should cost neither.
  return sameFilters(filters, next) ? filters : next;
}

/**
 * A patch that names one filter, typed.
 *
 * `{ [kind]: value }` with a `kind` the compiler only knows is *some* filter
 * widens to an index signature, and TypeScript will not write a generic key
 * into a mapped type — so the assertion lives here, once, next to the type it
 * is about, rather than at each of the dozen call sites in the panel.
 */
export function filterPatch<K extends FilterKind>(
  kind: K,
  value: Partial<Filters[K]>,
): FiltersPatch {
  return { [kind]: value } as FiltersPatch;
}

export function sameFilters(a: Filters, b: Filters): boolean {
  if (a === b) return true;
  if (a.on !== b.on) return false;
  return FILTER_KINDS.every((kind) => {
    const left: Record<string, unknown> = a[kind];
    const right: Record<string, unknown> = b[kind];
    const keys = Object.keys(left);
    return keys.every((key) => left[key] === right[key]);
  });
}

/** The filters actually doing something, in the order they are applied. */
export function activeFilters(filters: Filters): FilterKind[] {
  if (!filters.on) return [];
  return FILTER_KINDS.filter((kind) => filters[kind].on);
}

export function filterCount(filters: Filters): number {
  return activeFilters(filters).length;
}

/**
 * Whether anything at all has to be drawn differently.
 *
 * The viewport reads this to choose between the plain `renderer.render` it has
 * always done and the composer — so an untouched studio never allocates a
 * render target, and the default path is the one it was before this existed.
 */
export function filtersActive(filters: Filters): boolean {
  return filterCount(filters) > 0;
}

function preset(id: PresetId, label: string, patch: FiltersPatch): {
  id: PresetId;
  label: string;
  filters: Filters;
} {
  // Built from the defaults rather than from whatever is on screen: a preset
  // that inherited half of the last one would not be a preset.
  return { id, label, filters: patchFilters(DEFAULT_FILTERS, patch) };
}

export const PRESETS = [
  preset('off', 'Off', { on: false }),
  preset('pixel-art', 'Pixel art', {
    on: true,
    pixelate: { on: true, size: 4 },
    posterize: { on: true, levels: 8 },
    dither: { on: true, matrix: 4, mix: 0.7 },
  }),
  preset('retro-crt', 'Retro CRT', {
    on: true,
    pixelate: { on: true, size: 3 },
    posterize: { on: true, levels: 16, mix: 0.8 },
    scanlines: { on: true, mix: 0.5, spacing: 3, darkness: 0.55 },
    vignette: { on: true, mix: 0.4 },
  }),
  preset('ink-outline', 'Ink outline', {
    on: true,
    outline: { on: true, mix: 1, thickness: 2, threshold: 0.3 },
    posterize: { on: true, levels: 6 },
    sharpen: { on: true, mix: 0.35 },
  }),
] as const;

export function applyPreset(id: PresetId): Filters {
  return PRESETS.find((entry) => entry.id === id)?.filters ?? DEFAULT_FILTERS;
}

/**
 * Which preset the current settings are, if any.
 *
 * Used only to light a button up. Nothing depends on the answer, so "none of
 * them" after one slider move is the right answer rather than a near miss.
 */
export function matchingPreset(filters: Filters): PresetId | null {
  return PRESETS.find((entry) => sameFilters(entry.filters, filters))?.id ?? null;
}

/** Parse whatever the last session left, keeping only what still type-checks. */
export function readFilters(raw: string | null): Filters | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // An array passes `typeof === 'object'` and would come back out as the
  // untouched defaults, which reads as "there were settings" to the caller.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const stored = parsed as Record<string, unknown>;
  const patch: FiltersPatch = {};
  if (typeof stored.on === 'boolean') patch.on = stored.on;
  for (const kind of FILTER_KINDS) {
    const group = stored[kind];
    if (!group || typeof group !== 'object') continue;
    const fields = group as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(DEFAULT_FILTERS[kind])) {
      const found = fields[key];
      if (typeof found === typeof value) kept[key] = found;
    }
    // Written through the patch path so the ranges are enforced on the way in
    // rather than trusted; the cast is the one place a stored blob becomes a
    // value, and `clamped` is the thing that makes it safe.
    if (Object.keys(kept).length)
      Object.assign(patch, { [kind]: kept as Partial<Filters[typeof kind]> });
  }
  // Nothing usable in it is not a stored stack. Saying so — rather than
  // handing back the untouched defaults — is what lets the caller tell "the
  // last session chose the defaults" from "there was no last session", the
  // same distinction `storedLayout` draws in `store.tsx`.
  return Object.keys(patch).length ? patchFilters(DEFAULT_FILTERS, patch) : null;
}
