'use client';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildAsset, stats } from '@/lib/asset-export';
import { disposeScene, lighting } from '@/lib/three-world';
import { rigClips, skeletonOf } from '@/lib/asset-rig';
import type { Recipe } from '@/lib/asset-recipe';
export type ViewHandle = {
  capture: () => string;
  home: () => void;
  front: () => void;
};
export type AssetStats = ReturnType<typeof stats>;
type Props = {
  recipe: Recipe;
  pixel: boolean;
  wireframe: boolean;
  grid: boolean;
  rotate: boolean;
  animation: string;
  skeleton: boolean;
  speed: number;
  onStats: (s: AssetStats) => void;
};
type Runtime = {
  renderer: T.WebGLRenderer;
  scene: T.Scene;
  camera: T.PerspectiveCamera;
  controls: OrbitControls;
  model: T.Group | null;
  mixer: T.AnimationMixer | null;
  helper: T.SkeletonHelper | null;
  grid: T.GridHelper;
  floor: T.Mesh;
  fit: () => void;
  resize: () => void;
};
export const AssetViewport = forwardRef<ViewHandle, Props>(
  function AssetViewport(props, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const live = useRef(props);
    live.current = props;
    const runtime = useRef<Runtime | null>(null);
    const [error, setError] = useState('');
    useImperativeHandle(
      ref,
      () => ({
        capture() {
          const v = runtime.current;
          if (!v) throw Error('The 3D viewport is unavailable.');
          const bg = v.scene.background;
          const g = v.grid.visible,
            f = v.floor.visible;
          v.scene.background = null;
          v.grid.visible = false;
          v.floor.visible = false;
          v.renderer.render(v.scene, v.camera);
          const output = v.renderer.domElement.toDataURL('image/png');
          v.scene.background = bg;
          v.grid.visible = g;
          v.floor.visible = f;
          v.renderer.render(v.scene, v.camera);
          return output;
        },
        home() {
          runtime.current?.fit();
        },
        front() {
          const v = runtime.current;
          if (!v?.model) return;
          const box = new T.Box3().setFromObject(v.model),
            center = box.getCenter(new T.Vector3()),
            size = box.getSize(new T.Vector3());
          const distance = Math.max(size.y, size.x / v.camera.aspect) * 1.65;
          v.camera.position.set(center.x, center.y, center.z + distance);
          v.controls.target.copy(center);
          v.controls.update();
        },
      }),
      [],
    );
    useEffect(() => {
      if (!canvas.current) return;
      let renderer: T.WebGLRenderer;
      try {
        renderer = new T.WebGLRenderer({
          canvas: canvas.current,
          antialias: false,
          alpha: true,
          preserveDrawingBuffer: true,
        });
      } catch {
        setError(
          'WebGL is unavailable. Enable hardware acceleration or try another browser.',
        );
        return;
      }
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFShadowMap;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const scene = new T.Scene();
      scene.background = new T.Color('#161b1c');
      lighting(scene);
      const camera = new T.PerspectiveCamera(36, 1, 0.01, 300);
      const controls = new OrbitControls(camera, canvas.current);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.autoRotateSpeed = 0.8;
      const grid = new T.GridHelper(40, 40, '#4e5754', '#303937');
      scene.add(grid);
      const floor = new T.Mesh(
        new T.PlaneGeometry(200, 200),
        new T.ShadowMaterial({ opacity: 0.2 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      floor.position.y = -0.015;
      scene.add(floor);
      const v: Runtime = {
        renderer,
        scene,
        camera,
        controls,
        model: null,
        mixer: null,
        helper: null,
        grid,
        floor,
        fit() {
          if (!v.model) return;
          const box = new T.Box3().setFromObject(v.model),
            center = box.getCenter(new T.Vector3()),
            size = box.getSize(new T.Vector3());
          const radius = size.length() * 0.5;
          const distance = (radius / Math.sin(T.MathUtils.degToRad(18))) * 1.2;
          controls.target.copy(center);
          const environment = live.current.recipe.kind === 'environment';
          camera.position
            .copy(center)
            .add(
              new T.Vector3(
                environment ? 0.42 : 0.25,
                environment ? 0.65 : 0.17,
                1,
              )
                .normalize()
                .multiplyScalar(distance),
            );
          camera.near = Math.max(0.01, distance / 100);
          camera.far = distance * 20;
          camera.updateProjectionMatrix();
          controls.minDistance = radius * 0.65;
          controls.maxDistance = distance * 4;
          grid.position.y = box.min.y - 0.015;
          floor.position.y = box.min.y - 0.02;
          controls.update();
        },
        resize() {
          const el = canvas.current;
          if (!el) return;
          const ratio = live.current.pixel
            ? 0.45
            : Math.min(devicePixelRatio, 1.5);
          renderer.setSize(
            Math.max(1, Math.round(el.clientWidth * ratio)),
            Math.max(1, Math.round(el.clientHeight * ratio)),
            false,
          );
          camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
          camera.updateProjectionMatrix();
        },
      };
      runtime.current = v;
      const ro = new ResizeObserver(v.resize);
      ro.observe(canvas.current);
      v.resize();
      let frame = 0;
      let previous = 0;
      function render(now: number) {
        frame = requestAnimationFrame(render);
        if (document.hidden || now - previous < 30) return;
        const delta = previous ? Math.min(0.1, (now - previous) / 1000) : 0;
        previous = now;
        if (v.mixer) {
          v.mixer.timeScale = live.current.speed;
          v.mixer.update(delta);
        }
        controls.autoRotate = live.current.rotate;
        controls.update();
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(render);
      return () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        controls.dispose();
        v.mixer?.stopAllAction();
        if (v.model) skeletonOf(v.model)?.dispose();
        v.helper?.dispose();
        disposeScene(scene);
        grid.geometry.dispose();
        (grid.material as T.Material).dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        runtime.current = null;
      };
    }, []);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      const old = v.model;
      const model = buildAsset(props.recipe);
      v.scene.add(model);
      v.model = model;
      if (v.mixer) {
        v.mixer.stopAllAction();
        if (old) v.mixer.uncacheRoot(old);
      }
      if (v.helper) {
        v.scene.remove(v.helper);
        v.helper.dispose();
        v.helper = null;
      }
      v.mixer = null;
      if (props.recipe.kind === 'creature' && props.recipe.rigged) {
        v.mixer = new T.AnimationMixer(model);
        const clip = rigClips().find((c) => c.name === live.current.animation);
        if (clip) v.mixer.clipAction(clip).play();
        v.helper = new T.SkeletonHelper(model);
        v.helper.visible = live.current.skeleton;
        (v.helper.material as T.LineBasicMaterial).depthTest = false;
        v.helper.renderOrder = 100;
        v.scene.add(v.helper);
      }
      if (old) {
        v.scene.remove(old);
        skeletonOf(old)?.dispose();
        disposeScene(old);
      }
      if (
        !old ||
        old.userData.recipe.kind !== props.recipe.kind ||
        old.userData.recipe.scale !== props.recipe.scale
      )
        v.fit();
      model.traverse((o) => {
        if (o instanceof T.Mesh)
          (o.material as T.MeshStandardMaterial).wireframe =
            live.current.wireframe;
      });
      props.onStats(stats(model));
    }, [props.recipe]);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      v.grid.visible = props.grid;
      v.model?.traverse((o) => {
        if (o instanceof T.Mesh)
          (o.material as T.MeshStandardMaterial).wireframe = props.wireframe;
      });
      v.resize();
    }, [props.grid, props.pixel, props.wireframe]);
    useEffect(() => {
      const v = runtime.current;
      if (!v) return;
      if (v.helper) v.helper.visible = props.skeleton;
      if (v.mixer && v.model) {
        v.mixer.stopAllAction();
        skeletonOf(v.model)?.pose();
        v.model.getObjectByName('Root')?.position.set(0, 0, 0);
        const clip = rigClips().find((c) => c.name === props.animation);
        if (clip) v.mixer.clipAction(clip).reset().play();
      }
    }, [props.animation, props.skeleton]);
    return (
      <div className="asset-viewport">
        <canvas
          ref={canvas}
          aria-label="3D asset preview. Drag to orbit, right-drag to pan, scroll to zoom."
          style={{ imageRendering: props.pixel ? 'pixelated' : 'auto' }}
        />
        {error && (
          <p className="viewport-error" role="alert">
            {error}
          </p>
        )}
        <div className="viewport-hint">
          DRAG TO ORBIT <span>·</span> SCROLL TO ZOOM <span>·</span> RIGHT-DRAG
          TO PAN
        </div>
        <div className="axes">
          <span>Y</span>
          <span>Z</span>
          <span>X</span>
        </div>
      </div>
    );
  },
);
