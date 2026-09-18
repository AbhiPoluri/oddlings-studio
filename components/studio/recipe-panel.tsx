'use client';
/**
 * Property fields for a generator recipe.
 *
 * `SpecEditor` edits authored specs and nothing else, which is right — but the
 * blueprint generators still produce recipes, and a document with no editor is
 * a dead end. This is the recipe half, split the same way the spec half is: the
 * shape of the thing in Properties, the identity of it under Asset.
 */
import { Shuffle } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type { Recipe } from '@/lib/asset-recipe';
import { useStudio } from './store';
import { useDocument } from './use-document';

const CHARACTER = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
  '#b3c4de',
  '#d7ddd0',
];
const WORLD = ['#596c50', '#626c53', '#50675c', '#8d8172', '#68798b', '#867887'];

function Range({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="parameter">
      <div>
        <span>{label}</span>
        <output>{step < 1 ? value.toFixed(2) : value}</output>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        onValueCommitted={onCommit}
      />
    </div>
  );
}

export function RecipePanel({ section }: { section: 'shape' | 'asset' }) {
  const { state } = useStudio();
  const { editRecipe } = useDocument();
  const recipe = state.doc.recipe;

  /** A drag writes live; the release, or a blur, records the undo step. */
  const change = (patch: Partial<Recipe>, record = true) =>
    editRecipe({ ...recipe, ...patch }, record);

  const range = (
    key: keyof Recipe,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <Range
      key={key}
      label={label}
      min={min}
      max={max}
      step={step}
      value={recipe[key] as number}
      onChange={(value) => change({ [key]: value }, false)}
      onCommit={() => change({}, true)}
    />
  );

  if (section === 'asset')
    return (
      <>
        <div className="property-section identity">
          <label htmlFor="recipe-name">Asset name</label>
          <input
            id="recipe-name"
            value={recipe.name}
            maxLength={60}
            onChange={(event) => change({ name: event.target.value }, false)}
            onBlur={() => change({}, true)}
          />
          <label htmlFor="recipe-seed">Seed</label>
          <div className="seed-row">
            <input
              id="recipe-seed"
              type="number"
              min={0}
              max={2147483647}
              value={recipe.seed}
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 2147483647)
                  change({ seed: n }, false);
              }}
              onBlur={() => change({}, true)}
            />
            <button
              aria-label="New seed"
              title="New seed"
              onClick={() =>
                change({
                  seed: crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647,
                })
              }
            >
              <Shuffle size={13} />
            </button>
          </div>
        </div>
        <div className="property-section">
          <h3>Palette</h3>
          <div className="swatches">
            {(recipe.kind === 'creature' || recipe.kind === 'person'
              ? CHARACTER
              : WORLD
            ).map((color) => (
              <button
                key={color}
                style={{ background: color }}
                className={recipe.color === color ? 'chosen' : ''}
                aria-label={`Use ${color}`}
                aria-pressed={recipe.color === color}
                onClick={() => change({ color })}
              />
            ))}
            <label title="Custom colour">
              <input
                type="color"
                aria-label="Custom colour"
                value={recipe.color}
                onChange={(event) => change({ color: event.target.value }, false)}
                onBlur={() => change({}, true)}
              />
              <span>+</span>
            </label>
          </div>
          <span className="hex-value">{recipe.color.toUpperCase()}</span>
        </div>
        <div className="property-section">
          <h3>Scale</h3>
          {range('scale', 'Metres per unit', 0.1, 5, 0.1)}
        </div>
      </>
    );

  return (
    <>
      <div className="property-section">
        <h3>{recipe.kind === 'environment' ? 'The clearing' : 'Form'}</h3>
        {recipe.kind === 'environment' ? (
          <>
            {range('trees', 'Trees', 0, 24)}
            {range('huts', 'Huts', 0, 5)}
            {range('rocks', 'Rocks', 0, 40)}
            {range('plants', 'Mushrooms', 0, 100)}
            <label className="toggle">
              <span>Pond</span>
              <Switch
                checked={recipe.pond}
                onCheckedChange={(pond) => change({ pond })}
                aria-label="Pond"
              />
            </label>
          </>
        ) : (
          <>
            {range('width', 'Width', 0.6, 1.5, 0.01)}
            {range('height', 'Height', 0.65, 1.5, 0.01)}
            {range('roughness', 'Irregularity', 0, 0.3, 0.01)}
            {range('ears', 'Spread', 0, 1.8, 0.05)}
            {recipe.kind === 'creature' && range('eyes', 'Eyes', 1, 5)}
            {range('horns', 'Primary details', 0, 8)}
            {recipe.kind !== 'person' && range('teeth', 'Small details', 0, 10)}
          </>
        )}
      </div>
      {(recipe.kind === 'creature' || recipe.kind === 'person') && (
        <div className="property-section">
          <h3>Rig</h3>
          <label className="toggle">
            <span>Body rig</span>
            <Switch
              checked={recipe.rigged}
              onCheckedChange={(rigged) => change({ rigged })}
              aria-label="Body rig"
            />
          </label>
          {recipe.rigged && (
            <>
              <p className="help">14 joints · automatic skin weights</p>
              {range('hipHeight', 'Hip height', 0.35, 0.85, 0.01)}
              {range('headPivot', 'Head pivot', 0.7, 1.65, 0.01)}
              {range('shoulderWidth', 'Shoulder width', 0.2, 0.55, 0.01)}
            </>
          )}
        </div>
      )}
    </>
  );
}
