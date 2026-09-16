import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { zipSync, strToU8 } from 'fflate';
import { creature, habitat, disposeScene } from './three-world';
import { rigCreature, rigClips } from './asset-rig';
import { type Recipe, fileName } from './asset-recipe';
export function buildAsset(recipe: Recipe) {
  let model =
    recipe.kind === 'creature'
      ? creature(recipe.seed, recipe)
      : habitat(recipe.seed, recipe);
  model.name = fileName(recipe.name);
  model.userData = { generator: 'Oddlings Studio', recipe };
  let index = 0;
  const colors = new Map<string, T.MeshStandardMaterial>();
  model.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.name = `${recipe.kind}_part_${String(++index).padStart(3, '0')}`;
      o.userData = {};
      let geometry = o.geometry;
      if (geometry.index) {
        const nonIndexed = geometry.toNonIndexed();
        geometry.dispose();
        geometry = nonIndexed;
        o.geometry = geometry;
      }
      geometry.computeVertexNormals();
      const old = o.material as T.MeshStandardMaterial;
      const key = old.color.getHexString();
      let shared = colors.get(key);
      if (!shared) {
        shared = old;
        shared.name = `paint_${key}`;
        colors.set(key, shared);
      } else if (shared !== old) old.dispose();
      o.material = shared;
    }
  });
  if (recipe.kind === 'creature' && recipe.rigged)
    model = rigCreature(model, recipe);
  model.scale.setScalar(recipe.scale);
  model.updateMatrixWorld(true);
  return model;
}
export function stats(model: T.Object3D) {
  let triangles = 0,
    meshes = 0;
  const materials = new Set<T.Material>();
  model.traverse((o) => {
    if (o instanceof T.Mesh) {
      meshes++;
      triangles +=
        (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
        materials.add(m),
      );
    }
  });
  const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
  return {
    triangles: Math.round(triangles),
    meshes,
    materials: materials.size,
    size: [size.x, size.y, size.z],
  };
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function objBundle(model: T.Object3D, recipe: Recipe) {
  const base = fileName(recipe.name);
  const obj = `mtllib ${base}.mtl\n${new OBJExporter().parse(model)}`;
  const materials = new Map<string, T.MeshStandardMaterial>();
  model.traverse((o) => {
    if (o instanceof T.Mesh) {
      const m = o.material as T.MeshStandardMaterial;
      materials.set(m.name, m);
    }
  });
  const mtl = [...materials.values()]
    .map((m) => {
      const c = m.color.clone().convertLinearToSRGB();
      return `newmtl ${m.name}\nKa 0.1 0.1 0.1\nKd ${c.r.toFixed(5)} ${c.g.toFixed(5)} ${c.b.toFixed(5)}\nKs 0 0 0\nNs 1\nd 1\nillum 2\n`;
    })
    .join('\n');
  return { obj, mtl, base };
}
export async function exportAsset(recipe: Recipe, format: 'glb' | 'unity') {
  const model = buildAsset(recipe);
  try {
    if (format === 'glb') {
      const scene = new T.Scene();
      scene.add(model);
      const output = await new GLTFExporter().parseAsync(scene, {
        binary: true,
        trs: true,
        animations:
          recipe.kind === 'creature' && recipe.rigged ? rigClips() : [],
      });
      if (!(output instanceof ArrayBuffer)) throw Error('GLB export failed.');
      download(
        new Blob([output], { type: 'model/gltf-binary' }),
        `${fileName(recipe.name)}.glb`,
      );
    } else {
      const staticModel = buildAsset({ ...recipe, rigged: false });
      const { obj, mtl, base } = objBundle(staticModel, recipe);
      disposeScene(staticModel);
      const glbScene = new T.Scene();
      glbScene.add(model);
      const glb = await new GLTFExporter().parseAsync(glbScene, {
        binary: true,
        trs: true,
        animations:
          recipe.kind === 'creature' && recipe.rigged ? rigClips() : [],
      });
      if (!(glb instanceof ArrayBuffer)) throw Error('GLB export failed.');
      const readme = `${recipe.name} — Oddlings Studio\n\nUNITY IMPORT\n1. Unzip this folder.\n2. Copy the .obj and .mtl files together into a folder under your Unity project's Assets directory.\n3. Select the model and review its Materials import settings. Extract or remap materials if needed. In URP/HDRP use the pipeline's material conversion tools or remap the palette to compatible Lit materials.\n4. Drag the imported model into your scene. Save as a prefab if desired.\n\nScale: numeric coordinates are meters; Y is up. The model faces +Z before any importer axis conversion.\nThe OBJ is a static mesh with flat normals and solid-color materials. The GLB includes a 14-bone skinned Generic rig and Idle/Walk clips when the creature rig is enabled. Environments are static. No collision shapes, LODs, texture maps or lightmap UVs are included. Generate colliders and lightmap UVs in Unity as needed.\nThe pixelated viewport is a preview effect, not baked into the model.\n\nEDIT AGAIN\nImport recipe.json into Oddlings Studio to recover exactly these generator settings.\n\nGLB ALTERNATIVE\nThe included GLB preserves the scene hierarchy, skin weights, bones and animation clips when enabled. Unity needs a glTF importer, such as Unity glTFast. Install com.unity.cloud.gltfast with Package Manager, then place the GLB in Assets. Treat this non-humanoid rig as Generic, not Humanoid. Use imported clips with an Animator or the importer animation component according to importer settings. Walk is in-place (no forward root motion). The rig is a starter body rig, not a facial rig.\nhttps://github.com/Unity-Technologies/com.unity.cloud.gltfast\n`;
      const zip = zipSync(
        {
          [`${base}/${base}.glb`]: new Uint8Array(glb),
          [`${base}/${base}.obj`]: strToU8(obj),
          [`${base}/${base}.mtl`]: strToU8(mtl),
          [`${base}/recipe.json`]: strToU8(JSON.stringify(recipe, null, 2)),
          [`${base}/README.txt`]: strToU8(readme),
        },
        { level: 6 },
      );
      download(
        new Blob([new Uint8Array(zip).buffer], { type: 'application/zip' }),
        `${base}-unity.zip`,
      );
    }
  } finally {
    disposeScene(model);
  }
}
