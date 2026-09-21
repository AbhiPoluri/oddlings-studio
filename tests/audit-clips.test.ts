import '../lib/node-shims';
import { describe, expect, test } from 'vitest';
import { auditClips, withClipFindings } from '../lib/asset-audit-clips';
import { parseSpec, type AssetSpecInput } from '../lib/asset-spec';

/**
 * A pendulum and a block, arranged so the depth is arithmetic rather than a
 * guess.
 *
 * The arm hangs from the pivot at y = 1 and is 0.6 long, so at the top of a
 * 90° swing about z it lies along +x from the pivot and its far end sits at
 * x = 0.6. The block spans x = 0.55 to 0.75, so the arm ends 0.05 m — 50 mm —
 * past its near face, and every other face of the block is further away, so
 * 50 mm is the depth. `drift: 0` keeps the swing in its plane; the default
 * figure-eight would tilt the arm out of the block and make the number a
 * measurement of the wobble instead.
 */
const SWING: AssetSpecInput = {
  version: 1,
  name: 'Clipper',
  kind: 'prop',
  seed: 1,
  scale: 1,
  color: '#8a6a45',
  joints: [
    {
      name: 'Swing',
      at: [0, 1, 0],
      binds: ['arm'],
      spin: {
        axis: 'z',
        mode: 'swing',
        degrees: 90,
        seconds: 2,
        drift: 0,
        phase: 0,
      },
    },
  ],
  parts: [
    { name: 'arm', shape: 'box', size: [0.1, 0.6, 0.1], position: [0, 0.7, 0] },
    { name: 'block', shape: 'box', size: [0.2, 0.2, 0.2], position: [0.65, 1, 0] },
  ],
};

/** The same mechanism with the block moved out of the arc. */
const CLEAR: AssetSpecInput = {
  ...SWING,
  parts: [
    SWING.parts[0],
    { name: 'block', shape: 'box', size: [0.2, 0.2, 0.2], position: [1, 1, 0] },
  ],
};

/** No rig, no clips: nothing to sample. */
const STATIC: AssetSpecInput = {
  version: 1,
  name: 'Still',
  kind: 'prop',
  seed: 1,
  scale: 1,
  color: '#8a6a45',
  parts: [
    { name: 'post', shape: 'box', size: [0.2, 1, 0.2], position: [0, 0.5, 0] },
    { name: 'cap', shape: 'box', size: [0.3, 0.1, 0.3], position: [0, 0.98, 0] },
  ],
};

/**
 * Two joints on one clip, and a trim sunk half its thickness into the board
 * it rides on — the join an author wrote on purpose. The trim has a hinge of
 * its own, so the pair really is measured; it just barely turns against the
 * board, so the 20 mm it starts buried by is not news.
 */
const CHAIN: AssetSpecInput = {
  version: 1,
  name: 'Chained Sign',
  kind: 'prop',
  seed: 3,
  scale: 1,
  color: '#8a6a45',
  joints: [
    {
      name: 'Swing',
      at: [0.3, 1, 0],
      binds: ['board'],
      spin: { axis: 'x', degrees: 20, seconds: 2, drift: 0, clip: 'Swing' },
    },
    {
      name: 'Trim',
      parent: 'Swing',
      at: [0.3, 0.9, 0],
      binds: ['trim'],
      spin: { axis: 'x', degrees: 2, seconds: 2, drift: 0, clip: 'Swing' },
    },
  ],
  parts: [
    { name: 'post', shape: 'box', size: [0.1, 1, 0.1], position: [0, 0.5, 0] },
    {
      name: 'board',
      shape: 'box',
      size: [0.4, 0.3, 0.05],
      position: [0.3, 0.75, 0],
      children: [
        { name: 'trim', shape: 'box', size: [0.44, 0.04, 0.06], position: [0, 0.15, 0] },
      ],
    },
  ],
};

/** A body on the humanoid rig, legs pinned so one bone carries each. */
const FIGURE: AssetSpecInput = {
  version: 1,
  name: 'Stubby',
  kind: 'creature',
  seed: 5,
  scale: 1,
  color: '#93cec8',
  rig: { hipHeight: 0.48, headPivot: 0.9, shoulderWidth: 0.28 },
  parts: [
    {
      name: 'torso',
      shape: 'capsule',
      size: [0.4, 0.5, 0.3],
      position: [0, 0.6, 0],
      rigPart: 'spine',
    },
    {
      name: 'leg-l',
      shape: 'box',
      size: [0.12, 0.34, 0.14],
      position: [0.14, 0.18, 0],
      rigPart: 'thigh_l',
    },
    {
      name: 'leg-r',
      shape: 'box',
      size: [0.12, 0.34, 0.14],
      position: [-0.14, 0.18, 0],
      rigPart: 'thigh_r',
    },
  ],
};

/** A chain of `count` hinges, each carrying a link, for the cost of the thing. */
function linkage(count: number): AssetSpecInput {
  return {
    version: 1,
    name: 'Linkage',
    kind: 'prop',
    seed: 2,
    scale: 1,
    color: '#8a6a45',
    joints: Array.from({ length: count }, (_, i) => ({
      name: `Hinge${i}`,
      ...(i ? { parent: `Hinge${i - 1}` } : {}),
      at: [0, 2 - i * 0.12, 0] as [number, number, number],
      binds: [`link${i}`],
      spin: {
        axis: 'x' as const,
        degrees: 12,
        seconds: 2,
        clip: 'Sway',
        phase: i * 20,
      },
    })),
    parts: [
      { name: 'ground', shape: 'box', size: [1, 0.1, 1], position: [0, 0.05, 0] },
      ...Array.from({ length: count }, (_, i) => ({
        name: `link${i}`,
        shape: 'box' as const,
        size: [0.08, 0.12, 0.08] as [number, number, number],
        position: [0, 2 - i * 0.12 - 0.06, 0] as [number, number, number],
      })),
    ],
  };
}

describe('clip-through', () => {
  test('a swing that drives one part through another reports the depth', () => {
    const { findings, summary } = auditClips(parseSpec(SWING));
    const hit = findings.find((f) => f.code === 'clip-through');
    expect(hit).toBeDefined();
    // 50 mm of interpenetration: past the 25 mm error threshold.
    expect(hit!.severity).toBe('error');
    expect(hit!.value).toBeCloseTo(0.05, 3);
    expect(hit!.message).toMatch(/50 mm/);
    expect(hit!.message).toMatch(/"Swing"/);
    // The swing peaks a quarter of the way through a two second clip, which
    // is frame 3 of 8.
    expect(hit!.message).toMatch(/0\.50s of 2\.00s \(frame 3 of 8\)/);
    expect(hit!.message).toMatch(/arm/);
    expect(hit!.message).toMatch(/block/);
    expect(hit!.hint?.toward).toBeTruthy();
    expect(summary.worst).toBeCloseTo(50, 1);
    expect(summary.frames).toBe(8);
    expect(summary.pairs).toBeGreaterThan(0);
  });

  test('the same mechanism with the block clear of the arc reports nothing', () => {
    const { findings, summary } = auditClips(parseSpec(CLEAR));
    expect(findings).toEqual([]);
    expect(summary.worst).toBe(0);
    expect(summary.clips).toEqual(['Swing']);
  });

  test('a spec with no clips is free', () => {
    const started = performance.now();
    const { findings, summary } = auditClips(parseSpec(STATIC));
    const elapsed = performance.now() - started;
    expect(findings).toEqual([]);
    expect(summary).toEqual({
      clips: [],
      frames: 0,
      pairs: 0,
      samples: 0,
      worst: 0,
      skipped: 0,
      rigid: false,
    });
    // Nothing is built, so this is a few property reads.
    expect(elapsed).toBeLessThan(50);
  });

  test('an overlap the author wrote into the bind pose is not a finding', () => {
    // The trim starts 20 mm inside the board and turns 2° against it. The
    // pair is measured and the samples already buried are passed over, so
    // nothing is raised on a join the author built.
    const { findings, summary } = auditClips(parseSpec(CHAIN));
    expect(findings).toEqual([]);
    expect(summary.rigid).toBe(true);
    expect(summary.pairs).toBeGreaterThan(0);
    expect(summary.worst).toBeLessThan(5);
  });

  test('scale carries the threshold: the same geometry shown small is quiet', () => {
    // 50 mm of model-space overlap at scale 0.05 is 2.5 mm on screen, under
    // the 5 mm the check speaks up at.
    const small = auditClips(parseSpec({ ...SWING, scale: 0.05 }));
    expect(small.findings).toEqual([]);
    expect(small.summary.worst).toBeCloseTo(2.5, 1);
  });

  test('a fused asset gets one note and never a fault', () => {
    // The same 50 mm, but the parts are blended into one shell before
    // anything is skinned, so nobody sees two solids cross.
    const { findings, summary } = auditClips(
      parseSpec({ ...SWING, surface: { blend: 0.02, detail: 32, budget: 400 } }),
    );
    expect(summary.rigid).toBe(false);
    expect(summary.worst).toBeCloseTo(50, 1);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].message).toMatch(/note, not a fault/);
    expect(
      withClipFindings({ ok: true, findings: [] }, parseSpec({
        ...SWING,
        surface: { blend: 0.02, detail: 32, budget: 400 },
      })).ok,
    ).toBe(true);
  });

  test('a character is posed on its own bones and gets a note at most', () => {
    // Legs pinned to the thigh bones, which Walk swings 27° either way: the
    // pair is measured, so the lowercase "thigh_l" really did find the
    // "Thigh_L" bone, and a limb sweeping through a body is never a fault.
    const { findings, summary } = auditClips(parseSpec(FIGURE));
    expect(summary.rigid).toBe(false);
    expect(summary.clips).toContain('Walk');
    expect(summary.pairs).toBeGreaterThan(0);
    expect(findings.length).toBeLessThanOrEqual(1);
    for (const finding of findings) expect(finding.severity).toBe('info');
    expect(withClipFindings({ ok: true, findings: [] }, parseSpec(FIGURE)).ok).toBe(
      true,
    );
  });

  test('the findings ride along with the static audit', () => {
    const audit = withClipFindings(
      { ok: true, findings: [] },
      parseSpec(SWING),
    );
    expect(audit.ok).toBe(false);
    expect(audit.findings.map((f) => f.code)).toContain('clip-through');
    expect(
      withClipFindings({ ok: true, findings: [] }, parseSpec(CLEAR)).ok,
    ).toBe(true);
  });

  test('a thirteen joint mechanism costs under two seconds at eight frames', () => {
    const spec = parseSpec(linkage(13));
    const started = performance.now();
    const { summary } = auditClips(spec, { frames: 8 });
    const elapsed = performance.now() - started;
    expect(summary.frames).toBe(8);
    expect(elapsed).toBeLessThan(2000);
  });
});
