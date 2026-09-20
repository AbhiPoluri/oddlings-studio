import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import {
  buildSpec,
  parseSpec,
  specJSONSchema,
  type AssetSpec,
  type AuthoredSpecInput,
} from '../lib/asset-spec';
import {
  contractPrefabs,
  contractSaved,
  expandPrefabs,
  MAX_PREFAB_DEPTH,
} from '../lib/asset-prefabs';
import { flatten, updatePart, duplicatePart, copiesOf } from '../lib/spec-edit';
import { stats } from '../lib/asset-build';
import { auditModel } from '../lib/asset-audit';

/** A def worth stamping: a part with a part hanging off it. */
const bracket = {
  name: 'bracket',
  shape: 'box',
  size: [0.3, 0.06, 0.06],
  color: '#4a525a',
  children: [
    {
      name: 'bolt',
      shape: 'sphere',
      size: [0.05, 0.05, 0.05],
      position: [0.12, 0, 0],
    },
  ],
} as const;

const post: AuthoredSpecInput = {
  version: 1,
  name: 'Lantern Post',
  kind: 'prop',
  defs: { bracket },
  parts: [
    {
      name: 'post',
      shape: 'cylinder',
      size: [0.12, 2, 0.12],
      position: [0, 1, 0],
      children: [
        { use: 'bracket', name: 'bracket_e', position: [0.18, 0.8, 0] },
        {
          use: 'bracket',
          name: 'bracket_w',
          position: [-0.18, 0.8, 0],
          rotation: [0, 180, 0],
        },
      ],
    },
  ],
};

/** The part at a path, with no pretence that it might be missing. */
function at(spec: AssetSpec, ...path: number[]) {
  let list = spec.parts;
  for (const index of path.slice(0, -1)) list = list[index].children!;
  return list[path[path.length - 1]];
}

/**
 * Every triangle a spec draws, and where.
 *
 * Names, world transforms and vertices: the whole of what "builds identically"
 * can mean short of exporting both and diffing the bytes.
 */
function geometry(model: T.Object3D): string {
  const hash = createHash('sha256');
  model.updateMatrixWorld(true);
  model.traverse((node) => {
    const mesh = node as T.Mesh;
    if (!mesh.isMesh) return;
    const points = Array.from(mesh.geometry.getAttribute('position').array);
    hash.update(
      `${mesh.name}|${mesh.matrixWorld.elements.map((n) => n.toFixed(6)).join(',')}|${points
        .map((n) => n.toFixed(5))
        .join(',')}\n`,
    );
  });
  return hash.digest('hex');
}

const meshes = (model: T.Object3D) =>
  model.children.length ? stats(model).meshes : 0;

describe('expansion', () => {
  test('a use becomes the part the def names', () => {
    const spec = parseSpec(post);
    const arm = at(spec, 0, 0);
    expect(arm.shape).toBe('box');
    expect(arm.size).toEqual([0.3, 0.06, 0.06]);
    expect(arm.color).toBe('#4a525a');
    expect(arm.children).toHaveLength(1);
    expect(arm.children![0].name).toBe('bolt');
    // The whole point: nothing downstream is handed a `use` to interpret.
    for (const row of flatten(spec))
      expect(row.part).not.toHaveProperty('use');
  });

  test('the def library survives the parse, so the file can be written back', () => {
    expect(parseSpec(post).defs?.bracket).toEqual(bracket);
  });

  test('each copy says which def drew it, and where it was used', () => {
    const spec = parseSpec(post);
    expect(at(spec, 0, 0).prefab).toEqual({ def: 'bracket', use: [0, 0] });
    expect(at(spec, 0, 1).prefab).toEqual({ def: 'bracket', use: [0, 1] });
    // Only the use site is marked. The def's own children are ordinary parts:
    // a mark on each of them would have to be re-derived to compare a copy
    // against its def, and it is the use site a save-back has to find.
    expect(at(spec, 0, 0).children![0].prefab).toBeUndefined();
  });

  test('the mesh carries the mark, so a viewport can group the copies', () => {
    const found: unknown[] = [];
    buildSpec(post).traverse((node) => {
      if (node.userData.prefab) found.push(node.userData.prefab);
    });
    expect(found).toEqual([
      { def: 'bracket', use: [0, 0] },
      { def: 'bracket', use: [0, 1] },
    ]);
  });

  test('is pure, and the same twice', () => {
    const input = structuredClone(post);
    const once = expandPrefabs(input);
    expect(input).toEqual(post);
    expect(once).toEqual(expandPrefabs(structuredClone(post)));
    expect(once).not.toBe(input);
  });

  test('an expanded spec parses again unchanged, which is what every edit does', () => {
    const spec = parseSpec(post);
    expect(parseSpec(spec)).toEqual(spec);
  });

  test('a spec with no prefabs is handed straight back', () => {
    const plain = { version: 1, name: 'x', kind: 'prop', parts: [{ shape: 'box' }] };
    expect(expandPrefabs(plain)).toBe(plain);
  });
});

describe('overrides', () => {
  const use = (extra: Record<string, unknown>) =>
    parseSpec({
      ...post,
      parts: [{ use: 'bracket', ...extra }],
    } as unknown);

  test('a use places, sizes, finishes and binds its copy', () => {
    const spec = use({
      name: 'left arm',
      position: [1, 2, 3],
      rotation: [0, 45, 0],
      size: [1, 0.1, 0.1],
      color: '#ff0000',
      material: 'iron',
      rigPart: 'arm_l',
      rest: { on: 'any' },
    });
    const part = at(spec, 0);
    expect(part.name).toBe('left arm');
    expect(part.position).toEqual([1, 2, 3]);
    expect(part.rotation).toEqual([0, 45, 0]);
    // An array is replaced whole: there is no such thing as overriding the y
    // of a size, because a half-stated size is not a size.
    expect(part.size).toEqual([1, 0.1, 0.1]);
    expect(part.color).toBe('#ff0000');
    expect(part.material).toBe('iron');
    expect(part.rigPart).toBe('arm_l');
    expect(part.rest?.on).toBe('any');
    // Everything else still comes from the def.
    expect(part.shape).toBe('box');
    expect(part.children![0].name).toBe('bolt');
  });

  test('children on a use are added to the def’s, not swapped for them', () => {
    const spec = use({
      children: [{ name: 'flag', shape: 'plane', size: [0.1, 0.1, 0.01] }],
    });
    expect(at(spec, 0).children!.map((child) => child.name)).toEqual([
      'bolt',
      'flag',
    ]);
  });

  test('a child of a use may itself be a use', () => {
    const spec = parseSpec({
      ...post,
      parts: [{ use: 'bracket', children: [{ use: 'bracket', name: 'inner' }] }],
    } as unknown);
    const inner = at(spec, 0, 1);
    expect(inner.name).toBe('inner');
    expect(inner.shape).toBe('box');
    expect(inner.prefab).toEqual({ def: 'bracket', use: [0, 1] });
  });

  test('a use cannot redraw the part, and the refusal says where to put it', () => {
    for (const key of ['shape', 'detail', 'jitter', 'profile', 'bevel'])
      expect(() => use({ [key]: key === 'shape' ? 'sphere' : 1 })).toThrow(
        new RegExp(`"${key}" cannot be set on a use of prefab "bracket"`),
      );
    expect(() => use({ shape: 'sphere' })).toThrow(/Set "shape" in "defs.bracket"/);
  });

  test('an unknown def is refused by name, with the ones there are', () => {
    expect(() => use({ use: 'rivet' })).toThrow(
      /There is no prefab called "rivet"\. "defs" holds: bracket\./,
    );
    expect(() =>
      parseSpec({ version: 1, name: 'x', kind: 'prop', parts: [{ use: 'rivet' }] }),
    ).toThrow(/needs a "defs" block/);
  });
});

describe('defs that use defs', () => {
  const chain: AuthoredSpecInput = {
    version: 1,
    name: 'Nested',
    kind: 'prop',
    defs: {
      bolt: { name: 'bolt', shape: 'sphere', size: [0.05, 0.05, 0.05] },
      plate: {
        name: 'plate',
        shape: 'box',
        size: [0.4, 0.4, 0.04],
        children: [
          { use: 'bolt', name: 'bolt_a', position: [-0.15, 0.15, 0.02] },
          { use: 'bolt', name: 'bolt_b', position: [0.15, 0.15, 0.02] },
        ],
      },
    },
    parts: [{ use: 'plate', position: [0, 1, 0] }],
  };

  test('a def may be built out of other defs', () => {
    const spec = parseSpec(chain);
    const plate = at(spec, 0);
    expect(plate.shape).toBe('box');
    expect(plate.children!.map((child) => child.name)).toEqual([
      'bolt_a',
      'bolt_b',
    ]);
    expect(plate.children![0].shape).toBe('sphere');
    // Each expansion names its own def, so a nested stamp is traceable too.
    expect(plate.prefab!.def).toBe('plate');
    expect(plate.children![0].prefab).toEqual({ def: 'bolt', use: [0, 0] });
  });

  test('a def that is only another def with changes is allowed', () => {
    const spec = parseSpec({
      ...chain,
      defs: {
        ...chain.defs,
        stud: { use: 'bolt', name: 'stud', size: [0.08, 0.08, 0.08] },
      },
      parts: [{ use: 'stud' }],
    } as unknown);
    expect(at(spec, 0).shape).toBe('sphere');
    expect(at(spec, 0).size).toEqual([0.08, 0.08, 0.08]);
  });

  test('a cycle is refused, naming the whole chain', () => {
    expect(() =>
      parseSpec({
        version: 1,
        name: 'Loop',
        kind: 'prop',
        defs: {
          a: { name: 'a', shape: 'box', children: [{ use: 'b' }] },
          b: { name: 'b', shape: 'box', children: [{ use: 'a' }] },
        },
        parts: [{ use: 'a' }],
      }),
    ).toThrow(/Prefab cycle: "a" uses "b" uses "a"/);
  });

  test('a def that uses itself is the same error', () => {
    expect(() =>
      parseSpec({
        version: 1,
        name: 'Self',
        kind: 'prop',
        defs: { a: { name: 'a', shape: 'box', children: [{ use: 'a' }] } },
        parts: [{ use: 'a' }],
      }),
    ).toThrow(/Prefab cycle: "a" uses "a"/);
  });

  test('nesting has a floor, so a typo cannot expand forever', () => {
    const defs: Record<string, unknown> = { d0: { name: 'd0', shape: 'box' } };
    for (let i = 1; i <= MAX_PREFAB_DEPTH + 1; i++)
      defs[`d${i}`] = { name: `d${i}`, shape: 'box', children: [{ use: `d${i - 1}` }] };
    expect(() =>
      parseSpec({
        version: 1,
        name: 'Deep',
        kind: 'prop',
        defs,
        parts: [{ use: `d${MAX_PREFAB_DEPTH + 1}` }],
      }),
    ).toThrow(new RegExp(`Prefabs nest more than ${MAX_PREFAB_DEPTH} deep`));
  });
});

describe('mirror and repeat', () => {
  /**
   * Neither needs a line of prefab code: expansion happens before the builder
   * walks the tree, so a `mirror` or `repeat` written on a use site is a
   * mirror or a repeat on an ordinary part by the time either runs. These
   * tests are here to hold that true, since it is the thing an author will
   * assume and the thing a later change could quietly break.
   */
  const arm: AuthoredSpecInput = {
    version: 1,
    name: 'Mirrored',
    kind: 'person',
    defs: {
      arm: {
        name: 'arm',
        shape: 'capsule',
        size: [0.12, 0.5, 0.12],
        rigPart: 'arm_l',
        children: [
          {
            name: 'glove',
            shape: 'box',
            size: [0.14, 0.14, 0.14],
            position: [0, -0.3, 0],
            rigPart: 'forearm_l',
          },
        ],
      },
    },
    parts: [
      { name: 'torso', shape: 'box', size: [0.4, 0.6, 0.25], position: [0, 1, 0] },
      { use: 'arm', position: [0.3, 1.1, 0], mirror: 'x' },
    ],
  };

  test('a mirrored use reflects the whole subtree and swaps its rig sides', () => {
    const model = buildSpec(arm);
    const bound = new Map<string, number[]>();
    model.traverse((node) => {
      const side = node.userData.rigPart as string | undefined;
      if (side) bound.set(side, node.position.toArray());
    });
    // The def binds to the left. The mirrored copy binds to the right —
    // including the glove hanging off it, which is the part a mirror that only
    // flipped the top of the branch would leave bound to the wrong hand.
    expect([...bound.keys()].sort()).toEqual([
      'arm_l',
      'arm_r',
      'forearm_l',
      'forearm_r',
    ]);
    expect(meshes(model)).toBe(5);
  });

  test('a repeat on a use copies the expanded subtree as a whole', () => {
    const model = buildSpec({
      ...arm,
      parts: [
        arm.parts[0],
        {
          use: 'arm',
          position: [0.3, 1.1, 0],
          repeat: { count: 3, mode: 'linear', offset: [0, -0.2, 0] },
        },
      ],
    } as unknown);
    // Three arms, three gloves: the copy takes the def's children with it.
    expect(meshes(model)).toBe(7);
    const gloves: number[][] = [];
    model.traverse((node) => {
      if (node.name === 'glove') gloves.push(node.position.toArray());
    });
    expect(gloves).toHaveLength(3);
  });

  test('the outliner counts the copies of a use like any other part', () => {
    const spec = parseSpec({
      ...arm,
      parts: [
        arm.parts[0],
        { use: 'arm', mirror: 'x', repeat: { count: 3, mode: 'linear' } },
      ],
    } as unknown);
    expect(copiesOf(at(spec, 1))).toBe(6);
  });
});

describe('editing an expanded spec', () => {
  test('flatten addresses the expanded parts, not the defs', () => {
    const rows = flatten(parseSpec(post));
    expect(rows.map((row) => `${row.path.join('.')} ${row.part.name}`)).toEqual([
      '0 post',
      '0.0 bracket_e',
      '0.0.0 bolt',
      '0.1 bracket_w',
      '0.1.0 bolt',
    ]);
  });

  test('an edit to a use site is written back onto the use site', () => {
    const spec = parseSpec(post);
    const moved = updatePart(spec, [0, 0], { position: [0.4, 0.9, 0] });
    const file = contractPrefabs(moved) as AuthoredSpecInput;
    // One def, two uses, and the nudge on the one that was nudged. Saving the
    // expanded tree instead would have inlined both brackets for good.
    expect(file.defs!.bracket).toEqual(bracket);
    expect((file.parts[0] as { children: unknown[] }).children).toEqual([
      { use: 'bracket', name: 'bracket_e', position: [0.4, 0.9, 0] },
      {
        use: 'bracket',
        name: 'bracket_w',
        position: [-0.18, 0.8, 0],
        rotation: [0, 180, 0],
      },
    ]);
    // And it is the same spec: the round trip is what makes the save honest.
    expect(parseSpec(file)).toEqual(moved);
  });

  test('a child added to one copy is written onto that use site', () => {
    const spec = parseSpec(post);
    const arm = at(spec, 0, 0);
    const lit = updatePart(spec, [0, 0], {
      children: [
        ...arm.children!,
        { name: 'lamp', shape: 'sphere', size: [0.1, 0.1, 0.1] },
      ],
    });
    const file = contractPrefabs(lit) as AuthoredSpecInput;
    const use = (file.parts[0] as { children: { children?: unknown[] }[] })
      .children[0];
    expect(use.children).toEqual([
      { name: 'lamp', shape: 'sphere', size: [0.1, 0.1, 0.1] },
    ]);
    expect(parseSpec(file)).toEqual(lit);
  });

  test('a duplicated copy saves as a second use of the same def', () => {
    const { spec: twice } = duplicatePart(parseSpec(post), [0, 0]);
    const file = contractPrefabs(twice) as AuthoredSpecInput;
    expect((file.parts[0] as { children: { use?: string }[] }).children).toHaveLength(3);
    expect(
      (file.parts[0] as { children: { use?: string; name?: string }[] }).children[1],
    ).toEqual({ use: 'bracket', name: 'bracket_e copy', position: [0.18, 0.8, 0] });
    expect(parseSpec(file)).toEqual(twice);
  });

  test('an edit inside a prefab is refused, naming the def and the use site', () => {
    const spec = parseSpec(post);
    const inside = updatePart(spec, [0, 0, 0], { position: [0.2, 0, 0] });
    expect(() => contractPrefabs(inside)).toThrow(
      /changes "bolt" inside prefab "bracket" \(parts\.0\.children\.0\.children\.0\), not the use site at parts\.0\.children\.0/,
    );
    expect(() => contractPrefabs(inside)).toThrow(/Edit "defs\.bracket"/);
  });

  test('an edit a use site cannot express is refused rather than lost', () => {
    const spec = parseSpec(post);
    const reshaped = updatePart(spec, [0, 0], { detail: 12 });
    expect(() => contractPrefabs(reshaped)).toThrow(
      /"detail" on "bracket_e" \(parts\.0\.children\.0\) differs from prefab "bracket"/,
    );
  });

  test('dropping the mark detaches one copy, which then saves as itself', () => {
    const spec = parseSpec(post);
    const loose = updatePart(spec, [0, 0], { prefab: undefined, detail: 12 });
    const file = contractPrefabs(loose) as AuthoredSpecInput;
    const kept = (file.parts[0] as { children: { shape?: string }[] }).children[0];
    expect(kept.shape).toBe('box');
    expect(parseSpec(file)).toEqual(loose);
  });

  test('a copy whose def was deleted is saved as the part it is', () => {
    const spec = parseSpec(post);
    const orphan = contractPrefabs({ ...spec, defs: {} }) as AuthoredSpecInput;
    const kept = (orphan.parts[0] as { children: { shape?: string }[] }).children[0];
    expect(kept.shape).toBe('box');
  });

  test('a spec with no defs is handed back untouched, object and all', () => {
    const plain = parseSpec({
      version: 1,
      name: 'Plain',
      kind: 'prop',
      parts: [{ shape: 'box', size: [1, 1, 1] }],
    });
    expect(contractSaved(plain)).toBe(plain);
  });
});

describe('a knight’s rivets', () => {
  /** Nine rivets round a pauldron, at nine positions nobody would repeat. */
  const rivets = [...Array(9)].map((_, i) => {
    const angle = (i / 9) * Math.PI * 2;
    return [
      Number((0.22 * Math.cos(angle)).toFixed(4)),
      Number((0.04 * Math.sin(angle * 2)).toFixed(4)),
      Number((0.22 * Math.sin(angle)).toFixed(4)),
    ];
  });
  const rivet = {
    name: 'rivet',
    shape: 'sphere',
    size: [0.05, 0.05, 0.05],
    detail: 5,
    color: '#2f3336',
    material: 'iron',
  };
  const knight = (children: unknown[], defs?: unknown) => ({
    version: 1,
    name: 'Grave Knight',
    kind: 'person',
    seed: 7,
    ...(defs ? { defs } : {}),
    parts: [
      {
        name: 'torso',
        shape: 'box',
        size: [0.44, 0.62, 0.28],
        position: [0, 1.06, 0],
        rigPart: 'spine',
        children: [
          {
            name: 'pauldron',
            shape: 'sphere',
            size: [0.3, 0.26, 0.3],
            position: [0.3, 0.26, 0],
            rigPart: 'arm_l',
            mirror: 'x',
            children,
          },
        ],
      },
    ],
  });

  test('nine rivets from one def build exactly the hand-written model', () => {
    const byHand = knight(rivets.map((position) => ({ ...rivet, position })));
    const byDef = knight(
      rivets.map((position) => ({ use: 'rivet', position })),
      { rivet },
    );
    expect(parseSpec(byDef).parts[0].children![0].children).toHaveLength(9);
    expect(geometry(buildSpec(byDef))).toBe(geometry(buildSpec(byHand)));
    // Mirrored with the pauldron they hang off, both ways.
    expect(meshes(buildSpec(byDef))).toBe(meshes(buildSpec(byHand)));
    expect(meshes(buildSpec(byDef))).toBe(1 + 2 * 10);
  });
});

describe('the schema', () => {
  test('describes defs and use, so an agent can author one', () => {
    const schema = specJSONSchema() as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toContain('defs');
    expect(JSON.stringify(schema)).toContain('"use"');
  });

  test('a validation error names the def and the use site', () => {
    // A bevel that fits the def and not this copy: the numbers only disagree
    // once the override has been applied, which is why the message has to say
    // which copy and which def.
    expect(() =>
      parseSpec({
        version: 1,
        name: 'Bevelled',
        kind: 'prop',
        defs: {
          panel: { name: 'panel', shape: 'box', size: [1, 1, 1], bevel: 0.2 },
        },
        parts: [{ use: 'panel', size: [1, 0.1, 1] }],
      }),
    ).toThrow(/parts\.0\.bevel \(from prefab "panel", used at parts\.0\)/);
  });
});

describe('the worked example', () => {
  const demo = JSON.parse(
    readFileSync('specs/prefab-demo.spec.json', 'utf8'),
  ) as AuthoredSpecInput;

  test('four brackets from one def, and the audit is clean', () => {
    const spec = parseSpec(demo);
    const brackets = spec.parts[0].children!.filter(
      (child) => child.prefab?.def === 'bracket',
    );
    expect(brackets).toHaveLength(4);
    const model = buildSpec(demo);
    expect(meshes(model)).toBe(19);
    const audit = auditModel(model, { scale: spec.scale });
    expect(audit.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  test('saves back as it was written', () => {
    // The defaults the parse filled in stay filled in; the shape of the file —
    // one def and four use sites — is what has to come back.
    const file = contractSaved(parseSpec(demo)) as AuthoredSpecInput;
    expect(file.defs).toEqual(demo.defs);
    expect(file.parts).toEqual(demo.parts);
  });
});
