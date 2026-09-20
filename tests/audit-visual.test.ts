import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import { auditVisual } from '../lib/asset-audit-visual';
import { auditModel } from '../lib/asset-audit';
import { buildSpec, parseSpec, type AssetSpecInput } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';

beforeAll(async () => {
  await readySurface();
});

const base = { version: 1 as const, name: 'Pair', kind: 'prop' as const };

/** Two cubes shoulder to shoulder. Only the right one's colour changes. */
function pair(right: string): AssetSpecInput {
  return {
    ...base,
    parts: [
      {
        name: 'left',
        shape: 'box',
        size: [1, 1, 1],
        position: [-0.5, 0.5, 0],
        color: '#c03028',
      },
      {
        name: 'right',
        shape: 'box',
        size: [1, 1, 1],
        position: [0.5, 0.5, 0],
        color: right,
      },
    ],
  };
}

function visual(spec: AssetSpecInput, size = 256) {
  const parsed = parseSpec(spec);
  return auditVisual(buildSpec(parsed), parsed, { size });
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('contrast between touching parts', () => {
  test('red beside the same red reads as one shape', () => {
    const report = visual(pair('#c03028'));
    const low = report.findings.filter((f) => f.code === 'low-contrast');
    expect(low).toHaveLength(1);
    expect(low[0].severity).toBe('warn');
    expect(low[0].message).toContain('"left"');
    expect(low[0].message).toContain('"right"');
    expect(low[0].message).toContain('read as one shape');
    // The number behind the warning, not just the sentence.
    expect(low[0].value).toBeLessThan(2);
  });

  test('red beside blue does not', () => {
    const report = visual(pair('#2040c0'));
    expect(codes(report.findings)).not.toContain('low-contrast');
    // The pair is still measured — it is the distance that clears it.
    const measured = report.contrast.find(
      (row) =>
        (row.a === 'left' && row.b === 'right') ||
        (row.a === 'right' && row.b === 'left'),
    );
    expect(measured).toBeTruthy();
    expect(measured!.distance).toBeGreaterThan(20);
  });

  test('a border shorter than the floor is beneath notice', () => {
    // A corner grazing another part shares a handful of pixels with it, and a
    // warning about a handful of pixels teaches a reader to skim the report.
    const spec = parseSpec(pair('#c03028'));
    const model = buildSpec(spec);
    const shared = Math.max(
      ...auditVisual(model, spec, { size: 256 }).contrast.map((row) => row.border),
    );
    expect(
      codes(
        auditVisual(model, spec, { size: 256, minBorder: shared + 1 }).findings,
      ),
    ).not.toContain('low-contrast');
    expect(
      codes(auditVisual(model, spec, { size: 256, minBorder: 4 }).findings),
    ).toContain('low-contrast');
  });
});

describe('unseen triangles', () => {
  test('a part sealed inside another owns no pixel from any angle', () => {
    const report = visual({
      ...base,
      name: 'Nested',
      parts: [
        { name: 'shell', shape: 'box', size: [2, 2, 2], position: [0, 1, 0], color: '#9aa0a6' },
        { name: 'core', shape: 'box', size: [0.5, 0.5, 0.5], position: [0, 1, 0], color: '#c03028' },
      ],
    });
    const worst = report.unseen.parts[0];
    expect(worst.part).toBe('core');
    expect(worst.share).toBe(1);
    expect(worst.triangles).toBeGreaterThan(0);
    const finding = report.findings.find((f) => f.code === 'unseen-triangles');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('"core"');
    expect(finding?.message).toContain('entirely inside something else');
  });

  test('a bare box wastes nothing, because six views see six faces', () => {
    const report = visual({
      ...base,
      name: 'Solo',
      parts: [{ name: 'body', shape: 'box', size: [1, 1, 1], position: [0, 0.5, 0], color: '#c03028' }],
    });
    // The measure would be useless if the far side of every solid counted as
    // waste, so this is the test that keeps it honest.
    expect(report.unseen.triangles).toBe(0);
    expect(report.unseen.share).toBe(0);
  });
});

describe('silhouette', () => {
  test('is reported as a number a view, and never as a complaint', () => {
    const report = visual(pair('#2040c0'));
    expect(report.silhouette).toHaveLength(report.views.length);
    for (const reading of report.silhouette) {
      expect(reading.fill).toBeGreaterThan(0);
      expect(reading.fill).toBeLessThanOrEqual(1);
    }
    const finding = report.findings.find((f) => f.code === 'silhouette');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('front');
    // No warning hides in here about the model being small in its frame.
    expect(
      report.findings.filter((f) => f.severity === 'error'),
    ).toHaveLength(0);
    expect(finding?.message).not.toContain('small in frame');
  });
});

describe('the audit hook', () => {
  test('auditModel stays silent about pixels unless asked', () => {
    const spec = parseSpec(pair('#c03028'));
    const model = buildSpec(spec);
    const plain = auditModel(model, { scale: spec.scale });
    expect(codes(plain.findings)).not.toContain('low-contrast');
    expect(codes(plain.findings)).not.toContain('silhouette');

    const seen = auditModel(model, { scale: spec.scale, visual: true });
    expect(codes(seen.findings)).toContain('low-contrast');
    expect(codes(seen.findings)).toContain('silhouette');
    expect(codes(seen.findings)).toContain('unseen-triangles');
    // Nothing a picture shows is an error, so a clean asset stays clean.
    expect(seen.ok).toBe(plain.ok);
  });

  test('the options ride through, so a caller can pick the angles', () => {
    const spec = parseSpec(pair('#c03028'));
    const seen = auditModel(buildSpec(spec), {
      visual: { size: 128, views: ['top'] },
    });
    const finding = seen.findings.find((f) => f.code === 'silhouette');
    expect(finding?.message).toContain('top');
    expect(finding?.message).not.toContain('three-quarter');
  });
});
