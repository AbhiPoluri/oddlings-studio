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
import { clipsOf, specClips } from './asset-joints';
import { rigExtras } from './asset-rig-extras';
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
  // The skeleton as data, so a game can drive this file without a sidecar. The
  // spec rides on the model from `buildSpec`; a recipe carries none and gets no
  // extras. See lib/asset-rig-extras.ts.
  scene.userData.oddlings = rigExtras(
    model.userData.spec as AssetSpec | undefined,
    model,
  );
  const restoreNotes = holdBuildNotes(model);
  let output: ArrayBuffer | { [key: string]: unknown };
  try {
    output = await new GLTFExporter().parseAsync(scene, {
      binary: true,
      trs: true,
      animations,
    });
  } finally {
    restoreNotes();
    scene.remove(model);
  }
  if (!(output instanceof ArrayBuffer)) throw Error('GLB export failed.');
  return output;
}

/**
 * Hold every geometry's working notes aside while the file is written.
 *
 * `GLTFExporter` copies `geometry.userData` into the primitive's `extras`, and
 * surface mode leaves a great deal there: the paint frames each part was
 * evaluated from, the per-vertex owner and bone arrays, the crease and uv maps
 * the seam splitter kept. Every one of those is bookkeeping between build
 * passes inside this studio. Nothing reads them back out of a GLB — the paint
 * is already in the vertex colours and the baked atlas, the bones are already
 * in the skin weights, and `inspectGLB` and the studio's importer read the
 * scene's `oddlings` block and the spec on the root node, neither of which
 * lives on a geometry.
 *
 * Left in, they were most of the file. A fused shell is split into one
 * primitive per material and the exporter writes the whole block again for
 * each one, so a surface-mode walker shipped the same 330 KB eleven times:
 * 3.4 MB of GLB for 0.9 MB of model.
 *
 * Held rather than deleted because `writeAsset` exports the same model twice
 * when it is asked for a GLB and a Unity zip, and the second pass still needs
 * the notes the first one would otherwise have thrown away. Node `userData` is
 * untouched: `specPath`, `prim` and the spec on the root are small, and they
 * are what lets a part node be traced back to the line that authored it.
 */
function holdBuildNotes(model: T.Object3D) {
  const held: { geometry: T.BufferGeometry; notes: Record<string, unknown> }[] =
    [];
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const notes = object.geometry.userData;
    if (!notes || !Object.keys(notes).length) return;
    held.push({ geometry: object.geometry, notes });
    object.geometry.userData = {};
  });
  return () => {
    for (const { geometry, notes } of held) geometry.userData = notes;
  };
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
/**
 * What the GLB actually carries, for the README to describe. Counted off the
 * built model and the clips going into the file, not off what a creature rig
 * would carry, because a joints mechanism has its own bones and its own clip
 * names and a prop has neither.
 */
export type SkeletonNotes = {
  kind: 'rig' | 'joints' | 'static';
  bones: number;
  joints: number;
  clips: string[];
  /** Surface mode: one fused mesh, so no per-part nodes survive. */
  fused: boolean;
  /**
   * Authored from a spec rather than generated from a blueprint.
   *
   * Only an authored spec's parts become named nodes: a blueprint's geometry
   * comes out of the generators in `three-world`, which build meshes directly
   * with no holder to name after a part that does not exist.
   */
  authored: boolean;
};

export function skeletonNotes(
  model: T.Object3D,
  clips: T.AnimationClip[],
): SkeletonNotes {
  let bones = 0;
  model.traverse((o) => {
    if (o instanceof T.Bone) bones++;
  });
  const spec = model.userData.spec as
    | { rig?: unknown; joints?: unknown[]; surface?: unknown }
    | undefined;
  const joints = Array.isArray(spec?.joints) ? spec.joints.length : 0;
  const kind = bones === 0 ? 'static' : joints > 0 && !spec?.rig ? 'joints' : 'rig';
  return {
    kind,
    bones,
    joints,
    clips: clips.map((clip) => clip.name),
    fused: Boolean(spec?.surface),
    authored: Boolean(spec),
  };
}

/**
 * What the GLB's node tree is good for, when it still has one.
 *
 * Only a faceted, unrigged, spec-authored asset keeps a node per part: surface
 * mode fuses them into one mesh, either skeleton flattens the hierarchy into
 * skinned meshes, and a blueprint never had named parts to begin with. That
 * first case is exactly the asset whose moving pieces have no bones to drive
 * them, so it is the one whose README has to say the nodes are there.
 */
function partNodeSentence(skeleton?: SkeletonNotes) {
  // A blueprint has no authored parts to name a node after, so it has nothing
  // to promise here either way.
  if (!skeleton || !skeleton.authored) return '';
  if (skeleton.fused)
    return ' The GLB is one fused mesh, so it carries no per-part nodes; anything on it that moves, moves on a bone.';
  if (skeleton.kind !== 'static')
    return ' Skinning flattens the part hierarchy, so drive this model through its bones and clips rather than through its nodes.';
  return " Each part is also its own node in the GLB, named after the part, standing at the part's position and rotation with its geometry centred on it — so a part node's axes are the axes the part was authored in, and turning one about its own local Y turns a wheel, a revolver cylinder or a cap about the axis it was drawn on. Children nest under their parent's node, so hinging a group of parts is one rotation on the node they hang from.";
}

function skeletonSentence(skeleton?: SkeletonNotes) {
  if (!skeleton)
    return 'The GLB includes a 14-bone skinned Generic rig and Idle, Walk, Jump, Wave, and Attack clips when the creature rig is enabled.';
  const list = (names: string[]) =>
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : names[0];
  const clips = skeleton.clips.length
    ? `the ${skeleton.clips.length === 1 ? 'clip' : 'clips'} ${list(skeleton.clips)}`
    : 'no animation clips';
  switch (skeleton.kind) {
    case 'static':
      return 'The GLB is the same geometry as a plain hierarchy: no skeleton, no skin weights, no animation clips.';
    case 'joints':
      return `The GLB includes a ${skeleton.bones}-bone skeleton for a mechanism of ${skeleton.joints} joints under a Root bone, skinned as Generic, and ${clips}. Joints that share a clip name move in one clip; a joint with no clip name exports its motion under its own name. The skeleton is also written as data at scenes[0].extras.oddlings (bones, pivots, chains and leaf end points) for driving it from code.`;
    default:
      return `The GLB includes a ${skeleton.bones}-bone skinned Generic rig and ${clips}. The skeleton is also written as data at scenes[0].extras.oddlings (bones, pivots, chains and leaf end points).`;
  }
}

export function unityReadme(
  name: string,
  textured = false,
  /**
   * The material channels that were baked beside the colour atlas, if any.
   * Empty for every asset that authors no `material` block, which is what
   * keeps the notes for those assets the notes they always were.
   */
  channels: string[] = [],
  skeleton?: SkeletonNotes,
) {
  return `${name} — Oddlings Studio

UNITY IMPORT
1. Unzip this folder.
2. Copy the .obj and .mtl files together into a folder under your Unity project's Assets directory.
3. Select the model and review its Materials import settings. Extract or remap materials if needed. In URP/HDRP use the pipeline's material conversion tools or remap the palette to compatible Lit materials.
4. Drag the imported model into your scene. Save as a prefab if desired.

Scale: numeric coordinates are meters; Y is up. The model faces +Z before any importer axis conversion.
The OBJ is a static mesh with flat normals and solid-color materials. ${skeletonSentence(skeleton)}${partNodeSentence(skeleton)} Every mesh carries a UV0 channel.${
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
The included GLB preserves the scene hierarchy, skin weights, bones and animation clips when enabled. Unity needs a glTF importer, such as Unity glTFast. Install com.unity.cloud.gltfast with Package Manager, then place the GLB in Assets.${
    skeleton?.kind === 'static'
      ? ''
      : ` Treat this non-humanoid rig as Generic, not Humanoid. glTFast imports the clips as Mecanim clips and leaves an Animator with no controller, so add the clips to an Animator Controller (or switch the importer to Legacy). Clips are in place (no forward root motion).${skeleton?.kind === 'joints' ? '' : ' The rig is a starter body rig, not a facial rig.'}`
  }
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
        [`${base}/README.txt`]: strToU8(
          unityReadme(recipe.name, false, [], skeletonNotes(model, clipsFor(recipe))),
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
            skeletonNotes(model, specClips(spec)),
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
