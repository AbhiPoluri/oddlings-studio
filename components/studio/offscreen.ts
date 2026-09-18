'use client';
/**
 * A picture of a spec without putting it on screen.
 *
 * Thumbnails are normally taken from the viewport, because the viewport is
 * already holding the model — but that only ever fills in the file you are
 * looking at, and a list of seventeen specs is most useful when all seventeen
 * have a picture. This builds one at a time in a canvas nobody sees, using the
 * same `buildSpec` and the same lights the viewport uses, so a thumbnail taken
 * here and one taken there are pictures of the same thing.
 *
 * One renderer, made on demand and released when the run finishes: a WebGL
 * context is an expensive thing to hold, and the browser only allows a handful
 * at once — the viewport already has one of them.
 */
import * as T from 'three';
import type { AssetSpec } from '@/lib/asset-spec';
import { disposeScene, lighting } from '@/lib/three-world';
import { THUMB } from './thumbs';

/** Drawn at twice the card and scaled down, so the edges are not stepped. */
const SCALE = 2;

type Rig = {
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  camera: T.PerspectiveCamera;
};

let rig: Rig | null = null;

function open(): Rig | null {
  if (rig) return rig;
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB.width * SCALE;
    canvas.height = THUMB.height * SCALE;
    const renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new T.Scene();
    lighting(scene);
    const camera = new T.PerspectiveCamera(
      36,
      THUMB.width / THUMB.height,
      0.01,
      300,
    );
    rig = { renderer, scene, camera };
    return rig;
  } catch {
    // No WebGL to spare. The list keeps the pictures it already has.
    return null;
  }
}

/** Let the GPU context go. Called when a run finishes, or the panel unmounts. */
export function closeOffscreen() {
  if (!rig) return;
  disposeScene(rig.scene);
  rig.renderer.dispose();
  rig = null;
}

/**
 * Photograph one already-built model from the studio's three-quarter angle,
 * and throw its meshes away again. Returns an empty string when it cannot.
 *
 * Takes a model rather than a spec because the building happens in the build
 * worker now: the caller asks for one, waits, and hands the result here. The
 * model is consumed — disposed on the way out — since every caller builds it
 * for this and nothing else.
 */
export function renderThumb(spec: AssetSpec, model: T.Object3D): string {
  const made = open();
  if (!made) {
    disposeScene(model);
    return '';
  }
  const { renderer, scene, camera } = made;
  scene.add(model);
  try {
    const box = new T.Box3().setFromObject(model);
    const centre = box.getCenter(new T.Vector3());
    const size = box.getSize(new T.Vector3());
    const radius = Math.max(1e-4, size.length() * 0.5);
    // The same framing `fit` uses in the viewport, with a little more air:
    // a card is small, and a model that touches all four edges reads as a blob.
    const distance = (radius / Math.sin(T.MathUtils.degToRad(18))) * 1.35;
    const environment = spec.kind === 'environment';
    camera.position
      .copy(centre)
      .add(
        new T.Vector3(environment ? 0.42 : 0.25, environment ? 0.65 : 0.17, 1)
          .normalize()
          .multiplyScalar(distance),
      );
    camera.lookAt(centre);
    camera.near = Math.max(0.01, distance / 100);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } catch {
    return '';
  } finally {
    scene.remove(model);
    disposeScene(model);
  }
}
