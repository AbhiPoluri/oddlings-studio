'use client';
import { useEffect, useRef, useState } from 'react';
import { Copy, Trash2, Shuffle, Plus, RotateCcw } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { SHAPES, type AssetSpec, type Part } from '@/lib/asset-spec';
import type { Audit } from '@/lib/asset-audit';
import {
  flatten,
  partAt,
  updatePart,
  labelFor,
  addJoint,
  clipTable,
  jointErrorIndex,
  removeJoint,
  rigKindOf,
  selectedBone,
  selectedPath,
  setBoneOverride,
  setClipSeconds,
  setRigKind,
  setRigSettings,
  updateJoint,
  type PartPatch,
  type RememberedRig,
  type RigKind,
  type Selection,
  type Vec3,
} from '@/lib/spec-edit';
import { boneLayout } from '@/lib/asset-joints';
import { Outliner } from '@/components/outliner';


const SOLID_COLORS = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
  '#52684a',
  '#6d5f52',
  '#e8d18a',
  '#1d2321',
];

/** Shapes whose top-to-bottom ratio is meaningful. */
const TAPERED = new Set(['cylinder', 'cone', 'prism', 'limb']);

/**
 * A number you can type as well as drag.
 *
 * Deliberately not `type="number"`: a number input reports an empty string
 * while its text is mid-way to a number, so typing `-` or `0.` into a
 * controlled one throws the character away and the field fights back. The text
 * the user is typing is held as a draft and only parsed when they are done, so
 * nothing is committed — and no undo step is pushed — until blur or Enter.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  function send(raw: string) {
    setDraft(null);
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n)) return;
    const next = clamp(n);
    if (next !== value) onCommit(next);
  }
  function nudge(direction: number, big: boolean) {
    setDraft(null);
    // Rounded because 0.1 + 0.2 in a spec file is a tell that a machine wrote
    // it, and these steps are always a clean fraction.
    const next = clamp(
      Number((value + step * (big ? 10 : 1) * direction).toFixed(6)),
    );
    if (next !== value) onCommit(next);
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      spellCheck={false}
      className="typed-number"
      aria-label={label}
      value={draft ?? String(Number(value.toFixed(4)))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => send(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          send(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        }
      }}
    />
  );
}

function Scalar({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** `record: false` is a live slider drag; `true` pushes an undo step. */
  onChange: (n: number, record: boolean) => void;
}) {
  return (
    <div className="parameter">
      <div>
        <span>{label}</span>
        <NumberField
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onCommit={(n) => onChange(n, true)}
        />
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v, false)}
        onValueCommitted={(v) => onChange(Array.isArray(v) ? v[0] : v, true)}
      />
    </div>
  );
}

/**
 * Three numbers on one row. Sliders would eat the panel three times over, and
 * exact values matter more than sweeping when you are placing a part.
 */
function Vector({
  label,
  value,
  step = 0.01,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: Vec3;
  step?: number;
  min?: number;
  max?: number;
  onCommit: (v: Vec3) => void;
}) {
  return (
    <div className="vector-field">
      <span>{label}</span>
      <div>
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label key={axis}>
            <i>{axis}</i>
            <NumberField
              label={`${label} ${axis}`}
              value={value[i]}
              step={step}
              min={min}
              max={max}
              onCommit={(n) => {
                const next = [...value] as Vec3;
                next[i] = n;
                onCommit(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Text held as a draft until the user is done with it.
 *
 * A joint name is load-bearing — it names the bone, its clip and whatever
 * parents to it — so an empty half-typed one is a parse error. Committing on
 * blur or Enter means the schema only ever sees names the user finished.
 */
function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function send(raw: string) {
    setDraft(null);
    const next = raw.trim();
    if (next && next !== value) onCommit(next);
  }
  return (
    <input
      type="text"
      aria-label={label}
      maxLength={40}
      spellCheck={false}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => send(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          send(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** One bone of the humanoid rig: where it resolved to, and whether it is pinned. */
function BoneRow({
  name,
  at,
  pinned,
  chosen,
  innerRef,
  onSelect,
  onCommit,
  onReset,
}: {
  name: string;
  at: Vec3;
  pinned: boolean;
  chosen: boolean;
  /** Set on the chosen row only, so the panel can scroll it into view. */
  innerRef?: React.Ref<HTMLDivElement>;
  onSelect: () => void;
  onCommit: (at: Vec3) => void;
  onReset: () => void;
}) {
  return (
    <div className={`bone-row${chosen ? ' chosen' : ''}`} ref={innerRef}>
      <button
        className="bone-name"
        aria-pressed={chosen}
        onClick={onSelect}
        title="Select this bone and put its handle under the gizmo"
      >
        <strong>{name}</strong>
        {pinned && <i>moved</i>}
      </button>
      {pinned && (
        <button
          className="bone-reset"
          aria-label={`Reset ${name}`}
          title="Let the measurements place this bone again"
          onClick={onReset}
        >
          <RotateCcw size={12} />
        </button>
      )}
      <div className="bone-axes">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label key={axis}>
            <i>{axis}</i>
            <NumberField
              label={`${name} ${axis}`}
              value={at[i]}
              step={0.01}
              onCommit={(n) => {
                const next = [...at] as Vec3;
                next[i] = n;
                onCommit(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * The skeleton each document had before someone switched away from it.
 *
 * Module scope rather than a ref, because the panel holding it is unmounted by
 * the very things a person does between the two clicks: selecting a part swaps
 * the rig panel out for the part fields, and the Checks and JSON tabs unmount
 * the editor entirely. A ref would be reset by a glance at the checks, which is
 * exactly when it needs to survive.
 *
 * Keyed by what identifies the asset on screen rather than by object identity,
 * since every edit produces a new spec. Bounded, because this outlives the
 * component and nothing else would ever clear it.
 */
const STASH = new Map<string, RememberedRig>();
const STASH_LIMIT = 8;

/** Name plus part count: enough to tell two assets apart, stable across edits. */
function stashKey(spec: AssetSpec): string {
  return `${spec.name} ${spec.parts.length}`;
}

/**
 * Put aside whichever block the switch away from `kind` is about to drop.
 *
 * Merged rather than replaced so a walk through all three choices keeps both:
 * Joints → None → Body rig → None → Joints still has the joints to put back.
 */
function rememberRig(spec: AssetSpec, kind: RigKind): RememberedRig | undefined {
  const key = stashKey(spec);
  const held = STASH.get(key);
  const dropped: RememberedRig | null =
    kind === 'rig' && spec.rig
      ? { rig: spec.rig }
      : kind === 'joints' && spec.joints?.length
        ? { joints: spec.joints }
        : null;
  if (!dropped) return held;
  const next = { ...held, ...dropped };
  STASH.set(key, next);
  if (STASH.size > STASH_LIMIT) STASH.delete(STASH.keys().next().value!);
  return next;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Hand-editing whichever skeleton a spec declares.
 *
 * The two rigs are mutually exclusive by schema, so this is a three-way choice
 * and not two independent blocks: switching clears the other. Every edit runs
 * through the pure helpers in `spec-edit`, which re-validate, so the panel's
 * job is to show what came back — a cycle or a clip length disagreement lands
 * beside the joint that caused it rather than only in the status bar.
 */
function RigPanel({
  spec,
  selected,
  onSelect,
  onChange,
  onStatus,
}: {
  spec: AssetSpec;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  onChange: (next: AssetSpec, record?: boolean) => void;
  onStatus: (message: string) => void;
}) {
  const [issue, setIssue] = useState<{
    index: number | null;
    message: string;
  } | null>(null);
  const kind = rigKindOf(spec);
  const chosen = selectedBone(selected);
  // A bone picked in the outliner or grabbed in the viewport has to bring its
  // row here, or selecting a handle scrolls nothing and looks like nothing
  // happened. `useEffect` rather than `useLayoutEffect`: the latter warns on
  // the server, and a frame of delay on a scroll is invisible.
  const chosenRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chosenRow.current?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);
  const layout = boneLayout(spec);
  const joints = spec.joints ?? [];
  const clips = clipTable(spec);
  const rows = flatten(spec);
  const tally = new Map<string, number>();
  for (const row of rows)
    if (row.part.name)
      tally.set(row.part.name, (tally.get(row.part.name) ?? 0) + 1);

  /** Run one rig edit, and keep whatever the schema said about it. */
  function edit(
    make: () => AssetSpec,
    record = true,
    /** A function when the message depends on what the edit actually produced. */
    note?: string | ((next: AssetSpec) => string),
  ) {
    try {
      const next = make();
      setIssue(null);
      onChange(next, record);
      if (note) onStatus(typeof note === 'function' ? note(next) : note);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'That rig edit is invalid.';
      setIssue({ index: jointErrorIndex(message), message });
      onStatus(message);
    }
  }

  /**
   * Change which skeleton this spec has, without throwing the old one away.
   *
   * The block being dropped is stashed first, and handed back on the way in, so
   * the three buttons are a view switch rather than a delete. What the status
   * line says therefore has to be read off the result: how many joints came
   * back is not something the click can know, because a joint whose part was
   * renamed in the meantime no longer binds anything and cannot be restored.
   */
  function switchKind(next: RigKind) {
    if (next === kind) return;
    onSelect(null);
    const held = rememberRig(spec, kind);
    const dropped = kind === 'joints' ? (spec.joints?.length ?? 0) : 0;
    const putBack = next === 'joints' ? (held?.joints?.length ?? 0) : 0;

    edit(
      () => setRigKind(spec, next, held),
      true,
      (result) => {
        if (next === 'none')
          return dropped
            ? `Skeleton removed — switch back to restore ${plural(dropped, 'joint')}.`
            : 'Skeleton removed — switch back to restore the body rig. The spec exports as a static mesh.';
        const trailer = dropped
          ? ` Joints removed — switch back to restore ${plural(dropped, 'joint')}.`
          : '';
        if (next === 'rig')
          return held?.rig
            ? `Body rig restored, measurements and all.${trailer}`
            : `Body rig added: 14 bones, automatic skin weights, five clips.${trailer}`;
        // Counted by name, because a stash that could not be used at all falls
        // back to a freshly seeded pivot — one joint, but not a restored one.
        const stashed = new Set((held?.joints ?? []).map((joint) => joint.name));
        const got = (result.joints ?? []).filter((joint) =>
          stashed.has(joint.name),
        ).length;
        if (!got)
          return 'Joints rig started with one pivot. Drag its handle, or add more.';
        if (got < putBack)
          return `Restored ${plural(got, 'joint')}. ${plural(
            putBack - got,
            'joint',
          )} could not come back — the parts they carried have been renamed or duplicated.`;
        return `Restored ${plural(got, 'joint')}, pivots and clips intact.`;
      },
    );
  }

  /** The name a brand new clip would take, so the picker can offer it. */
  function freshClip(jointName: string) {
    let name = jointName;
    for (let n = 2; clips.some((clip) => clip.name === name); n++)
      name = `${jointName} ${n}`;
    return name;
  }

  return (
    <div className="property-section">
      <h3>Rig</h3>
      <div className="rig-kinds" role="group" aria-label="Rig kind">
        {(
          [
            ['none', 'None'],
            ['rig', 'Body rig'],
            ['joints', 'Joints'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            aria-pressed={kind === value}
            onClick={() => switchKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'none' && (
        <p className="help">
          A static mesh. A <strong>body rig</strong> skins it to the 14-bone
          humanoid; <strong>joints</strong> place your own pivots for a
          mechanism — a swinging tire, a turning wheel. A spec has one skeleton,
          so picking one clears the other.
        </p>
      )}
      {issue && issue.index === null && (
        <p className="rig-error" role="alert">
          {issue.message}
        </p>
      )}

      {kind === 'rig' && spec.rig && (
        <>
          {spec.rig.kind === 'quadruped' ? (
            <p className="help">
              A quadruped rig has no body measurements: four legs have no three
              numbers that describe them. Place its bones below instead.
            </p>
          ) : (
            <>
              <Scalar
                label="Hip height"
                min={0.05}
                max={4}
                step={0.01}
                value={spec.rig.hipHeight}
                onChange={(hipHeight, record) =>
                  edit(() => setRigSettings(spec, { hipHeight }), record)
                }
              />
              <Scalar
                label="Head pivot"
                min={0.05}
                max={6}
                step={0.01}
                value={spec.rig.headPivot}
                onChange={(headPivot, record) =>
                  edit(() => setRigSettings(spec, { headPivot }), record)
                }
              />
              <Scalar
                label="Shoulder width"
                min={0.02}
                max={3}
                step={0.01}
                value={spec.rig.shoulderWidth}
                onChange={(shoulderWidth, record) =>
                  edit(() => setRigSettings(spec, { shoulderWidth }), record)
                }
              />
            </>
          )}
          <p className="help">
            Below is where each bone actually ended up, in model space. Typing a
            position, or dragging its handle in the viewport, pins that bone and
            carries its children with it — the two sides are independent, so
            move <code>Arm_L</code> and <code>Arm_R</code> yourself.
            <strong> Root</strong> is movable and shifts the whole rest pose; it
            does not move the mesh.
          </p>
          <div className="bone-list">
            {layout.map((bone) => (
              <BoneRow
                key={bone.name}
                name={bone.name}
                at={bone.at}
                pinned={Boolean(
                  (spec.rig?.bones as Record<string, unknown> | undefined)?.[
                    bone.name
                  ],
                )}
                chosen={chosen === bone.name}
                innerRef={chosen === bone.name ? chosenRow : undefined}
                onSelect={() =>
                  onSelect(
                    chosen === bone.name
                      ? null
                      : { kind: 'bone', name: bone.name },
                  )
                }
                onCommit={(at) =>
                  edit(() => setBoneOverride(spec, bone.name, at))
                }
                onReset={() =>
                  edit(
                    () => setBoneOverride(spec, bone.name, undefined),
                    true,
                    `${bone.name} is measured again rather than pinned.`,
                  )
                }
              />
            ))}
          </div>
        </>
      )}

      {kind === 'joints' && (
        <>
          <p className="help">
            Each joint is a bone at <code>at</code>, carrying every part it
            binds and their children. Joints that share a clip animate together
            — which is the only way a chain reads as one mechanism — so they
            must agree on its length, and editing one length here changes them
            all.
          </p>
          <div
            className={`bone-row static${chosen === 'Root' ? ' chosen' : ''}`}
            ref={chosen === 'Root' ? chosenRow : undefined}
          >
            <button
              className="bone-name"
              aria-pressed={chosen === 'Root'}
              title="The static bone every joint hangs off"
              onClick={() =>
                onSelect(chosen === 'Root' ? null : { kind: 'bone', name: 'Root' })
              }
            >
              <strong>Root</strong>
              <i>fixed</i>
            </button>
            <span className="bone-note">always at the origin</span>
          </div>
          <div className="joint-list">
            {joints.map((joint, index) => {
              const clipName = joint.spin?.clip ?? joint.name;
              const lit = chosen === joint.name;
              return (
                <div
                  className={`joint-card${lit ? ' chosen' : ''}`}
                  key={`${joint.name}-${index}`}
                  ref={lit ? chosenRow : undefined}
                >
                  <div className="joint-head">
                    <button
                      className="bone-name"
                      aria-pressed={lit}
                      title="Select this bone in the viewport"
                      onClick={() =>
                        onSelect(lit ? null : { kind: 'bone', name: joint.name })
                      }
                    >
                      <strong>{joint.name}</strong>
                    </button>
                    <TextField
                      label={`Joint ${index + 1} name`}
                      value={joint.name}
                      onCommit={(name) =>
                        edit(() => {
                          const next = updateJoint(spec, index, { name });
                          if (lit) onSelect({ kind: 'bone', name });
                          return next;
                        })
                      }
                    />
                    <button
                      aria-label={`Remove joint ${joint.name}`}
                      title="Remove this joint"
                      onClick={() =>
                        edit(
                          () => {
                            const next = removeJoint(spec, index);
                            if (lit) onSelect(null);
                            return next;
                          },
                          true,
                          `Joint “${joint.name}” removed. Undo brings it back.`,
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <Vector
                    label="Pivot"
                    value={joint.at as Vec3}
                    onCommit={(at) => edit(() => updateJoint(spec, index, { at }))}
                  />
                  <label htmlFor={`joint-parent-${index}`}>Hangs off</label>
                  <Select
                    value={joint.parent ?? 'Root'}
                    onValueChange={(v) =>
                      edit(() =>
                        updateJoint(spec, index, {
                          // The schema rejects the literal parent "Root":
                          // omitting the field is what hangs a joint off it.
                          parent: String(v) === 'Root' ? undefined : String(v),
                        }),
                      )
                    }
                  >
                    <SelectTrigger
                      id={`joint-parent-${index}`}
                      aria-label={`${joint.name} parent`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Root">Root</SelectItem>
                      {joints
                        .filter((other) => other.name !== joint.name)
                        .map((other) => (
                          <SelectItem key={other.name} value={other.name}>
                            {other.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <span className="field-label">Carries</span>
                  <div className="bind-list">
                    {rows.map((row) => {
                      const name = row.part.name;
                      const twice = name ? (tally.get(name) ?? 0) > 1 : false;
                      const on = Boolean(name && joint.binds.includes(name));
                      const blocked = !name || twice;
                      return (
                        <label
                          key={row.path.join('.')}
                          className={blocked ? 'blocked' : ''}
                          title={
                            !name
                              ? 'Unnamed parts cannot be bound — give it a name first.'
                              : twice
                                ? `${tally.get(name)} parts share the name “${name}”. A bind has to pick one, so give them distinct names.`
                                : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={blocked && !on}
                            onChange={() => {
                              if (!name) return;
                              const binds = on
                                ? joint.binds.filter((b) => b !== name)
                                : [...joint.binds, name];
                              if (!binds.length)
                                return onStatus(
                                  'A joint carries at least one part. Bind another before clearing this one.',
                                );
                              edit(() => updateJoint(spec, index, { binds }));
                            }}
                          />
                          <strong>{name ?? 'unnamed'}</strong>
                          <span>{row.part.shape}</span>
                        </label>
                      );
                    })}
                  </div>
                  <label className="toggle">
                    <span>Spins</span>
                    <Switch
                      aria-label={`${joint.name} spins`}
                      checked={Boolean(joint.spin)}
                      onCheckedChange={(on) =>
                        edit(() => {
                          if (!on) return updateJoint(spec, index, { spin: undefined });
                          // A clip already named after this joint sets the
                          // length, or the schema refuses the pair outright.
                          const held = clips.find((c) => c.name === joint.name);
                          return updateJoint(spec, index, {
                            spin: held ? { seconds: held.seconds } : {},
                          });
                        })
                      }
                    />
                  </label>
                  {joint.spin && (
                    <>
                      <label htmlFor={`joint-axis-${index}`}>Axis</label>
                      <Select
                        value={joint.spin.axis}
                        onValueChange={(v) =>
                          edit(() =>
                            updateJoint(spec, index, {
                              spin: { axis: String(v) as 'x' | 'y' | 'z' },
                            }),
                          )
                        }
                      >
                        <SelectTrigger
                          id={`joint-axis-${index}`}
                          aria-label={`${joint.name} axis`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AXES.map((axis) => (
                            <SelectItem key={axis} value={axis}>
                              {axis.toUpperCase()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Scalar
                        label="Swing"
                        min={-180}
                        max={180}
                        step={1}
                        value={joint.spin.degrees}
                        onChange={(degrees, record) =>
                          edit(
                            () =>
                              updateJoint(spec, index, { spin: { degrees } }),
                            record,
                          )
                        }
                      />
                      <Scalar
                        label="Seconds"
                        min={0.2}
                        max={30}
                        step={0.1}
                        value={joint.spin.seconds}
                        onChange={(seconds, record) =>
                          edit(
                            () => setClipSeconds(spec, clipName, seconds),
                            record,
                          )
                        }
                      />
                      <Scalar
                        label="Lag"
                        min={-360}
                        max={360}
                        step={5}
                        value={joint.spin.phase}
                        onChange={(phase, record) =>
                          edit(
                            () => updateJoint(spec, index, { spin: { phase } }),
                            record,
                          )
                        }
                      />
                      <label htmlFor={`joint-clip-${index}`}>Clip</label>
                      <Select
                        value={clipName}
                        onValueChange={(v) =>
                          edit(() =>
                            updateJoint(spec, index, {
                              spin: { clip: String(v) },
                            }),
                          )
                        }
                      >
                        <SelectTrigger
                          id={`joint-clip-${index}`}
                          aria-label={`${joint.name} clip`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {clips.map((clip) => (
                            <SelectItem key={clip.name} value={clip.name}>
                              {clip.name} · {clip.seconds}s ·{' '}
                              {clip.members.length} joint
                              {clip.members.length === 1 ? '' : 's'}
                            </SelectItem>
                          ))}
                          {!clips.some((c) => c.name === freshClip(joint.name)) && (
                            <SelectItem value={freshClip(joint.name)}>
                              New clip “{freshClip(joint.name)}”…
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      {(clips.find((c) => c.name === clipName)?.members.length ??
                        0) > 1 && (
                        <p className="help">
                          {clipName} carries{' '}
                          {clips.find((c) => c.name === clipName)!.members.length}{' '}
                          joints — its length is shared by all of them.
                        </p>
                      )}
                    </>
                  )}
                  {issue?.index === index && (
                    <p className="rig-error" role="alert">
                      {issue.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <button
            className="add-joint"
            onClick={() =>
              edit(
                () => addJoint(spec),
                true,
                'Joint added at the centre of the model. Drag its handle to place it.',
              )
            }
          >
            <Plus size={14} /> Add joint
          </button>
        </>
      )}
    </div>
  );
}

const AUDIT_MARK = { error: '✗', warn: '!', info: '·' } as const;

/**
 * The properties panel: what the one selected thing is made of.
 *
 * Three states, because the panel is read against a selection rather than
 * against the whole spec — a part shows its own fields, a bone shows the rig
 * scrolled to it, and an empty selection shows what belongs to the asset
 * itself. Showing all of it at once is how the panel used to grow past the
 * height of any screen.
 *
 * The scene list moved out to `Outliner` and is still rendered here until the
 * layout gives it a column of its own; `showParts={false}` is how that column
 * takes it over without either panel losing it in between.
 */
export function SpecEditor({
  spec,
  audit,
  selected,
  onSelect,
  onChange,
  onDelete,
  onDuplicate,
  onStatus,
  showParts = true,
}: {
  spec: AssetSpec;
  audit: Audit | null;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  /** `record: false` is a live drag; `true` pushes an undo step. */
  onChange: (next: AssetSpec, record?: boolean) => void;
  /** Shared with the viewport's Delete and Cmd+D so both behave the same. */
  onDelete: () => void;
  onDuplicate: () => void;
  onStatus: (message: string) => void;
  /** False once the layout mounts `Outliner` in its own panel. */
  showParts?: boolean;
}) {
  // A bone selection belongs to the rig panel, not to the part fields, so the
  // two are read separately rather than as one "is anything selected".
  const picked = selectedPath(selected);
  const bone = selectedBone(selected);
  const part = picked ? partAt(spec, picked) : undefined;
  const mode = part && picked ? 'part' : bone ? 'bone' : 'asset';

  function patch(p: PartPatch, record = true) {
    if (!picked) return;
    try {
      onChange(updatePart(spec, picked, p), record);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'That edit is invalid.');
    }
  }

  function field<K extends keyof Part>(key: K, fallback: NonNullable<Part[K]>) {
    return (part?.[key] ?? fallback) as NonNullable<Part[K]>;
  }

  /** Surface settings live on the spec, not on a part, so they patch separately. */
  function patchSurface(
    next: Partial<NonNullable<AssetSpec['surface']>>,
    record: boolean,
  ) {
    if (!spec.surface) return;
    onChange({ ...spec, surface: { ...spec.surface, ...next } }, record);
  }

  const repeat = part?.repeat;

  return (
    <>
      {showParts && (
        <div className="property-section">
          <h3>Parts</h3>
          <Outliner
            spec={spec}
            selected={selected}
            onSelect={onSelect}
            bones
            // The tree only ever fires these for the row it has selected, so
            // routing them to the page's selection-based handlers cannot act
            // on the wrong part.
            onDelete={picked ? () => onDelete() : undefined}
            onDuplicate={picked ? () => onDuplicate() : undefined}
          />
        </div>
      )}

      {mode === 'asset' && (
        <>
        <div className="property-section identity">
          <label htmlFor="spec-name">Asset name</label>
          <input
            id="spec-name"
            value={spec.name}
            maxLength={60}
            onChange={(e) => onChange({ ...spec, name: e.target.value }, false)}
            onBlur={() => onChange({ ...spec, name: spec.name })}
          />
          <label htmlFor="spec-seed">Scatter seed</label>
          <div className="seed-row">
            <input
              id="spec-seed"
              type="number"
              min={0}
              max={2147483647}
              value={spec.seed}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 2147483647)
                  onChange({ ...spec, seed: n }, false);
              }}
              onBlur={() => onChange({ ...spec, seed: spec.seed })}
            />
            <button
              title="Re-roll every scatter, twist and jitter"
              aria-label="Re-roll the scatter seed"
              onClick={() => {
                const seed =
                  crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
                onChange({ ...spec, seed });
                onStatus(
                  'Re-rolled the seed. Every scattered repeat found a new arrangement.',
                );
              }}
            >
              <Shuffle size={17} />
            </button>
          </div>
        </div>

        <div className="property-section">
          <h3>Mesh</h3>
          <p className="help">
            Surface mode fuses every part into one continuous polygon mesh
            instead of leaving them stacked as separate solids — no buried
            faces, one shell to unwrap, and topology that holds together when
            the rig bends it.
          </p>
          <label className="toggle">
            <span>Single polygon mesh</span>
            <Switch
              aria-label="Single polygon mesh"
              checked={Boolean(spec.surface)}
              onCheckedChange={(on) =>
                onChange({
                  ...spec,
                  surface: on
                    ? (spec.surface ?? {
                        blend: 0.03,
                        detail: 128,
                        budget: 6000,
                        shading: 'flat',
                      })
                    : undefined,
                })
              }
            />
          </label>
          {spec.surface && (
            <>
              <Scalar
                label="Blend"
                value={spec.surface.blend}
                min={0}
                max={0.2}
                step={0.005}
                onChange={(blend: number, record) =>
                  patchSurface({ blend }, record)
                }
              />
              <p className="help">
                How softly parts melt together. A blend closes gaps up to half
                its own width, so 6 cm fuses parts sitting 3 cm apart. Zero welds
                them with a hard crease.
              </p>
              <Scalar
                label="Detail"
                value={spec.surface.detail}
                min={24}
                max={320}
                step={8}
                onChange={(detail: number, record) =>
                  patchSurface({ detail }, record)
                }
              />
              <Scalar
                label="Triangle budget"
                value={spec.surface.budget}
                min={200}
                max={60000}
                step={200}
                onChange={(budget: number, record) =>
                  patchSurface({ budget }, record)
                }
              />
              <label className="toggle">
                <span>Smooth shading</span>
                <Switch
                  aria-label="Smooth shading"
                  checked={spec.surface.shading === 'smooth'}
                  onCheckedChange={(on) =>
                    patchSurface({ shading: on ? 'smooth' : 'flat' }, true)
                  }
                />
              </label>
            </>
          )}
        </div>
        </>
      )}

      {mode !== 'part' && (
        <RigPanel
          spec={spec}
          selected={selected}
          onSelect={onSelect}
          onChange={onChange}
          onStatus={onStatus}
        />
      )}

      {audit && (
        <div className="property-section">
          <h3>
            Checks
            <span className={audit.ok ? 'audit-pass' : 'audit-fail'}>
              {audit.ok ? 'PASS' : 'PROBLEMS'}
            </span>
          </h3>
          <div className="audit-list">
            {audit.findings.map((finding, i) => (
              <button
                key={`${finding.code}-${i}`}
                className={`audit-${finding.severity}`}
                disabled={!finding.part}
                onClick={() =>
                  finding.part &&
                  onSelect({ kind: 'part', path: finding.part })
                }
              >
                <i>{AUDIT_MARK[finding.severity]}</i>
                <span>{finding.message}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {part && picked && (
        <>
          <div className="property-section">
            <div className="part-header">
              <h3>{labelFor(part)}</h3>
              <button
                aria-label="Duplicate part"
                title="Duplicate part"
                onClick={onDuplicate}
              >
                <Copy size={14} />
              </button>
              <button
                aria-label="Delete part"
                title="Delete part"
                onClick={onDelete}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <label htmlFor="part-name">Name</label>
            <input
              id="part-name"
              value={part.name ?? ''}
              maxLength={60}
              placeholder={part.shape}
              onChange={(e) => patch({ name: e.target.value }, false)}
              onBlur={() => patch({ name: part.name })}
            />
            <label htmlFor="part-shape">Shape</label>
            <Select
              value={part.shape}
              onValueChange={(v) => patch({ shape: String(v) as Part['shape'] })}
            >
              <SelectTrigger id="part-shape" aria-label="Part shape">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHAPES.map((shape) => (
                  <SelectItem key={shape} value={shape}>
                    {shape}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="property-section">
            <h3>Placement</h3>
            {part.shape === 'limb' ? (
              <>
                <p className="help">
                  A limb is a tube drawn between two points, so it is placed by
                  its ends rather than by a size. Both are read inside the
                  part&rsquo;s own frame — the rotate gizmo swings them for you.
                </p>
                <Vector
                  label="From"
                  value={field('from', [0, 0, 0]) as Vec3}
                  onCommit={(from) => patch({ from })}
                />
                <Vector
                  label="To"
                  value={field('to', [0, 1, 0]) as Vec3}
                  onCommit={(to) => patch({ to })}
                />
              </>
            ) : (
              <Vector
                label="Size"
                min={0.001}
                value={field('size', [1, 1, 1]) as Vec3}
                onCommit={(size) => patch({ size })}
              />
            )}
            <Vector
              label="Position"
              value={field('position', [0, 0, 0]) as Vec3}
              onCommit={(position) => patch({ position })}
            />
            <Vector
              label="Rotation"
              step={1}
              value={field('rotation', [0, 0, 0]) as Vec3}
              onCommit={(rotation) => patch({ rotation })}
            />
            {part.shape === 'limb' && (
              <Scalar
                label="Thickness"
                min={0.005}
                max={0.6}
                step={0.005}
                value={field('radius', 0.1)}
                onChange={(radius, record) => patch({ radius }, record)}
              />
            )}
          </div>

          <div className="property-section">
            <h3>Surface</h3>
            <Scalar
              label="Detail"
              min={3}
              max={24}
              value={field('detail', 6)}
              onChange={(detail: number, record) =>
                patch({ detail }, record)
              }
            />
            <Scalar
              label="Erosion"
              min={0}
              max={1}
              step={0.01}
              value={field('jitter', 0)}
              onChange={(jitter, record) => patch({ jitter }, record)}
            />
            {TAPERED.has(part.shape) && (
              <Scalar
                label="Taper"
                min={0}
                max={4}
                step={0.05}
                value={field('taper', 1)}
                onChange={(taper, record) => patch({ taper }, record)}
              />
            )}
            <div className="swatches">
              {SOLID_COLORS.map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  className={part.color === color ? 'chosen' : ''}
                  aria-label={`Use color ${color}`}
                  aria-pressed={part.color === color}
                  onClick={() => patch({ color })}
                />
              ))}
              <label title="Custom color">
                <input
                  type="color"
                  aria-label="Custom part color"
                  value={part.color ?? spec.color}
                  onChange={(e) => patch({ color: e.target.value }, false)}
                  onBlur={() => patch({ color: part.color })}
                />
                <span>+</span>
              </label>
            </div>
            <span className="hex-value">
              {(part.color ?? spec.color).toUpperCase()}
              {part.color ? '' : ' (inherited)'}
            </span>
          </div>

          {repeat && (
            <div className="property-section">
              <h3>Repeat · {repeat.mode ?? 'linear'}</h3>
              <Scalar
                label="Count"
                min={1}
                max={64}
                value={repeat.count}
                onChange={(count, record) =>
                  patch({ repeat: { ...repeat, count } }, record)
                }
              />
              {repeat.mode === 'radial' && (
                <>
                  <Scalar
                    label="Orbit radius"
                    min={0}
                    max={3}
                    step={0.01}
                    value={repeat.radius ?? 1}
                    onChange={(radius, record) =>
                      patch({ repeat: { ...repeat, radius } }, record)
                    }
                  />
                  <Scalar
                    label="Arc"
                    min={-360}
                    max={360}
                    value={repeat.arc ?? 360}
                    onChange={(arc, record) =>
                      patch({ repeat: { ...repeat, arc } }, record)
                    }
                  />
                </>
              )}
              <Vector
                label="Scatter"
                value={(repeat.scatter ?? [0, 0, 0]) as Vec3}
                onCommit={(scatter) =>
                  patch({ repeat: { ...repeat, scatter } })
                }
              />
              <Scalar
                label="Twist"
                min={0}
                max={180}
                value={repeat.twist ?? 0}
                onChange={(twist, record) =>
                  patch({ repeat: { ...repeat, twist } }, record)
                }
              />
              <Scalar
                label="Size variance"
                min={0}
                max={1}
                step={0.01}
                value={repeat.sizeJitter ?? 0}
                onChange={(sizeJitter, record) =>
                  patch({ repeat: { ...repeat, sizeJitter } }, record)
                }
              />
            </div>
          )}
        </>
      )}

      {mode === 'asset' && (
        <div className="property-section">
          <h3>Game scale</h3>
          <Scalar
            label="Scale multiplier"
            min={0.1}
            max={5}
            step={0.1}
            value={spec.scale}
            onChange={(scale, record) => onChange({ ...spec, scale }, record)}
          />
          <p className="help">
            1 unit = 1 meter. Edits stay in the spec — download it to keep them.
          </p>
        </div>
      )}
    </>
  );
}
