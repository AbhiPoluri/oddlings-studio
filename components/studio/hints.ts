/**
 * A finding's suggested fix, in words and as an edit.
 *
 * The audit is allowed to say more than "this part floats": when it can measure
 * the answer it attaches a hint — a translation, a setting to raise, and the
 * neighbour it measured against. Turning that into a button is the difference
 * between a report and a tool, and it is worth being careful about, because a
 * button that moves geometry has to move it the way the check meant.
 *
 * Which is the awkward part of this file. `Hint.move` means one thing, but
 * `Hint.grow` means what the check that produced it says it means: on
 * `detached-shell` it is a `surface.blend` to raise to, not a multiplier on
 * anything. That is a contract detail, so it lives in exactly one place —
 * `BLEND_CODES` below — rather than being rediscovered by each caller.
 *
 * Optional at both ends by design. A finding without a hint is the row it
 * always was, and nothing here requires the field to exist.
 */
import type { Hint } from '@/lib/asset-audit';
import type { Part } from '@/lib/asset-spec';
import type { PartPatch, Vec3 } from '@/lib/spec-edit';

export type { Hint };

/** Just enough of a finding to read its hint. */
export type Hinted = { code: string; hint?: Hint };

/**
 * Checks whose `grow` is a value to raise `surface.blend` to.
 *
 * `detached-shell` fires when a fused mesh falls into pieces, and the fix is to
 * blend harder rather than to resize anything — the audit hands back the blend
 * that would close the gap. Treating that number as a scale would shrink the
 * part to a twenty-fifth of its size, which is why this set exists rather than
 * one rule applied hopefully to both.
 */
const BLEND_CODES = new Set(['detached-shell']);

/** What applying a hint does: a patch to one part, a setting on the asset, or both. */
export type HintPlan = { patch?: PartPatch; blend?: number };

/** A spec holds numbers a person will read in a diff, not float noise. */
const round = (n: number) => Math.round(n * 10_000) / 10_000;

const shift = (at: Vec3 | undefined, by: Vec3): Vec3 => [
  round((at?.[0] ?? 0) + by[0]),
  round((at?.[1] ?? 0) + by[1]),
  round((at?.[2] ?? 0) + by[2]),
];

/**
 * What one Apply would do, or null when it would do nothing.
 *
 * A limb is placed by its endpoints and has no `position` the builder reads, so
 * moving one means moving both ends — anything else would stretch it rather
 * than translate it. Everything else moves by its `position`.
 *
 * One caveat, from the audit's own documentation: `move` is in model space, and
 * a part whose parent is rotated would need it rotated into that parent's frame
 * first. Doing that needs the built model, which this does not have, and the
 * rotated parent is the uncommon case — so the number is added as written, and
 * the result is visible in the viewport the moment it is applied.
 */
export function planHint(
  finding: Hinted,
  part: Part | undefined,
): HintPlan | null {
  const hint = finding.hint;
  if (!hint || !part) return null;
  const plan: HintPlan = {};
  if (hint.move && hint.move.some((n) => n !== 0)) {
    const by = hint.move as Vec3;
    const patch: PartPatch = {};
    if (part.from || part.to) {
      patch.from = shift(part.from as Vec3 | undefined, by);
      patch.to = shift(part.to as Vec3 | undefined, by);
    } else {
      patch.position = shift(part.position as Vec3 | undefined, by);
    }
    plan.patch = patch;
  }
  if (typeof hint.grow === 'number' && hint.grow > 0) {
    if (BLEND_CODES.has(finding.code)) {
      plan.blend = round(hint.grow);
    } else if (hint.grow !== 1) {
      const patch: PartPatch = plan.patch ?? {};
      if (part.size)
        patch.size = [
          round(part.size[0] * hint.grow),
          round(part.size[1] * hint.grow),
          round(part.size[2] * hint.grow),
        ];
      if (typeof part.radius === 'number')
        patch.radius = round(part.radius * hint.grow);
      if (Object.keys(patch).length) plan.patch = patch;
    }
  }
  return plan.patch || plan.blend !== undefined ? plan : null;
}

/** A typographic minus, because a hyphen at 11px reads as a dash in a list. */
const number = (n: number) => (n < 0 ? `−${round(-n)}` : String(round(n)));

/** The hint as a sentence, e.g. `move [0, −0.03, 0] toward hull`. */
export function describeHint(finding: Hinted): string {
  const hint = finding.hint;
  if (!hint) return '';
  const said: string[] = [];
  if (hint.move && hint.move.some((n) => n !== 0))
    said.push(`move [${hint.move.map(number).join(', ')}]`);
  if (typeof hint.grow === 'number' && hint.grow > 0) {
    if (BLEND_CODES.has(finding.code))
      said.push(`raise blend to ${round(hint.grow)}`);
    else if (hint.grow !== 1)
      said.push(`${hint.grow > 1 ? 'grow' : 'shrink'} ×${round(hint.grow)}`);
  }
  if (!said.length) return '';
  return hint.toward
    ? `${said.join(' and ')} toward ${hint.toward}`
    : said.join(' and ');
}
