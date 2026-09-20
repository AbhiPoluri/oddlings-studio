import './node-shims';
import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync, strToU8 } from 'fflate';
import { buildAsset, dressSurfaceMaterials, objBundle } from './asset-build';
import { buildSpec, type AssetSpec } from './asset-spec';
import { readySurface } from './asset-surface';
import { splitUvSeams, type ColorAtlas } from './asset-uv';
import {
  alreadyTextured,
  atlasTextures,
  bakeSurface,
  dressTextures,
  dropVertexColours,
  paintsTexels,
  stripBakeData,
} from './asset-bake';
import { encodePng } from './asset-png';
import { rigClips } from './asset-rig';
import { clipsOf, specClips } from './asset-joints';
import { disposeScene } from './three-world';
import { type Recipe, fileName } from './asset-recipe';

/**
 * Byte-level export builders. Nothing here touches the DOM, so the studio UI,
 * the CLI, and the MCP server all produce identical files from the same input.
 */
export async function toGLB(
  model: T.Object3D,
  animations: T.AnimationClip[] = [],
  /**
   * The atlas to embed, when the caller has already baked one.
   *
   * `null` says "do not embed", and leaving it out bakes here. The CLI bakes
   * before it splits, because it writes the same atlas out as PNGs beside the
   * model, and baking it twice would be a second or two for identical bytes.
   */
  atlas?: ColorAtlas | null,
) {
  // Cut the uv seams surface mode planned. Deferred to here on purpose: the
  // welded index is what the audit reads, so the tear happens once, on the way
  // out. Idempotent, and a faceted model passes through untouched. It replaces
  // geometry in place, so `model` is export-only afterwards: auditing it again
  // would read the seams as holes. Every caller builds a model, exports it and
  // disposes it, so nothing sees the torn one.
  splitUvSeams(model);
  // And hand the fused shell the per-group materials it planned. Same reason
  // and the same boundary: the studio's worker channel carries one material
  // per mesh, so the array is built here rather than at build time.
  dressSurfaceMaterials(model);
  // Then the maps, after the materials, because every one of them is a factor
  // the texture multiplies and `dressTextures` has to be the last word on the
  // factors. Only an asset that paints gets them: a model of flat parts is
  // exactly its vertex colours, and a megabyte of PNG saying so is a megabyte.
  if (paintsTexels(model) && !alreadyTextured(model)) {
    const baked = atlas === undefined ? bakeSurface(model) : atlas;
    if (baked) {
      dressTextures(model, atlasTextures(baked));
      dropVertexColours(model);
    }
  }
  stripBakeData(model);
  const scene = new T.Scene();
  scene.add(model);
  const output = await new GLTFExporter().parseAsync(scene, {
    binary: true,
    trs: true,
    animations,
  });
  scene.remove(model);
  if (!(output instanceof ArrayBuffer)) throw Error('GLB export failed.');
  return output;
}

export function clipsFor(recipe: Recipe) {
  return clipsOf(null, recipe);
}

/**
 * Import notes for the zip. `textured` says whether a baked colour atlas is
 * shipping beside the model: the browser download has no PNG encoder, so the
 * same pack built in the studio and on the CLI differs, and a README promising
 * a file that is not in the zip is worse than one that never mentions it.
 */
export function unityReadme(
  name: string,
  textured = false,
  /**
   * The material channels that were baked beside the colour atlas, if any.
   * Empty for every asset that authors no `material` block, which is what
   * keeps the notes for those assets the notes they always were.
   */
  channels: string[] = [],
) {
  return `${name} — Oddlings Studio

UNITY IMPORT
1. Unzip this folder.
2. Copy the .obj and .mtl files together into a folder under your Unity project's Assets directory.
3. Select the model and review its Materials import settings. Extract or remap materials if needed. In URP/HDRP use the pipeline's material conversion tools or remap the palette to compatible Lit materials.
4. Drag the imported model into your scene. Save as a prefab if desired.

Scale: numeric coordinates are meters; Y is up. The model faces +Z before any importer axis conversion.
The OBJ is a static mesh with flat normals and solid-color materials. The GLB includes a 14-bone skinned Generic rig and Idle, Walk, Jump, Wave, and Attack clips when the creature rig is enabled. Environments are static. Every mesh carries a UV0 channel.${
    textured
      ? ` A baked color atlas ships beside the model as ${fileName(name)}.png, wired to the OBJ through map_Kd. An asset that paints its surface carries the same atlas inside the GLB as a real texture, in place of vertex colors — glTF multiplies the two, so a model with both would show every pattern twice over. An asset of flat parts keeps its vertex colors and embeds nothing.`
      : ''
  }${
    channels.length
      ? ` Material maps for ${channels.join(', ')} ship beside it as ${channels
          .map((channel) => `${fileName(name)}-${channel}.png`)
          .join(', ')}; the GLB carries them as its own textures, and the MTL wires them through map_Ke, norm, map_Pr and map_Pm. Assign any your importer skips to the imported material's matching slots.`
      : ''
  } No collision shapes, LODs${channels.includes('normal') ? '' : ', normal maps'} or lightmap UVs are included. Generate colliders and lightmap UVs in Unity as needed.
The pixelated viewport is a preview effect, not baked into the model.

EDIT AGAIN
Import recipe.json into Oddlings Studio to recover exactly these generator settings.

GLB ALTERNATIVE
The included GLB preserves the scene hierarchy, skin weights, bones and animation clips when enabled. Unity needs a glTF importer, such as Unity glTFast. Install com.unity.cloud.gltfast with Package Manager, then place the GLB in Assets. Treat this non-humanoid rig as Generic, not Humanoid. Use imported clips with an Animator or the importer animation component according to importer settings. Walk is in-place (no forward root motion). The rig is a starter body rig, not a facial rig.
https://github.com/Unity-Technologies/com.unity.cloud.gltfast
`;
}

/**
 * Build the Unity hand-off zip for a recipe: animated GLB, static OBJ + MTL,
 * the editable recipe, and import notes.
 */
export async function unityPack(recipe: Recipe) {
  const model = buildAsset(recipe);
  const staticModel = buildAsset({ ...recipe, rigged: false });
  try {
    const { obj, mtl, base } = objBundle(staticModel, recipe.name);
    const glb = await toGLB(model, clipsFor(recipe));
    const zip = zipSync(
      {
        [`${base}/${base}.glb`]: new Uint8Array(glb),
        [`${base}/${base}.obj`]: strToU8(obj),
        [`${base}/${base}.mtl`]: strToU8(mtl),
        [`${base}/recipe.json`]: strToU8(JSON.stringify(recipe, null, 2)),
        [`${base}/README.txt`]: strToU8(unityReadme(recipe.name)),
      },
      { level: 6 },
    );
    return { zip, base };
  } finally {
    disposeScene(model);
    disposeScene(staticModel);
  }
}

export async function recipeGLB(recipe: Recipe) {
  const model = buildAsset(recipe);
  try {
    return await toGLB(model, clipsFor(recipe));
  } finally {
    disposeScene(model);
  }
}

export function recipeOBJ(recipe: Recipe) {
  const model = buildAsset({ ...recipe, rigged: false });
  try {
    return objBundle(model, recipe.name);
  } finally {
    disposeScene(model);
  }
}

export { fileName };

/**
 * The spec equivalents of the recipe exporters above, so an agent-authored
 * asset leaves the studio through exactly the same path as a blueprint one.
 */
export async function specGLB(spec: AssetSpec) {
  await readySurface();
  const model = buildSpec(spec);
  try {
    return await toGLB(model, specClips(spec));
  } finally {
    disposeScene(model);
  }
}

export async function specUnityPack(spec: AssetSpec) {
  await readySurface();
  const model = buildSpec(spec);
  const staticModel = buildSpec({ ...spec, rig: undefined, joints: undefined });
  try {
    const base = fileName(spec.name);
    // Bake before the OBJ is written: the material library has to name the
    // texture, and only a surface asset has one to name.
    const atlas = bakeSurface(staticModel);
    splitUvSeams(staticModel);
    const png = atlas ? encodePng(atlas) : null;
    // The material channels ride along the same way, one file per channel the
    // asset actually varies in. None of them exist for a spec with no
    // `material` block.
    const extras = (['roughness', 'metalness', 'emissive', 'normal'] as const).flatMap(
      (channel) => {
        const map = atlas?.maps?.[channel];
        return map
          ? [[`${base}/${base}-${channel}.png`, encodePng(map)] as const]
          : [];
      },
    );
    const { obj, mtl } = objBundle(
      staticModel,
      spec.name,
      spec.color,
      png ? `${base}.png` : undefined,
      atlas?.maps?.emissive ? `${base}-emissive.png` : undefined,
      {
        ...(atlas?.maps?.normal ? { normal: `${base}-normal.png` } : {}),
        ...(atlas?.maps?.roughness ? { roughness: `${base}-roughness.png` } : {}),
        ...(atlas?.maps?.metalness ? { metalness: `${base}-metalness.png` } : {}),
      },
    );
    const glb = await toGLB(model, specClips(spec));
    const zip = zipSync(
      {
        [`${base}/${base}.glb`]: new Uint8Array(glb),
        [`${base}/${base}.obj`]: strToU8(obj),
        [`${base}/${base}.mtl`]: strToU8(mtl),
        ...(png ? { [`${base}/${base}.png`]: png } : {}),
        ...Object.fromEntries(extras),
        [`${base}/spec.json`]: strToU8(JSON.stringify(spec, null, 2)),
        [`${base}/README.txt`]: strToU8(
          unityReadme(
            spec.name,
            Boolean(png),
            extras.map(([path]) => path.slice(path.lastIndexOf('-') + 1, -4)),
          ),
        ),
      },
      { level: 6 },
    );
    return { zip, base };
  } finally {
    disposeScene(model);
    disposeScene(staticModel);
  }
}
