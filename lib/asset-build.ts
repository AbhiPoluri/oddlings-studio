import * as T from 'three';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { creature, person, prop, habitat } from './three-world';
import { rigCreature } from './asset-rig';
import {
  applyMaterial,
  isDefaultMaterial,
  materialKey,
  materialOf,
  materialSuffix,
  splitUvSeams,
  type MaterialSpec,
  type SurfaceMaterial,
} from './asset-uv';
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
 * normals, and one shared material per unique appearance.
 *
 * "Appearance" is colour *and* surface response — roughness, metalness,
 * emission — not colour alone. Keying on colour alone was right while every
 * part was matte; with `material` in the spec it would hand a glowing lens and
 * the matte ring around it the same material, and whichever of the two the
 * builder reached first would win. The tuple is what the parts actually share,
 * so it is what the map is keyed by.
 *
 * A part with no `material` produces exactly the tuple every part had before
 * the field existed, and its material keeps the `paint_<hex>` name it always
 * had, so an asset that never mentions materials exports byte for byte as it
 * did.
 */
export function finishModel(model: T.Object3D, prefix: string) {
  let index = 0;
  const palette = new Map<string, T.MeshStandardMaterial>();
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
      const hex = old.color.getHexString();
      const prim = o.userData.prim as { material?: MaterialSpec } | undefined;
      const wanted = materialOf(prim?.material);
      const key = `${hex}|${materialKey(wanted)}`;
      let shared = palette.get(key);
      if (!shared) {
        old.name = isDefaultMaterial(wanted)
          ? `paint_${hex}`
          : `paint_${hex}_${materialSuffix(wanted)}`;
        // Assigned, not mutated: a preset that needs transmission, clearcoat
        // or sheen comes back as a `MeshPhysicalMaterial` built from this one,
        // and the standard material it replaces is disposed for us.
        shared = applyMaterial(old, wanted);
        palette.set(key, shared);
      } else if (shared !== old) old.dispose();
      o.material = shared;
    }
  });
  return model;
}

/**
 * Give a fused surface mesh the material array its groups were planned for.
 *
 * Deferred to the export boundary, exactly as the uv seam cut is, and for the
 * same shape of reason: the studio builds its preview in a worker and hands
 * the model back as plain data, and that channel carries one material per mesh.
 * A model that came out of the worker with an array would arrive with none. So
 * the built mesh keeps its single material — which is what the viewport draws,
 * tinted by the vertex colours it always used — and the fan-out happens here,
 * on the way into a file, where the groups the builder wrote are still on the
 * geometry and nothing is going to round-trip again.
 *
 * Idempotent, and a no-op on a faceted model or on a surface model whose parts
 * are all matte.
 */
export function dressSurfaceMaterials(model: T.Object3D) {
  model.traverse((o) => {
    if (!(o instanceof T.Mesh) || Array.isArray(o.material)) return;
    const wanted = o.geometry.userData.surfaceMaterials as
      | SurfaceMaterial[]
      | undefined;
    if (!wanted || wanted.length < 2) return;
    // A geometry that came back from the worker has the material table and no
    // groups, because the serialisation carries attributes, index and userData
    // and nothing else. Put them back from the copy the builder left.
    if (!o.geometry.groups.length) {
      const ranges = o.geometry.userData.surfaceGroups as
        | { start: number; count: number; materialIndex: number }[]
        | undefined;
      if (!ranges?.length) return;
      for (const range of ranges)
        o.geometry.addGroup(range.start, range.count, range.materialIndex);
    }
    const base = o.material as T.MeshStandardMaterial;
    o.material = wanted.map((tuple) => {
      const made = base.clone();
      made.name = isDefaultMaterial(tuple)
        ? base.name
        : `${base.name}_${materialSuffix(tuple)}`;
      return applyMaterial(made, tuple);
    });
    base.dispose();
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
  emissiveTexture?: string,
  /**
   * The other baked channels, by file name.
   *
   * MTL grew PBR keywords late and unofficially, but `norm`, `map_Pr` and
   * `map_Pm` are what Blender and the PBR-aware importers read, and writing
   * them costs three lines for a material that already ships the images. An
   * importer that does not know them ignores them, which is the same place
   * this was before.
   */
  maps?: { normal?: string; roughness?: string; metalness?: string },
) {
  const base = fileName(name);
  // Cut the planned uv seams first, or the OBJ ships without `vt` lines and
  // the atlas has nothing to attach to. A no-op on a faceted model: three's
  // primitives already carry their own uvs through `toNonIndexed`.
  splitUvSeams(model);
  const obj = `mtllib ${base}.mtl\n${new OBJExporter().parse(model)}`;
  type Entry = {
    color: T.Color;
    mapped: boolean;
    glowing: boolean;
    material: T.MeshStandardMaterial;
  };
  const palette = new Map<string, Entry>();
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
      glowing: Boolean(
        emissiveTexture && o.userData.surface && o.geometry.userData.uvAtlas,
      ),
      material,
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
      const glow = emissionOf(entry.material, entry.glowing, emissiveTexture);
      const pbr = entry.mapped
        ? [
            maps?.normal ? `norm ${maps.normal}\n` : '',
            maps?.roughness ? `map_Pr ${maps.roughness}\n` : '',
            maps?.metalness ? `map_Pm ${maps.metalness}\n` : '',
          ].join('')
        : '';
      return `newmtl ${materialName}\nKa 0.1 0.1 0.1\nKd ${c.r.toFixed(5)} ${c.g.toFixed(5)} ${c.b.toFixed(5)}\nKs 0 0 0\nNs ${shininess(entry.material)}\nd 1\nillum 2\n${map}${glow}${pbr}`;
    })
    .join('\n');
  return { obj, mtl, base };
}

/**
 * Roughness as a Phong exponent, because that is the only gloss control an MTL
 * has.
 *
 * `(1 - roughness)^2 * 1000` is the usual rough-to-shiny mapping, floored at 1.
 * A fully rough material lands exactly on the `Ns 1` every material in this
 * pipeline wrote before roughness was authorable, so an asset with no
 * `material` block still writes the same file.
 */
function shininess(material: T.MeshStandardMaterial) {
  const roughness = material.roughness ?? 1;
  return Math.max(1, Math.round((1 - roughness) ** 2 * 1000));
}

/**
 * The `Ke` line, and the emissive map when one was baked.
 *
 * An importer multiplies `Ke` by `map_Ke`, so with a map the scalar goes white
 * and the image carries the colour — the same trick `Kd` plays with `map_Kd`.
 * Without a map the material's own emission is written through, already
 * multiplied by its strength: MTL has no equivalent of
 * `KHR_materials_emissive_strength`, so a lamp authored at strength 4 is
 * clamped to full white rather than dropped to a quarter of what it should be.
 * Nothing is written at all when nothing glows, which is what keeps every
 * existing material library byte for byte what it was.
 */
function emissionOf(
  material: T.MeshStandardMaterial,
  mapped: boolean,
  texture?: string,
) {
  if (mapped && texture) return `Ke 1.00000 1.00000 1.00000\nmap_Ke ${texture}\n`;
  const emissive = material.emissive;
  if (!emissive || (!emissive.r && !emissive.g && !emissive.b)) return '';
  const lit = emissive
    .clone()
    .multiplyScalar(material.emissiveIntensity ?? 1)
    .convertLinearToSRGB();
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return `Ke ${clamp(lit.r).toFixed(5)} ${clamp(lit.g).toFixed(5)} ${clamp(lit.b).toFixed(5)}\n`;
}
