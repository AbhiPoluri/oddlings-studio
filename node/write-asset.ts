import '../lib/node-shims';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as T from 'three';
import { zipSync, strToU8 } from 'fflate';
import { buildAsset, objBundle, stats } from '../lib/asset-build';
import { toGLB, clipsFor, unityReadme } from '../lib/asset-bundle';
import { buildSpec, type AssetSpec } from '../lib/asset-spec';
import { auditModel, type Audit } from '../lib/asset-audit';
import { readySurface } from '../lib/asset-surface';
import { splitUvSeams } from '../lib/asset-uv';
import { bakeSurface } from '../lib/asset-bake';
import { encodePng } from '../lib/asset-png';
import { markActive } from './active-spec';
import { flatten } from '../lib/spec-edit';
import { specClips } from '../lib/asset-joints';
import { disposeScene } from '../lib/three-world';
import { fileName, type Recipe } from '../lib/asset-recipe';

export const FORMATS = ['glb', 'obj', 'unity', 'json'] as const;
export type Format = (typeof FORMATS)[number];

export type WriteResult = {
  name: string;
  files: string[];
  stats: ReturnType<typeof stats>;
  /** Geometry checks on what was actually built. See lib/asset-audit.ts. */
  audit: Audit;
};

async function put(path: string, data: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

/**
 * Write one asset to disk in the requested formats.
 *
 * `source` is either a recipe (blueprint-driven) or a spec (authored from
 * scratch). Both funnel through the same geometry, rig and export path, so the
 * files are indistinguishable downstream.
 */
export async function writeAsset(
  source: { recipe: Recipe } | { spec: AssetSpec },
  options: {
    outDir: string;
    formats?: Format[];
    /**
     * The file this was authored in, for the build history.
     *
     * Only the caller knows it: by the time a spec reaches here it is an
     * object, and the exported `.spec.json` beside the model is a copy, not
     * the file an agent is editing. Without this the history would point every
     * build at its own output.
     */
    source?: string;
  },
): Promise<WriteResult> {
  // Surface mode re-meshes through a WebAssembly decimator; load it before
  // any building starts so the synchronous builder never has to wait.
  await readySurface();
  const formats = options.formats?.length ? options.formats : (['glb'] as Format[]);
  const isRecipe = 'recipe' in source;
  const name = isRecipe ? source.recipe.name : source.spec.name;
  const base = fileName(name);
  const outDir = resolve(options.outDir);

  const model = isRecipe ? buildAsset(source.recipe) : buildSpec(source.spec);
  const clips = isRecipe ? clipsFor(source.recipe) : specClips(source.spec);
  const measured = stats(model);
  const audit = auditModel(model, {
    // Only a character rig should face the rig checks. A joint rig has two
    // bones and no legs, so asking whether anything binds to a thigh would
    // report a swinging tire as broken.
    rigged: isRecipe ? clips.length > 0 : Boolean(source.spec.rig),
    scale: isRecipe ? source.recipe.scale : source.spec.scale,
    labels: isRecipe
      ? undefined
      : new Map(
          flatten(source.spec).map((row) => [
            row.path.join('.'),
            row.part.name ?? row.part.shape,
          ]),
        ),
  });
  // Bake the atlas, then cut the uv seams. After the audit on purpose: the
  // audit reads the welded index to prove the shell is closed, and a uv seam
  // is a tear in that index. The bake comes first because it reads the uv plan
  // rather than the cut uvs, and because the welded triangles are the ones the
  // paint expressions were written against.
  const atlas = bakeSurface(model);
  splitUvSeams(model);
  const png = atlas ? encodePng(atlas) : null;
  // Faceted assets have flat materials and no vertex colours, so there is
  // nothing for a texture to carry and no PNG is written.
  const texture = png ? `${base}.png` : undefined;
  // And the material channels, one file each, only where the asset actually
  // varies. A spec with no `material` block produces none of them, so what
  // lands on disk is exactly what used to.
  const extras: { name: string; data: Uint8Array }[] = [];
  for (const channel of ['roughness', 'metalness', 'emissive', 'normal'] as const) {
    const map = atlas?.maps?.[channel];
    if (map) extras.push({ name: `${base}-${channel}.png`, data: encodePng(map) });
  }
  const emissiveTexture = atlas?.maps?.emissive
    ? `${base}-emissive.png`
    : undefined;
  const files: string[] = [];

  try {
    if (formats.includes('json'))
      files.push(
        await put(
          join(outDir, isRecipe ? `${base}.recipe.json` : `${base}.spec.json`),
          JSON.stringify(isRecipe ? source.recipe : source.spec, null, 2),
        ),
      );

    if (formats.includes('obj') || formats.includes('unity')) {
      const staticModel = isRecipe
        ? buildAsset({ ...source.recipe, rigged: false })
        : buildSpec({ ...source.spec, rig: undefined, joints: undefined });
      try {
        const bundle = objBundle(
          staticModel,
          name,
          isRecipe ? undefined : source.spec.color,
          texture,
          emissiveTexture,
          {
            ...(atlas?.maps?.normal ? { normal: `${base}-normal.png` } : {}),
            ...(atlas?.maps?.roughness ? { roughness: `${base}-roughness.png` } : {}),
            ...(atlas?.maps?.metalness ? { metalness: `${base}-metalness.png` } : {}),
          },
        );
        if (formats.includes('obj')) {
          files.push(await put(join(outDir, `${base}.obj`), bundle.obj));
          files.push(await put(join(outDir, `${base}.mtl`), bundle.mtl));
        }
        if (formats.includes('unity')) {
          const glb = await toGLB(model, clips, atlas);
          const zip = zipSync(
            {
              [`${base}/${base}.glb`]: new Uint8Array(glb),
              [`${base}/${base}.obj`]: strToU8(bundle.obj),
              [`${base}/${base}.mtl`]: strToU8(bundle.mtl),
              [`${base}/${isRecipe ? 'recipe' : 'spec'}.json`]: strToU8(
                JSON.stringify(isRecipe ? source.recipe : source.spec, null, 2),
              ),
              [`${base}/README.txt`]: strToU8(
                unityReadme(
                  name,
                  Boolean(png),
                  extras.map((extra) =>
                    extra.name.slice(extra.name.lastIndexOf('-') + 1, -4),
                  ),
                ),
              ),
              ...(png ? { [`${base}/${base}.png`]: png } : {}),
              ...Object.fromEntries(
                extras.map((extra) => [`${base}/${extra.name}`, extra.data]),
              ),
            },
            { level: 6 },
          );
          files.push(await put(join(outDir, `${base}-unity.zip`), zip));
        }
      } finally {
        disposeScene(staticModel);
      }
    }

    if (formats.includes('glb')) {
      const glb = await toGLB(model, clips, atlas);
      files.push(await put(join(outDir, `${base}.glb`), new Uint8Array(glb)));
    }

    // Last, so callers that reach for `files[0]` still find the model rather
    // than its texture. The GLB embeds the same atlas when the asset paints —
    // `lib/node-shims.ts` gives the exporter the canvas it insists on — and
    // the PNGs still ship beside the model for the OBJ, which has no way to
    // carry an image inside itself.
    if (png && formats.some((format) => format !== 'json')) {
      files.push(await put(join(outDir, `${base}.png`), png));
      for (const extra of extras)
        files.push(await put(join(outDir, extra.name), extra.data));
    }
  } finally {
    disposeScene(model);
  }

  // Point the studio at this build, so an agent's work shows up in the
  // preview without anyone importing a file by hand, and record it in the
  // history so the studio can show how the asset got here.
  const written = files.find((f) => f.endsWith('.json')) ?? name;
  await markActive(name, isRecipe ? source.recipe : source.spec, written, {
    tris: measured.triangles,
    meshes: measured.meshes,
    bones: measured.bones,
    ok: audit.ok,
    errors: audit.findings.filter((f) => f.severity === 'error').length,
    warnings: audit.findings.filter((f) => f.severity === 'warn').length,
    source: options.source ?? written,
  });

  return { name, files, stats: measured, audit };
}

/** Read a written GLB back so callers can verify what actually landed on disk. */
export async function inspectGLB(path: string) {
  const { GLTFLoader } = await import(
    'three/addons/loaders/GLTFLoader.js'
  );
  const { readFile } = await import('node:fs/promises');
  const buffer = await readFile(resolve(path));
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
    '',
  );
  const bones: string[] = [];
  gltf.scene.traverse((o: T.Object3D) => {
    if (o instanceof T.Bone) bones.push(o.name);
  });
  return {
    path: resolve(path),
    stats: stats(gltf.scene),
    bones,
    /** The skeleton hand-off block. See lib/asset-rig-extras.ts. */
    extras: gltf.scene.userData.oddlings ?? null,
    animations: gltf.animations.map((c) => ({
      name: c.name,
      duration: Number(c.duration.toFixed(3)),
      tracks: c.tracks.length,
    })),
  };
}
