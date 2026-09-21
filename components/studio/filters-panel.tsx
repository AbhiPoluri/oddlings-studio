'use client';
/**
 * The Filters popover, hung off the viewport toolbar.
 *
 * A popover rather than a right-hand panel tab: every control in here changes
 * what the viewport looks like, so the viewport has to stay visible while they
 * are dragged — and a look is something you set up once and leave, not
 * something that deserves a permanent column.
 *
 * Nothing here decides anything. The rows are generated from `FILTER_KINDS`,
 * the bounds come from `FILTER_RANGE`, and the presets come from `PRESETS`, so
 * a filter gaining a parameter is a change to `filters.ts` and to the shader —
 * never to a list of controls that has to be kept in step with both.
 */
import type { ReactNode } from 'react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  DITHER_MATRICES,
  FILTER_KINDS,
  FILTER_LABEL,
  FILTER_RANGE,
  PRESETS,
  activeFilters,
  filterPatch,
  matchingPreset,
  type DitherMatrix,
  type FilterKind,
  type Filters,
  type FiltersPatch,
} from './filters';
import { useStudio } from './store';

/** What each row says under its name, so a switch is not a word on its own. */
const BLURB: Record<FilterKind, string> = {
  outline: 'Edge lines from depth and normals.',
  pixelate: 'Renders small, magnifies with hard edges.',
  posterize: 'Fewer levels per channel.',
  dither: 'Ordered pattern, quantised with Posterize.',
  scanlines: 'Horizontal CRT lines.',
  sharpen: 'Unsharp mask on the final image.',
  vignette: 'Darkened corners.',
};

function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="parameter">
      <div>
        <span>{label}</span>
        <output>{format ? format(value) : value}</output>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
    </div>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function FiltersPanel() {
  const { state, dispatch } = useStudio();
  const filters = state.filters;
  const active = activeFilters(filters);
  const preset = matchingPreset(filters);

  const patch = (next: FiltersPatch) => dispatch({ type: 'filters', patch: next });

  /**
   * A filter's own parameters.
   *
   * A switch statement rather than a table of descriptors: three of the seven
   * have a control that is not a slider, and a descriptor language rich enough
   * to express "a select of three matrix sizes" would be longer than this is.
   */
  const controls = (kind: FilterKind): ReactNode => {
    switch (kind) {
      case 'outline':
        return (
          <>
            <Range
              label="Thickness"
              value={filters.outline.thickness}
              {...FILTER_RANGE['outline.thickness']}
              format={(value) => `${value} px`}
              onChange={(thickness) => patch({ outline: { thickness } })}
            />
            <Range
              label="Threshold"
              value={filters.outline.threshold}
              {...FILTER_RANGE['outline.threshold']}
              format={percent}
              onChange={(threshold) => patch({ outline: { threshold } })}
            />
            <label className="filter-colour">
              <span>Ink</span>
              <input
                type="color"
                value={filters.outline.color}
                aria-label="Outline colour"
                onChange={(event) =>
                  patch({ outline: { color: event.target.value } })
                }
              />
            </label>
          </>
        );
      case 'pixelate':
        return (
          <>
            <Range
              label="Block"
              value={filters.pixelate.size}
              {...FILTER_RANGE['pixelate.size']}
              format={(value) => `${value} px`}
              onChange={(size) => patch({ pixelate: { size } })}
            />
            <label className="filter-check">
              <span>Snap to grid</span>
              <Switch
                size="sm"
                checked={filters.pixelate.snap}
                onCheckedChange={(snap) => patch({ pixelate: { snap } })}
              />
            </label>
          </>
        );
      case 'posterize':
        return (
          <Range
            label="Levels"
            value={filters.posterize.levels}
            {...FILTER_RANGE['posterize.levels']}
            onChange={(levels) => patch({ posterize: { levels } })}
          />
        );
      case 'dither':
        return (
          <div className="filter-choice" role="group" aria-label="Bayer matrix">
            <span>Matrix</span>
            <div className="segmented">
              {DITHER_MATRICES.map((matrix: DitherMatrix) => (
                <button
                  key={matrix}
                  type="button"
                  aria-pressed={filters.dither.matrix === matrix}
                  onClick={() => patch({ dither: { matrix } })}
                >
                  {matrix}×{matrix}
                </button>
              ))}
            </div>
          </div>
        );
      case 'scanlines':
        return (
          <>
            <Range
              label="Spacing"
              value={filters.scanlines.spacing}
              {...FILTER_RANGE['scanlines.spacing']}
              format={(value) => `${value} px`}
              onChange={(spacing) => patch({ scanlines: { spacing } })}
            />
            <Range
              label="Darkness"
              value={filters.scanlines.darkness}
              {...FILTER_RANGE['scanlines.darkness']}
              format={percent}
              onChange={(darkness) => patch({ scanlines: { darkness } })}
            />
          </>
        );
      case 'vignette':
        return (
          <Range
            label="Softness"
            value={filters.vignette.softness}
            {...FILTER_RANGE['vignette.softness']}
            format={percent}
            onChange={(softness) => patch({ vignette: { softness } })}
          />
        );
      case 'sharpen':
        return null;
    }
  };

  return (
    <div className="filters-panel">
      <div className="filters-head">
        <label className="filter-check">
          <Switch
            size="sm"
            checked={filters.on}
            aria-label="Filters"
            onCheckedChange={(on) => patch({ on })}
          />
          <span>
            Filters <kbd>P</kbd>
          </span>
        </label>
        <span className="filters-count">
          {active.length ? `${active.length} on` : 'none on'}
        </span>
      </div>
      <div className="filters-presets" role="group" aria-label="Filter presets">
        {PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="bar-button"
            aria-pressed={preset === entry.id}
            onClick={() => dispatch({ type: 'filterPreset', preset: entry.id })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {/* Dimmed rather than disabled while the stack is off: the controls stay
          usable, so you can set a look up and then switch it on to see it. */}
      <div className="filters-rows" data-off={filters.on ? undefined : ''}>
        {FILTER_KINDS.map((kind) => (
          <section
            key={kind}
            className="filter-row"
            data-on={filters[kind].on ? '' : undefined}
          >
            <label className="filter-check filter-title">
              <Switch
                size="sm"
                checked={filters[kind].on}
                aria-label={FILTER_LABEL[kind]}
                onCheckedChange={(on) =>
                  // Switching a filter on switches the stack on with it: a lit
                  // row over an unchanged viewport is a control that lies.
                  patch({ ...filterPatch(kind, { on }), on: on || filters.on })
                }
              />
              <span>
                {FILTER_LABEL[kind]}
                <em>{BLURB[kind]}</em>
              </span>
            </label>
            {filters[kind].on && (
              <div className="filter-body">
                <Range
                  label="Strength"
                  value={filters[kind].mix}
                  {...FILTER_RANGE.mix}
                  format={percent}
                  onChange={(mix) => patch(filterPatch(kind, { mix }))}
                />
                {controls(kind)}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
