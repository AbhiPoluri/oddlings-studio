'use client';
/**
 * The procedural generators, behind a dialog.
 *
 * They used to take a third of the page, which put a "Generate blueprint"
 * button between a reviewer and the thing they came to review. They are still
 * how a new asset starts, so they stay — as something you open, use and close.
 */
import { useState } from 'react';
import { Dices, GitBranch } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import type { Kind } from '@/lib/asset-recipe';
import {
  blueprints,
  defaultBlueprint,
  generateBlueprint,
  mutateRecipe,
  type Blueprint,
} from '@/lib/procedural-director';
import { useStudio } from './store';
import { useDocument } from './use-document';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'creature', label: 'Creature' },
  { value: 'person', label: 'Person' },
  { value: 'prop', label: 'Prop' },
  { value: 'environment', label: 'World' },
];

function freshSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
}

export function BlueprintDialog() {
  const { state, dispatch } = useStudio();
  const { editRecipe, status } = useDocument();
  const recipe = state.doc.recipe;
  const [kind, setKind] = useState<Kind>(recipe.kind);
  const [chosen, setChosen] = useState<Blueprint>(defaultBlueprint[recipe.kind]);
  const [strength, setStrength] = useState(0.45);

  // A blueprint from another kind cannot generate this kind, so the grid always
  // shows the kind's own set and the choice falls back to that kind's default.
  const options = (Object.keys(blueprints) as Blueprint[]).filter(
    (key) => blueprints[key].kind === kind,
  );
  const active = options.includes(chosen) ? chosen : defaultBlueprint[kind];

  function close() {
    dispatch({ type: 'modal', modal: null });
  }

  return (
    <Dialog
      open={state.modal === 'blueprint'}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent className="studio-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">Generate</DialogTitle>
        </DialogHeader>
        <div className="segmented" role="group" aria-label="Asset kind">
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={kind === option.value}
              onClick={() => {
                setKind(option.value);
                setChosen(defaultBlueprint[option.value]);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="blueprint-grid">
          {options.map((key) => (
            <button
              key={key}
              type="button"
              className="blueprint-card"
              aria-pressed={active === key}
              onClick={() => setChosen(key)}
            >
              <strong>{blueprints[key].label}</strong>
              <span>{blueprints[key].description}</span>
            </button>
          ))}
        </div>
        <label className="dialog-field">
          <span>Mutation strength</span>
          <Slider
            aria-label="Mutation strength"
            value={[strength]}
            min={0.1}
            max={1}
            step={0.05}
            onValueChange={(value) =>
              setStrength(Array.isArray(value) ? value[0] : value)
            }
          />
          <output>{Math.round(strength * 100)}%</output>
        </label>
        <div className="dialog-actions">
          <button
            className="bar-button primary"
            onClick={() => {
              editRecipe(generateBlueprint(active, freshSeed()));
              status(`${blueprints[active].label} generated. Every value is editable.`);
              close();
            }}
          >
            <Dices size={13} /> Generate
          </button>
          <button
            className="bar-button"
            disabled={Boolean(state.doc.spec)}
            title={
              state.doc.spec
                ? 'Mutation works on a generator recipe, not an authored spec.'
                : undefined
            }
            onClick={() => {
              editRecipe(mutateRecipe(recipe, freshSeed(), strength));
              status(
                `Mutation applied at ${Math.round(strength * 100)}% as one undo step.`,
              );
              close();
            }}
          >
            <GitBranch size={13} /> Mutate current
          </button>
          <button className="bar-button" onClick={close}>
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
