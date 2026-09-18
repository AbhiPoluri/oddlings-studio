import '../lib/node-shims';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Outliner } from '../components/outliner';
import { FindingsPanel } from '../components/findings-panel';
import { Timeline } from '../components/timeline';
import { explain, jsonErrorPlace } from '../components/studio/json-panel';
import { parseSpec, type AssetSpec, type AssetSpecInput } from '../lib/asset-spec';
import type { Audit } from '../lib/asset-audit';
import {
  deletePart,
  diffSpecs,
  flatten,
  jointBindingsByPath,
  pathKey,
  updatePart,
} from '../lib/spec-edit';

/**
 * The panels, rendered as pure functions of their props.
 *
 * `renderToStaticMarkup` rather than a DOM: every claim here is about what the
 * markup says — which rows exist, in what order, at what depth, which one is
 * selected — and none of it needs a browser. Adding jsdom to assert the same
 * strings would buy a slower suite and a second rendering path to keep honest.
 */

/** The shipped specs are the fixtures, so the tests move with the format. */
function fixture(file: string): AssetSpec {
  return parseSpec(JSON.parse(readFileSync(`specs/${file}`, 'utf8')));
}

const noop = () => {};

/** Every `<button>` opening tag, as attribute maps, in document order. */
function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>/g)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const [, key, value] of match[1].matchAll(
      /([a-zA-Z-]+)(?:="([^"]*)")?/g,
    ))
      if (key) attributes[key] = value ?? '';
    return attributes;
  });
}

/** One row's inner markup, so a badge can be looked for inside its own row. */
function row(html: string, attribute: string, value: string) {
  const found = new RegExp(
    `<button[^>]*${attribute}="${value}"[^>]*>(.*?)</button>`,
    's',
  ).exec(html);
  if (!found) throw Error(`No row with ${attribute}="${value}".`);
  return found[1];
}

const wizard = fixture('wizard.spec.json');
/** A Swing → Tire joint chain over a repeated, nested part tree. */
const swing = fixture('tire-swing-tree-leafy.spec.json');

describe('Outliner', () => {
  test('renders every flattened part, in order, at its own depth', () => {
    for (const spec of [wizard, swing]) {
      const html = renderToStaticMarkup(
        h(Outliner, { spec, selected: null, onSelect: noop }),
      );
      const rows = buttons(html).filter((attributes) => 'data-path' in attributes);
      const expected = flatten(spec);
      expect(rows.map((attributes) => attributes['data-path'])).toEqual(
        expected.map((part) => pathKey(part.path)),
      );
      expect(rows.map((attributes) => attributes['data-depth'])).toEqual(
        expected.map((part) => String(part.depth)),
      );
      expect(rows.map((attributes) => attributes['aria-level'])).toEqual(
        expected.map((part) => String(part.depth + 1)),
      );
    }
    // The nested fixture is the one that makes the depth claim worth making.
    expect(flatten(swing).some((part) => part.depth === 1)).toBe(true);
  });

  test('marks exactly the selected row aria-selected', () => {
    const html = renderToStaticMarkup(
      h(Outliner, {
        spec: swing,
        selected: { kind: 'part', path: [11, 1] },
        onSelect: noop,
      }),
    );
    const chosen = buttons(html).filter(
      (attributes) => attributes['aria-selected'] === 'true',
    );
    expect(chosen.map((attributes) => attributes['data-path'])).toEqual(['11.1']);
    // Roving tabindex: the selected row is the tree's only tab stop.
    expect(chosen[0].tabindex).toBe('0');
  });

  test('badges copy counts, rig parts and the joint carrying a part', () => {
    const html = renderToStaticMarkup(
      h(Outliner, { spec: swing, selected: null, onSelect: noop }),
    );
    // `root` repeats six times radially; `rope` and `tire` hang off a joint each.
    expect(row(html, 'data-path', '0')).toContain('×6');
    expect(row(html, 'data-path', '9')).toContain('Swing');
    expect(row(html, 'data-path', '10')).toContain('Tire');
    expect(row(html, 'data-path', '1')).not.toContain('Swing');

    const rigged = renderToStaticMarkup(
      h(Outliner, { spec: wizard, selected: null, onSelect: noop }),
    );
    // `boot` is mirrored, so one authored part builds two meshes.
    expect(row(rigged, 'data-path', '0')).toContain('×2');
    expect(row(rigged, 'data-path', '0')).toContain('foot_l');
  });

  test('hides rows that do not match the filter', () => {
    const html = renderToStaticMarkup(
      h(Outliner, {
        spec: wizard,
        selected: null,
        onSelect: noop,
        filter: 'boot',
      }),
    );
    const paths = buttons(html)
      .filter((attributes) => 'data-path' in attributes)
      .map((attributes) => attributes['data-path']);
    expect(paths).toEqual(['0', '1']);
    expect(html).toContain('boot-cuff');
    expect(html).not.toContain('spellbook');
  });

  test('says so when the filter matches nothing', () => {
    const html = renderToStaticMarkup(
      h(Outliner, {
        spec: wizard,
        selected: null,
        onSelect: noop,
        filter: 'zzz',
      }),
    );
    expect(buttons(html).filter((a) => 'data-path' in a)).toEqual([]);
    expect(html).toContain('No part matches');
  });

  test('lists the skeleton under the parts, indented by its parent chain', () => {
    const html = renderToStaticMarkup(
      h(Outliner, {
        spec: swing,
        selected: { kind: 'bone', name: 'Tire' },
        onSelect: noop,
        bones: true,
      }),
    );
    const bones = buttons(html).filter((attributes) => 'data-bone' in attributes);
    expect(bones.map((attributes) => attributes['data-bone'])).toEqual([
      'Root',
      'Swing',
      'Tire',
    ]);
    // Tire hangs off Swing, which hangs off Root — depth is walked, not counted.
    expect(bones.map((attributes) => attributes['data-depth'])).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(
      bones.find((attributes) => attributes['data-bone'] === 'Tire')?.[
        'aria-selected'
      ],
    ).toBe('true');
  });

  /**
   * The outliner is rendered twice: once by the shell's own column, and once
   * inside the property panel, which passes none of the handlers below. The
   * row menu is gated on those handlers so the embedded copy keeps the markup
   * every other test in this file asserts against.
   */
  test('grows a row menu only for the tree the shell wires up', () => {
    const props = { spec: swing, selected: null, onSelect: noop, bones: true };
    const plain = renderToStaticMarkup(h(Outliner, props));
    expect(plain).not.toContain('context-menu');

    const wired = renderToStaticMarkup(
      h(Outliner, { ...props, onFrame: noop, onIsolate: noop, onRename: noop }),
    );
    expect(wired).toContain('data-slot="context-menu-trigger"');
    // And the rows themselves are the same rows, in the same order.
    const paths = (html: string) =>
      buttons(html)
        .filter((attributes) => 'data-path' in attributes)
        .map((attributes) => attributes['data-path']);
    expect(paths(wired)).toEqual(paths(plain));
  });

  test('marks the rows a diff calls changed', () => {
    const html = renderToStaticMarkup(
      h(Outliner, {
        spec: swing,
        selected: null,
        onSelect: noop,
        changed: new Set(['1', '11.0']),
      }),
    );
    const marked = buttons(html)
      .filter((attributes) => attributes['data-changed'] === 'true')
      .map((attributes) => attributes['data-path']);
    expect(marked).toEqual(['1', '11.0']);
  });
});

/**
 * The JSON tab has to say *where* a syntax error is, and no two engines say it
 * the same way — which is why the panel counts the newlines itself rather than
 * trusting whatever shape the message arrived in.
 */
describe('locating a JSON syntax error', () => {
  const text = '{\n  "name": "A",\n  "kind": prop\n}';

  test('reads a line and column the engine gave outright', () => {
    expect(
      jsonErrorPlace('Unexpected token p in JSON at line 3 column 11', text),
    ).toEqual({ line: 3, column: 11 });
  });

  test('counts them from a bare position, which is all older engines give', () => {
    const at = text.indexOf('prop');
    expect(jsonErrorPlace(`Unexpected token p in JSON at position ${at}`, text)).toEqual({
      line: 3,
      column: 11,
    });
  });

  test('finds it in the quoted snippet current V8 gives instead', () => {
    expect(
      jsonErrorPlace(
        `Unexpected token 'p', ..."  "kind": prop\n}" is not valid JSON`,
        text,
      ),
    ).toEqual({ line: 3, column: 11 });
  });

  test('says nothing rather than guessing when there is no place to read', () => {
    expect(jsonErrorPlace('Unexpected end of JSON input', text)).toBeNull();
    // A snippet that is not in this text says nothing either.
    expect(
      jsonErrorPlace(`Unexpected token 'x', "nowhere" is not valid JSON`, text),
    ).toBeNull();
  });

  test('a real parse failure comes back with the line in front', () => {
    let thrown: unknown;
    try {
      JSON.parse(text);
    } catch (error) {
      thrown = error;
    }
    const message = explain(thrown, text);
    expect(message).toMatch(/^Line 3, column 11: /);
    // The raw offset and the echoed source are noise once the line is known —
    // and the snippet carries newlines, which would wrap this over three rows.
    expect(message).not.toMatch(/position \d+/);
    expect(message).not.toContain('\n');
    expect(message).not.toContain('is not valid JSON');
  });

  test('a schema error is passed through as the parser wrote it', () => {
    const message = explain(Error('Invalid asset spec at parts: too small'), '{}');
    expect(message).toBe('Invalid asset spec at parts: too small');
  });
});

const findings: Audit = {
  ok: false,
  findings: [
    {
      severity: 'error',
      code: 'detached-part',
      message: 'leaf-core floats 0.4 m from anything else.',
      part: [11, 0],
    },
    {
      severity: 'warn',
      code: 'thin-part',
      message: 'rope is thinner than the export tolerance.',
      part: [9],
    },
    {
      severity: 'info',
      code: 'triangles',
      message: 'This asset is 12,400 triangles.',
    },
  ],
};

describe('FindingsPanel', () => {
  test('groups by severity and names the part a finding is about', () => {
    const html = renderToStaticMarkup(
      h(FindingsPanel, {
        audit: findings,
        labels: new Map([
          ['11.0', 'leaf-core'],
          ['9', 'rope'],
        ]),
        onSelectPart: noop,
      }),
    );
    expect(html).toContain('1 error · 1 warning · 1 note');
    expect(html.indexOf('Errors')).toBeLessThan(html.indexOf('Warnings'));
    expect(html.indexOf('Warnings')).toBeLessThan(html.indexOf('Notes'));
    expect(row(html, 'data-code', 'detached-part')).toContain('leaf-core');
    expect(row(html, 'data-code', 'thin-part')).toContain('rope');
    // A finding with no part has nothing to select, so its row is inert.
    expect(
      buttons(html).find((a) => a['data-code'] === 'triangles'),
    ).toHaveProperty('disabled');
  });

  test('leads with "passes" when nothing is an error', () => {
    const html = renderToStaticMarkup(
      h(FindingsPanel, {
        audit: {
          ok: true,
          findings: [
            { severity: 'warn', code: 'a', message: 'one' },
            { severity: 'warn', code: 'b', message: 'two' },
          ],
        },
      }),
    );
    expect(html).toContain('passes · 2 warnings');
  });

  test('says there is nothing to check without a spec', () => {
    const html = renderToStaticMarkup(h(FindingsPanel, { audit: null }));
    expect(html).toContain('Nothing to check yet');
  });
});

describe('Timeline', () => {
  const clips = [
    { name: 'Swing', duration: 3.2 },
    { name: 'Idle', duration: 1 },
  ];

  test('reads the time out against the current clip length', () => {
    const html = renderToStaticMarkup(
      h(Timeline, {
        clips,
        current: 'Swing',
        playing: true,
        time: 1.234,
        speed: 1,
        onClip: noop,
        onPlaying: noop,
        onTime: noop,
        onSpeed: noop,
      }),
    );
    expect(html).toContain('1.23 / 3.20 s');
    expect(html).toContain('Bind pose');
    expect(html).toContain('max="3.2"');
    expect(html).not.toMatch(/<input[^>]*type="range"[^>]*disabled/);
  });

  test('disables the scrubber on the bind pose, which has no length', () => {
    const html = renderToStaticMarkup(
      h(Timeline, {
        clips,
        current: 'Bind pose',
        playing: false,
        time: 0,
        speed: 0.5,
        onClip: noop,
        onPlaying: noop,
        onTime: noop,
        onSpeed: noop,
      }),
    );
    expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled/);
    expect(html).toContain('0.00 / 0.00 s');
  });
});

const source: AssetSpecInput = {
  version: 1,
  name: 'Bound',
  kind: 'prop',
  parts: [
    {
      name: 'body',
      shape: 'box',
      size: [1, 1, 1],
      children: [{ name: 'knob', shape: 'sphere', size: [0.2, 0.2, 0.2] }],
    },
    { name: 'base', shape: 'cylinder', size: [1, 0.2, 1] },
  ],
  joints: [{ name: 'Hinge', at: [0, 0.5, 0], binds: ['body'] }],
};

describe('jointBindingsByPath', () => {
  test('answers the shipped chain, and only for bound rows', () => {
    const bound = jointBindingsByPath(swing);
    expect(bound.get('9')).toBe('Swing');
    expect(bound.get('10')).toBe('Tire');
    expect(bound.has('0')).toBe(false);
  });

  test('children inherit the binding, and the deeper bind wins', () => {
    const spec = parseSpec(source);
    expect(jointBindingsByPath(spec).get('0.0')).toBe('Hinge');
    const deeper = parseSpec({
      ...source,
      joints: [
        { name: 'Hinge', at: [0, 0.5, 0], binds: ['body'] },
        { name: 'Knuckle', at: [0, 0.8, 0], binds: ['knob'] },
      ],
    });
    expect(jointBindingsByPath(deeper).get('0')).toBe('Hinge');
    expect(jointBindingsByPath(deeper).get('0.0')).toBe('Knuckle');
  });

  test('skips a bind that names nothing rather than throwing', () => {
    // `jointBinder` refuses this spec at build time; a panel still has to draw
    // it, because this is what a half-typed bind looks like.
    const spec = parseSpec(source);
    const broken = { ...spec, joints: [{ ...spec.joints![0], binds: ['ghost'] }] };
    expect(jointBindingsByPath(broken as AssetSpec).size).toBe(0);
  });

  test('is empty for a spec with no joints', () => {
    expect(jointBindingsByPath(wizard).size).toBe(0);
  });
});

describe('diffSpecs', () => {
  const spec = parseSpec(source);

  test('reports nothing between a spec and itself', () => {
    const diff = diffSpecs(spec, parseSpec(source));
    expect([...diff.added, ...diff.removed, ...diff.changed]).toEqual([]);
  });

  test('marks only the row that changed, not the branch above it', () => {
    const diff = diffSpecs(spec, updatePart(spec, [0, 0], { name: 'dial' }));
    expect([...diff.changed]).toEqual(['0.0']);
    expect(diff.added.size + diff.removed.size).toBe(0);
  });

  test('a patch that restates a value is not a change', () => {
    const same = updatePart(spec, [0], { size: [1, 1, 1] });
    expect([...diffSpecs(spec, same).changed]).toEqual([]);
  });

  test('reports a removed row by its path key', () => {
    const diff = diffSpecs(spec, deletePart(spec, [1]));
    expect([...diff.removed]).toEqual(['1']);
    expect(diff.added.size + diff.changed.size).toBe(0);
  });

  test('reports an added row by its path key', () => {
    const grown = updatePart(spec, [1], {
      children: [{ name: 'foot', shape: 'box', size: [0.2, 0.2, 0.2] }],
    });
    const diff = diffSpecs(spec, grown);
    expect([...diff.added]).toEqual(['1.0']);
    // The parent gained a child and nothing else, so it is not itself changed.
    expect([...diff.changed]).toEqual([]);
  });
});
