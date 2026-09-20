/**
 * The camera half of a drawn stroke: screen pixels to world metres.
 *
 * Split from `draw-marks.ts` because that file is the wire format and the
 * rules over it, and it is read by the dev server's middleware — which has no
 * business loading a 3D library to validate a JSON field. This half is the
 * only part that needs three, and it needs nothing else: a camera, the size of
 * the thing being drawn on, and one function saying what the model is under a
 * given pixel.
 */
import * as T from 'three';
import type { Point2, StrokeWorld, Vec3, Path } from './draw-marks';

/** How far away a ground hit stops being a place and starts being the horizon. */
const GROUND_LIMIT = 500;

/**
 * Build a `StrokeWorld` from a camera and one model raycast.
 *
 * The camera half of this is arithmetic and is the same in a browser and in a
 * test; only `hit` needs a scene, so only `hit` is passed in.
 */
export function strokeWorld(options: {
  camera: T.PerspectiveCamera;
  /** The drawing surface, in CSS pixels. Stroke points are local to it. */
  size: { width: number; height: number };
  /** What the camera is orbiting, for the pose and for the last-resort anchor. */
  target: T.Vector3;
  hit: (at: Point2) => { point: Vec3; path: Path | null } | null;
}): StrokeWorld {
  const { camera, size, target } = options;
  const ndc = (at: Point2) =>
    new T.Vector2((at.x / size.width) * 2 - 1, -(at.y / size.height) * 2 + 1);
  const ray = (at: Point2) => {
    const caster = new T.Raycaster();
    caster.setFromCamera(ndc(at), camera);
    return caster.ray;
  };
  const out = new T.Vector3();
  const vec = (v: T.Vector3): Vec3 => [v.x, v.y, v.z];

  return {
    project(at) {
      const point = new T.Vector3(...at).project(camera);
      return {
        x: ((point.x + 1) / 2) * size.width,
        y: ((1 - point.y) / 2) * size.height,
      };
    },
    hit: options.hit,
    ground(at) {
      const plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
      if (!ray(at).intersectPlane(plane, out)) return null;
      // A ray aimed just under the horizon meets the ground kilometres away,
      // and that point is not where anybody was pointing. Beyond this it is
      // the sky, and a miss is a better answer than a number.
      return out.distanceTo(camera.position) > GROUND_LIMIT ? null : vec(out);
    },
    onPlane(at, anchor) {
      // Square to the camera, so the sketch keeps the shape it was drawn with.
      const normal = new T.Vector3();
      camera.getWorldDirection(normal);
      const plane = new T.Plane().setFromNormalAndCoplanarPoint(
        normal,
        new T.Vector3(...anchor),
      );
      return ray(at).intersectPlane(plane, out) ? vec(out) : null;
    },
    pose() {
      return {
        position: vec(camera.position),
        target: vec(target),
        fov: camera.fov,
      };
    },
  };
}
