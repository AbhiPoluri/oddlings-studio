import {
  unityPack,
  recipeGLB,
  specGLB,
  specUnityPack,
} from './asset-bundle';
import { type Recipe, fileName } from './asset-recipe';
import type { AssetSpec } from './asset-spec';

export { buildAsset, stats, objBundle } from './asset-build';

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function exportAsset(recipe: Recipe, format: 'glb' | 'unity') {
  if (format === 'glb') {
    const glb = await recipeGLB(recipe);
    download(
      new Blob([glb], { type: 'model/gltf-binary' }),
      `${fileName(recipe.name)}.glb`,
    );
    return;
  }
  const { zip, base } = await unityPack(recipe);
  download(
    new Blob([new Uint8Array(zip).buffer], { type: 'application/zip' }),
    `${base}-unity.zip`,
  );
}

export async function exportSpecAsset(
  spec: AssetSpec,
  format: 'glb' | 'unity',
) {
  if (format === 'glb') {
    const glb = await specGLB(spec);
    download(
      new Blob([glb], { type: 'model/gltf-binary' }),
      `${fileName(spec.name)}.glb`,
    );
    return;
  }
  const { zip, base } = await specUnityPack(spec);
  download(
    new Blob([new Uint8Array(zip).buffer], { type: 'application/zip' }),
    `${base}-unity.zip`,
  );
}
