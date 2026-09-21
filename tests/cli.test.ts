import '../lib/node-shims';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditModel } from '../lib/asset-audit';
import { buildSpec, parseSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { flatten } from '../lib/spec-edit';
import { specTemplate, TEMPLATE_KINDS } from '../mcp/spec-guide';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'oddlings-cli-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

beforeAll(async () => {
  await readySurface();
});

/**
 * Run the CLI the way a user does, as a separate process.
 *
 * The local `tsx` rather than `npx tsx`: same interpreter, without a registry
 * lookup in the middle of a test. The child inherits VITEST, so it will not
 * touch the studio's preview pointer or the build history.
 */
function oddlings(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(
        join(root, 'node_modules/.bin/tsx'),
        [join(root, 'cli/oddlings.ts'), ...args],
        { cwd: root },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }));
    },
  );
}

describe('oddlings new', () => {
  test('prints a spec that audits clean, through the real CLI', async () => {
    const made = await oddlings(['new', 'prop', '--name', 'Spawned Lamp']);
    expect(made.code).toBe(0);
    const spec = JSON.parse(made.stdout);
    expect(spec.name).toBe('Spawned Lamp');

    const path = join(scratch, 'spawned.spec.json');
    await writeFile(path, made.stdout);
    const audited = await oddlings(['audit', path]);
    // `audit` exits non-zero on any error finding, so a zero exit is the
    // whole assertion: the template a fresh author starts from is valid.
    expect(audited.stderr).toBe('');
    expect(audited.code).toBe(0);
    expect(audited.stdout).toContain('passes');
  }, 60000);

  test('an unknown kind is refused by name', async () => {
    const made = await oddlings(['new', 'spaceship']);
    expect(made.code).toBe(1);
    expect(made.stderr).toContain('mechanism');
  }, 60000);

  test('every template audits clean and carries its conventions', async () => {
    for (const kind of TEMPLATE_KINDS) {
      const spec = parseSpec(specTemplate(kind));
      const audit = auditModel(buildSpec(spec), {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      });
      expect(audit.findings.filter((f) => f.severity !== 'info')).toEqual([]);
      expect(audit.ok, `${kind} template`).toBe(true);
      // Every part is named, because a measurement or a note that says
      // "box" instead of "hat" is no use to anyone.
      for (const row of flatten(spec)) expect(row.part.name).toBeTruthy();
    }
  }, 60000);

  test('characters carry a surface block and pin every bone', () => {
    for (const kind of ['creature', 'person'] as const) {
      const spec = parseSpec(specTemplate(kind));
      expect(spec.surface).toBeDefined();
      expect(spec.rig).toBeDefined();
      for (const row of flatten(spec)) expect(row.part.rigPart).toBeTruthy();
    }
  });

  test('the quadruped starter audits clean through the real CLI', async () => {
    const made = await oddlings(['new', 'creature', '--rig', 'quadruped']);
    expect(made.code).toBe(0);
    const spec = parseSpec(JSON.parse(made.stdout));
    expect(spec.rig?.kind).toBe('quadruped');
    // Every part pinned, like the humanoid templates: a starter is also the
    // worked example of how to pin the bones this rig has.
    for (const row of flatten(spec)) expect(row.part.rigPart).toBeTruthy();

    const path = join(scratch, 'beast.spec.json');
    await writeFile(path, made.stdout);
    const audited = await oddlings(['audit', path]);
    expect(audited.stderr).toBe('');
    expect(audited.code).toBe(0);
    expect(audited.stdout).toContain('passes');
  }, 120000);

  test('--rig quadruped is a creature rig, and says so elsewhere', async () => {
    const made = await oddlings(['new', 'prop', '--rig', 'quadruped']);
    expect(made.code).toBe(1);
    expect(made.stderr).toContain('creature rig');
  }, 60000);

  test('the mechanism is a prop with a real joint chain', () => {
    const spec = parseSpec(specTemplate('mechanism'));
    expect(spec.kind).toBe('prop');
    expect(spec.joints).toHaveLength(2);
    // A chain, in one clip, with a lag: the three things a row of independent
    // pivots gets wrong.
    expect(spec.joints![1].parent).toBe(spec.joints![0].name);
    expect(spec.joints![1].spin?.clip).toBe(spec.joints![0].spin?.clip);
    expect(spec.joints![1].spin?.phase).not.toBe(0);
  });
});

describe('oddlings measure', () => {
  test('--json parses, and names the same parts the spec does', async () => {
    const result = await oddlings([
      'measure',
      'specs/sniper-rifle.spec.json',
      '--parts',
      'receiver,barrel',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.name).toBe('Sniper Rifle');
    expect(report.mode).toBe('faceted');
    expect(report.sampling.measuredParts).toBe(2);
    const receiver = report.parts.find(
      (part: { name: string }) => part.name === 'receiver',
    );
    expect(receiver.nearest).toBeTruthy();
    expect(typeof receiver.nearest.gap).toBe('number');
  }, 60000);

  test('the table prints a row per part and the skeleton', async () => {
    const result = await oddlings(['measure', 'specs/sniper-rifle.spec.json']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Sniper Rifle');
    expect(result.stdout).toContain('receiver');
    expect(result.stdout).toContain('skeleton');
    expect(result.stdout).toContain('samples per mesh');
  }, 60000);
});

describe('oddlings notes', () => {
  test('an audit ends by naming the open notes, and resolving clears them', async () => {
    const spec = join(scratch, 'noted.spec.json');
    await writeFile(spec, JSON.stringify(specTemplate('prop', 'Noted Lamp')));
    await writeFile(
      join(scratch, 'noted.review.json'),
      JSON.stringify({
        version: 1,
        spec,
        notes: [
          {
            id: 'n7',
            part: [3],
            partName: 'cap',
            text: 'the cap reads flat from the side',
            status: 'open',
            by: 'human',
            at: '2026-09-18T10:00:00.000Z',
            resolvedAt: null,
            reply: null,
          },
        ],
      }),
    );

    const audited = await oddlings(['audit', spec]);
    expect(audited.code).toBe(0);
    expect(audited.stdout).toContain('1 open review note');

    const asJson = await oddlings(['audit', spec, '--json']);
    const payload = JSON.parse(asJson.stdout);
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.reviewNotes).toHaveLength(1);
    expect(payload.reviewNotes[0].id).toBe('n7');

    const closed = await oddlings([
      'notes',
      spec,
      '--resolve',
      'n7',
      '--reply',
      'steepened the cone',
    ]);
    expect(closed.code).toBe(0);
    expect(closed.stdout).toContain('No open notes');

    const after = await oddlings(['audit', spec]);
    expect(after.stdout).not.toContain('open review note');
  }, 90000);
});
