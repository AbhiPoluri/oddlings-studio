import * as T from 'three';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { creature, person, prop, habitat } from './three-world';
import { rigCreature } from './asset-rig';
import { splitUvSeams } from './asset-uv';
import { type Recipe, fileName } from './asset-recipe';

/**
 * Turn a recipe into a finished three.js model: geometry, merged materials,
 * flat normals, and a skinned rig when the recipe asks for one.
 *
 * Pure and deterministic — same recipe in, same geometry out — and free of
 * browser APIs so the CLI and MCP server can call it directly.
 */
export function buildAsset(recipe: Recipe) {
  let model =
    recipe.kind === 'creature'
      ? creature(recipe.seed, recipe)
      : recipe.kind === 'person'
        ? person(recipe.seed, recipe)
        : recipe.kind === 'prop'
          ? prop(recipe.seed, recipe)
          : habitat(recipe.seed, recipe);
  model.name = fileName(recipe.name);
  model.userData = { generator: 'Oddlings Studio', recipe };
  finishModel(model, recipe.kind);
  if ((recipe.kind === 'creature' || recipe.kind === 'person') && recipe.rigged)
    model = rigCreature(model, recipe);
  model.scale.setScalar(recipe.scale);
  model.updateMatrixWorld(true);
  return model;
}

/**
 * Shared finishing pass for recipe and spec assets: stable part names, flat
 * normals, and one shared material per unique color.
 */
export function finishModel(model: T.Object3D, prefix: string) {
  let index = 0;
  const colors = new Map<string, T.MeshStandardMaterial>();
  model.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.name = `${prefix}_part_${String(++index).padStart(3, '0')}`;
      o.userData = { ...o.userData };
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
  return model;
}

export function stats(model: T.Object3D) {
  let triangles = 0,
    meshes = 0,
    bones = 0;
  const materials = new Set<T.Material>();
  model.traverse((o) => {
    if (o instanceof T.Bone) bones++;
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
    bones,
    size: [size.x, size.y, size.z] as [number, number, number],
  };
}

/**
 * The static OBJ plus its material library.
 *
 * `texture` is the file name of a colour atlas the caller has written next to
 * the .mtl. Only a surface-mode material can use one, because only a
 * surface-mode mesh has the atlas uvs the map is indexed by.
 *
 * Cuts the model's uv seams in place, so the model is export-only afterwards:
 * a second audit would read those seams as holes in the shell.
 */
export function objBundle(
  model: T.Object3D,
  name: string,
  fallback?: string,
  texture?: string,
) {
  const base = fileName(name);
  // Cut the planned uv seams first, or the OBJ ships without `vt` lines and
  // the atlas has nothing to attach to. A no-op on a faceted model: three's
  // primitives already carry their own uvs through `toNonIndexed`.
  splitUvSeams(model);
  const obj = `mtllib ${base}.mtl\n${new OBJExporter().parse(model)}`;
  const palette = new Map<string, { color: T.Color; mapped: boolean }>();
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const material = o.material as T.MeshStandardMaterial;
    const mapped = Boolean(
      texture && o.userData.surface && o.geometry.userData.uvAtlas,
    );
    // A surface-mode mesh carries its palette as vertex colours and leaves its
    // material white so the GLB is not tinted twice. OBJ has no vertex colours,
    // so writing that white through would export a blank model; fall back to
    // the asset's own base colour instead, or to the baked atlas when there is
    // one, which carries every part's colour rather than just the base.
    palette.set(material.name, {
      color:
        o.userData.surface && fallback
          ? new T.Color(fallback)
          : material.color,
      mapped,
    });
  });
  const mtl = [...palette]
    .map(([materialName, entry]) => {
      // An importer multiplies Kd by map_Kd, so a tinted Kd would darken the
      // atlas. White it out and let the texture carry the colour.
      const c = entry.mapped
        ? new T.Color(1, 1, 1)
        : entry.color.clone().convertLinearToSRGB();
      const map = entry.mapped ? `map_Kd ${texture}\n` : '';
      return `newmtl ${materialName}\nKa 0.1 0.1 0.1\nKd ${c.r.toFixed(5)} ${c.g.toFixed(5)} ${c.b.toFixed(5)}\nKs 0 0 0\nNs 1\nd 1\nillum 2\n${map}`;
    })
    .join('\n');
  return { obj, mtl, base };
}
