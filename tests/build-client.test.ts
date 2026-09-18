import '../lib/node-shims';
import { beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import * as T from 'three';
import { buildSpec, parseSpec, type AssetSpec } from '../lib/asset-spec';
import { readySurface } from '../lib/asset-surface';
import { auditModel } from '../lib/asset-audit';
import { stats } from '../lib/asset-build';
import { flatten } from '../lib/spec-edit';
import {
  deserializeModel,
  serializeModel,
  transfersOf,
} from '../lib/build-serial';

/**
 * The worker hands models back as plain data. Everything downstream — the
 * viewport, the audit, the stats chip, the exporters — then treats that data
 * as if the builder had produced it here, so the round trip has to be lossless
 * in every field any of them reads.
 *
 * Node has no `Worker` and no structured clone across threads, and neither is
 * what could break: the loss would be in the writing down. So this exercises
 * `serializeModel` and `deserializeModel` directly, which is also the only way
 * to compare against the model that went in.
 */

beforeAll(async () => {
  await readySurface();
});

function fixture(file: string): AssetSpec {
  return parseSpec(JSON.parse(readFileSync(`specs/${file}`, 'utf8')));
}

/** Coarse enough to run in a test, detailed enough to be a real surface. */
function preview(spec: AssetSpec): AssetSpec {
  return spec.surface
    ? { ...spec, surface: { ...spec.surface, detail: 64, budget: 4000 } }
    : spec;
}

type Node_ = {
  kind: string;
  name: string;
  transform: number[];
  userData: string;
  attributes?: [string, number[]][];
  index?: number[];
  material?: string;
  bones?: string[];
  bindMatrix?: number[];
  boneInverses?: number[];
  children: Node_[];
};

/** Everything about a model that anything downstream can observe. */
function describeModel(root: T.Object3D): Node_ {
  const write = (object: T.Object3D): Node_ => {
    const node: Node_ = {
      kind: object.constructor.name,
      name: object.name,
      transform: [
        ...object.position.toArray(),
        ...object.quaternion.toArray(),
        ...object.scale.toArray(),
      ],
      userData: JSON.stringify(object.userData),
      children: object.children.map(write),
    };
    if (object instanceof T.Mesh) {
      const geometry = object.geometry as T.BufferGeometry;
      node.attributes = Object.entries(geometry.attributes)
        .map(
          ([name, attribute]) =>
            [name, Array.from((attribute as T.BufferAttribute).array)] as [
              string,
              number[],
            ],
        )
        .sort((a, b) => a[0].localeCompare(b[0]));
      node.index = geometry.index
        ? Array.from((geometry.index as T.BufferAttribute).array)
        : undefined;
      const material = object.material as T.MeshStandardMaterial;
      node.material = [
        material.name,
        material.color.getHexString(),
        material.flatShading,
        material.vertexColors,
        material.opacity,
        material.roughness,
      ].join('|');
    }
    if (object instanceof T.SkinnedMesh) {
      node.bones = object.skeleton.bones.map((bone) => bone.name);
      node.bindMatrix = [...object.bindMatrix.elements];
      node.boneInverses = object.skeleton.boneInverses.flatMap((matrix) => [
        ...matrix.elements,
      ]);
    }
    return node;
  };
  return write(root);
}

describe('a built model survives the trip through the worker', () => {
  const cases: [string, string][] = [
    ['wizard (surface, character rig)', 'wizard.spec.json'],
    ['octopod walker (surface, joints)', 'octopod-walker.spec.json'],
    ['sniper rifle (faceted, joints)', 'sniper-rifle.spec.json'],
  ];

  test.each(cases)('%s', (_label, file) => {
    const spec = preview(fixture(file));
    const direct = buildSpec(spec, { uv: false });
    const copied = deserializeModel(serializeModel(buildSpec(spec, { uv: false })));
    expect(describeModel(copied)).toStrictEqual(describeModel(direct));
  });

  test('keeps the counts the view bar reports', () => {
    for (const [, file] of cases) {
      const spec = preview(fixture(file));
      const direct = buildSpec(spec, { uv: false });
      const copied = deserializeModel(serializeModel(buildSpec(spec, { uv: false })));
      // Materials in particular: the faceted builder shares one per colour, and
      // a round trip that made a fresh material per mesh would quietly inflate
      // this without changing a pixel.
      expect(stats(copied)).toStrictEqual(stats(direct));
    }
  });

  test('keeps the findings the panel lists', () => {
    for (const [, file] of cases) {
      const spec = preview(fixture(file));
      const options = {
        rigged: Boolean(spec.rig),
        scale: spec.scale,
        labels: new Map(
          flatten(spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
      };
      const direct = auditModel(buildSpec(spec, { uv: false }), options);
      const copied = auditModel(
        deserializeModel(serializeModel(buildSpec(spec, { uv: false }))),
        options,
      );
      expect(copied).toStrictEqual(direct);
    }
  });

  test('keeps the skin weights pointing at the same bones', () => {
    const spec = preview(fixture('wizard.spec.json'));
    const copied = deserializeModel(serializeModel(buildSpec(spec, { uv: false })));
    let skinned: T.SkinnedMesh | null = null;
    copied.traverse((o) => {
      if (o instanceof T.SkinnedMesh) skinned = o;
    });
    expect(skinned).toBeTruthy();
    const mesh = skinned as unknown as T.SkinnedMesh;
    expect(mesh.skeleton.bones.length).toBeGreaterThan(1);
    // A bone list that came back as loose objects rather than as nodes of the
    // tree would still have the right names and pose the model at the origin.
    for (const bone of mesh.skeleton.bones) {
      let attached = false;
      copied.traverse((o) => {
        if (o === bone) attached = true;
      });
      expect(attached).toBe(true);
    }
    const index = mesh.geometry.attributes.skinIndex as T.BufferAttribute;
    const weight = mesh.geometry.attributes.skinWeight as T.BufferAttribute;
    expect(index.count).toBe(
      (mesh.geometry.attributes.position as T.BufferAttribute).count,
    );
    expect(weight.count).toBe(index.count);
  });

  test('hands its buffers over rather than copying them', () => {
    const serial = serializeModel(buildSpec(preview(fixture('wizard.spec.json')), {
      uv: false,
    }));
    const transfers = transfersOf(serial);
    expect(transfers.length).toBeGreaterThan(0);
    // No buffer twice: a transfer list with a duplicate throws in the browser.
    expect(new Set(transfers).size).toBe(transfers.length);
  });
});
