import '../lib/node-shims';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  addJoint,
  clipTable,
  jointErrorIndex,
  moveBone,
  removeJoint,
  rigKindOf,
  setBoneOverride,
  setClipSeconds,
  setRigKind,
  updateJoint,
  type Vec3,
} from '../lib/spec-edit';
import { boneLayout } from '../lib/asset-joints';
import { parseSpec, type AssetSpec } from '../lib/asset-spec';

/** The two shipped specs are the fixtures, so the tests move with the format. */
function fixture(file: string): AssetSpec {
  return parseSpec(JSON.parse(readFileSync(`specs/${file}`, 'utf8')));
}
/** A Swing → Tire chain, both joints in one 3.2s clip called "Swing". */
const swing = fixture('tire-swing-tree-leafy.spec.json');
/** A 14-bone body rig, no overrides. */
const godzilla = fixture('godzilla.spec.json');

const placeOf = (spec: AssetSpec, name: string) =>
  boneLayout(spec).find((bone) => bone.name === name)!;

describe('which rig a spec has', () => {
  test('reads the kind off the spec', () => {
    expect(rigKindOf(swing)).toBe('joints');
    expect(rigKindOf(godzilla)).toBe('rig');
    expect(rigKindOf(setRigKind(godzilla, 'none'))).toBe('none');
  });

  test('switching to joints drops the body rig and seeds one joint', () => {
    const next = setRigKind(godzilla, 'joints');
    expect(next.rig).toBeUndefined();
    expect(next.joints).toHaveLength(1);
    const [joint] = next.joints!;
    expect(joint.name).toBe('Pivot');
    expect(joint.binds).toHaveLength(1);
    // The seed has to bind a part that actually exists, uniquely.
    const named = next.parts.flatMap(function names(part): string[] {
      return [
        ...(part.name ? [part.name] : []),
        ...(part.children ?? []).flatMap(names),
      ];
    });
    expect(named).toContain(joint.binds[0]);
    // And the skeleton it describes is Root plus that one bone.
    expect(boneLayout(next).map((b) => b.name)).toEqual(['Root', 'Pivot']);
  });

  test('switching to a body rig drops the joints', () => {
    const next = setRigKind(swing, 'rig');
    expect(next.joints).toBeUndefined();
    expect(next.rig).toBeDefined();
    expect(boneLayout(next)).toHaveLength(14);
  });
});

describe('moveBone on a joints rig', () => {
  test('writes the joint position and the layout follows', () => {
    const next = moveBone(swing, 'Tire', [0.6, 0.25, 0.3]);
    expect(next.joints![1].at).toEqual([0.6, 0.25, 0.3]);
    expect(placeOf(next, 'Tire').at).toEqual([0.6, 0.25, 0.3]);
    // `at` is absolute, so moving a child leaves its parent where it was.
    expect(placeOf(next, 'Swing').at).toEqual(placeOf(swing, 'Swing').at);
    expect(placeOf(next, 'Tire').parent).toBe('Swing');
  });

  test('rounds what a drag hands it so the spec stays readable', () => {
    const next = moveBone(swing, 'Swing', [0.1234567, 0.5, -0.25004]);
    expect(next.joints![0].at).toEqual([0.123, 0.5, -0.25]);
  });

  test('refuses Root, which is always the origin', () => {
    expect(() => moveBone(swing, 'Root', [1, 1, 1])).toThrow(/always sits at the origin/);
    expect(placeOf(swing, 'Root').at).toEqual([0, 0, 0]);
  });

  test('refuses a bone no joint is called', () => {
    expect(() => moveBone(swing, 'Elbow', [0, 0, 0])).toThrow(/No joint is called/);
  });
});

describe('moveBone on a body rig', () => {
  test('writes an override and carries the children by the same delta', () => {
    const before = boneLayout(godzilla);
    const hips = placeOf(godzilla, 'Hips').at;
    const step: Vec3 = [0.05, -0.12, 0.03];
    const moved: Vec3 = [hips[0] + step[0], hips[1] + step[1], hips[2] + step[2]];
    const next = moveBone(godzilla, 'Hips', moved);
    expect(next.rig!.bones).toEqual({ Hips: moved });
    expect(next.joints).toBeUndefined();

    const after = boneLayout(next);
    // Hips carries Spine, both thighs and everything under them; the Root above
    // it does not move. That is what makes dragging a pivot behave like a rig.
    const carried = ['Hips', 'Spine', 'Head', 'Thigh_L', 'Shin_L', 'Foot_L'];
    for (const name of carried) {
      const from = before.find((b) => b.name === name)!.at;
      const to = after.find((b) => b.name === name)!.at;
      expect(to.map((n, i) => Math.round((n - from[i]) * 1000) / 1000)).toEqual(step);
    }
    expect(after.find((b) => b.name === 'Root')!.at).toEqual([0, 0, 0]);
  });

  test('a child with its own override stays where it was pinned', () => {
    const pinned = setBoneOverride(godzilla, 'Head', [0, 1.4, 0.2]);
    const hips = placeOf(pinned, 'Hips').at;
    const next = moveBone(pinned, 'Hips', [hips[0], hips[1] + 0.3, hips[2]]);
    expect(placeOf(next, 'Head').at).toEqual([0, 1.4, 0.2]);
    // Its unpinned sibling still follows.
    expect(placeOf(next, 'Spine').at[1]).toBeCloseTo(placeOf(pinned, 'Spine').at[1] + 0.3, 6);
  });

  test('clearing the last override drops the bones block entirely', () => {
    const pinned = setBoneOverride(godzilla, 'Head', [0, 1.4, 0.2]);
    expect(setBoneOverride(pinned, 'Head', undefined).rig!.bones).toBeUndefined();
    expect(placeOf(setBoneOverride(pinned, 'Head', undefined), 'Head').at).toEqual(
      placeOf(godzilla, 'Head').at,
    );
  });

  test('refuses a name that is not one of the 14 bones', () => {
    expect(() => moveBone(godzilla, 'Tail', [0, 0, 0])).toThrow(/not one of the 14 bones/);
  });
});

describe('adding joints', () => {
  test('joining an existing clip copies its length, and the result parses', () => {
    const next = addJoint(swing, {
      name: 'Branch',
      at: [0.2, 0.9, 0],
      parent: 'Swing',
      binds: ['tire'],
      spin: { axis: 'z', degrees: 4, clip: 'Swing' },
    });
    const added = next.joints![2];
    expect(added.spin!.seconds).toBe(3.2);
    // Which is exactly the condition the schema enforces, so it round-trips.
    expect(() => parseSpec(next)).not.toThrow();
    expect(clipTable(next)).toEqual([
      { name: 'Swing', seconds: 3.2, members: [0, 1, 2] },
    ]);
  });

  test('a joint on a clip of its own keeps the length it asked for', () => {
    const next = addJoint(swing, {
      name: 'Leaf',
      binds: ['tire'],
      spin: { degrees: 3, seconds: 1.5 },
    });
    expect(next.joints![2].spin!.seconds).toBe(1.5);
    expect(clipTable(next).map((c) => c.name)).toEqual(['Swing', 'Leaf']);
  });

  test('a name already taken is made unique rather than rejected', () => {
    expect(addJoint(swing, { name: 'Tire', binds: ['tire'] }).joints![2].name).toBe(
      'Tire 2',
    );
  });
});

describe('editing joints', () => {
  test('a cycle comes back as the schema message, not as a corrupt spec', () => {
    // Swing already carries Tire, so parenting Swing to Tire closes the loop.
    expect(() => updateJoint(swing, 0, { parent: 'Tire' })).toThrow(
      /hangs off itself/,
    );
    expect(swing.joints![0].parent).toBeUndefined();
    let message = '';
    try {
      updateJoint(swing, 0, { parent: 'Tire' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(jointErrorIndex(message)).toBe(0);
  });

  test('an unknown parent names the joint it was set on', () => {
    let message = '';
    try {
      updateJoint(swing, 1, { parent: 'Bough' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no joint is called that/);
    expect(jointErrorIndex(message)).toBe(1);
  });

  test('renaming a joint carries its children and its clip with it', () => {
    const next = updateJoint(swing, 0, { name: 'Bough' });
    expect(next.joints!.map((j) => j.name)).toEqual(['Bough', 'Tire']);
    // The child pointed at "Swing"; leaving it there would be a parse error.
    expect(next.joints![1].parent).toBe('Bough');
    // And the pair stays one mechanism: Tire named the clip "Swing" outright,
    // so the renamed joint holds on to it rather than starting its own.
    expect(clipTable(next)).toEqual([
      { name: 'Swing', seconds: 3.2, members: [0, 1] },
    ]);
  });

  test('clearing parent hangs the joint off the root bone', () => {
    const next = updateJoint(swing, 1, { parent: undefined });
    expect(next.joints![1].parent).toBeUndefined();
    expect(placeOf(next, 'Tire').parent).toBe('Root');
  });

  test('moving a joint onto another clip adopts that clip length', () => {
    const apart = setClipSeconds(swing, 'Swing', 3.2);
    const solo = updateJoint(apart, 1, { spin: { clip: 'Bounce', seconds: 1 } });
    expect(clipTable(solo).map((c) => [c.name, c.seconds])).toEqual([
      ['Swing', 3.2],
      ['Bounce', 1],
    ]);
    const rejoined = updateJoint(solo, 1, { spin: { clip: 'Swing' } });
    expect(rejoined.joints![1].spin!.seconds).toBe(3.2);
  });

  test('setClipSeconds keeps every member of one clip the same length', () => {
    const next = setClipSeconds(swing, 'Swing', 5);
    expect(next.joints!.map((j) => j.spin!.seconds)).toEqual([5, 5]);
    expect(() => parseSpec(next)).not.toThrow();
  });
});

describe('removing joints', () => {
  test('children adopt the parent of the joint that was removed', () => {
    const deep = addJoint(swing, { name: 'Weight', parent: 'Tire', binds: ['tire'] });
    const next = removeJoint(deep, 1); // Tire, which Weight hangs off
    expect(next.joints!.map((j) => j.name)).toEqual(['Swing', 'Weight']);
    expect(next.joints![1].parent).toBe('Swing');
    expect(placeOf(next, 'Weight').parent).toBe('Swing');
  });

  test('a child of a root-level joint goes back to the root, not to "Root"', () => {
    const next = removeJoint(swing, 0); // Swing hangs off nothing
    expect(next.joints!.map((j) => j.name)).toEqual(['Tire']);
    expect(next.joints![0].parent).toBeUndefined();
    expect(placeOf(next, 'Tire').parent).toBe('Root');
    expect(() => parseSpec(next)).not.toThrow();
  });

  test('the last joint is kept: an empty list is not a rig', () => {
    const one = removeJoint(swing, 0);
    expect(() => removeJoint(one, 0)).toThrow(/at least one joint/);
  });
});
