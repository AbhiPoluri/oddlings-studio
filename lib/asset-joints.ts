import * as T from 'three';
import { rigBoneLayout, rigClips } from './asset-rig';
import type { AssetSpec, Joint } from './asset-spec';
import type { Recipe } from './asset-recipe';

/**
 * Mechanisms: a pivot, the parts that hang off it, and the motion it makes.
 *
 * The 14-bone rig in `asset-rig` is a character skeleton and nothing else — it
 * cannot describe a swinging tire, a creaking sign or a turning wheel, because
 * those are not made of hips and shoulders. A joint is the general form: one
 * bone, placed where the author says, carrying whichever parts they name.
 *
 * Everything not bound to a joint follows a static root bone, so an asset is
 * still a single skinned mesh an engine can play a clip on.
 */

/** A part is bound to a joint when its path is, or sits under, a bound one. */
function under(path: number[], bound: number[]) {
  if (path.length < bound.length) return false;
  for (let i = 0; i < bound.length; i++) if (path[i] !== bound[i]) return false;
  return true;
}

/**
 * Work out which bone each authored part belongs to.
 *
 * Authors name parts; the builder knows them by path. Resolving names once,
 * here, means a typo fails loudly at build time rather than binding a rope to
 * the root and leaving the author to wonder why it will not swing.
 */
export function jointBinder(spec: AssetSpec) {
  const joints = spec.joints ?? [];
  const byName = new Map<string, number[][]>();
  const walk = (parts: AssetSpec['parts'], prefix: number[]) => {
    parts.forEach((part, index) => {
      const path = [...prefix, index];
      if (part.name) byName.set(part.name, [...(byName.get(part.name) ?? []), path]);
      if (part.children) walk(part.children, path);
    });
  };
  walk(spec.parts, []);

  const bound: { path: number[]; bone: number }[] = [];
  joints.forEach((joint, index) => {
    for (const name of joint.binds) {
      const found = byName.get(name);
      if (!found)
        throw Error(
          `Joint "${joint.name}" binds to "${name}", but no part is called that.`,
        );
      if (found.length > 1)
        throw Error(
          `Joint "${joint.name}" binds to "${name}", but ${found.length} parts share that name. Give them distinct names.`,
        );
      bound.push({ path: found[0], bone: index + 1 });
    }
  });

  // Deeper bindings win, so binding a branch and then one twig on it does what
  // it looks like it does.
  bound.sort((a, b) => b.path.length - a.path.length);
  return (path: number[] | undefined) => {
    if (!path) return 0;
    for (const entry of bound) if (under(path, entry.path)) return entry.bone;
    return 0;
  };
}

/**
 * Skin a built model to a root bone plus one bone per joint.
 *
 * Mirrors `rigCreature`'s shape so the export path does not have to care which
 * kind of rig produced the mesh.
 */
export function rigJoints(
  source: T.Group,
  joints: Joint[],
  boneFor: (path: number[] | undefined) => number,
) {
  const model = new T.Group();
  model.name = source.name;
  model.userData = source.userData;

  const root = new T.Bone();
  root.name = 'Root';
  // Every bone exists before any is parented, so a joint may name a parent
  // authored after it and `jointBinder`'s `index + 1` still finds the right
  // bone whatever shape the chain is.
  const bones: T.Bone[] = [root];
  const byName = new Map<string, number>();
  joints.forEach((joint, index) => {
    const bone = new T.Bone();
    bone.name = joint.name;
    bones.push(bone);
    byName.set(joint.name, index + 1);
  });
  joints.forEach((joint, index) => {
    const named = joint.parent ? byName.get(joint.parent) : 0;
    // The schema rejects an unknown parent, so this only falls back for a
    // caller that skipped it; hanging off the root is the harmless answer.
    const owner = named === undefined ? 0 : named;
    // `at` is absolute, a bone's position is relative to its parent, and the
    // bind pose has no rotations — so the offset is a plain subtraction, and
    // moving a parent carries its children rather than stretching the chain.
    const base = owner === 0 ? [0, 0, 0] : joints[owner - 1].at;
    bones[index + 1].position.set(
      joint.at[0] - base[0],
      joint.at[1] - base[1],
      joint.at[2] - base[2],
    );
    bones[owner].add(bones[index + 1]);
  });
  model.add(root);
  model.updateMatrixWorld(true);
  const skeleton = new T.Skeleton(bones);
  skeleton.calculateInverses();

  source.updateMatrixWorld(true);
  source.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    const position = geometry.attributes.position;
    // Surface mode fuses everything into one mesh, so the binding has to be
    // per vertex — the same owner data the rigger and the audit already read.
    const owners = geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (number[] | undefined)[] }
      | undefined;
    const meshBone = boneFor(object.userData.specPath as number[] | undefined);
    const ids: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const bone = owners ? boneFor(owners.paths[owners.index[i]]) : meshBone;
      ids.push(bone, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(ids, 4));
    geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));

    const skinned = new T.SkinnedMesh(geometry, object.material);
    skinned.name = object.name;
    skinned.userData = { ...object.userData };
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    model.add(skinned);
    skinned.bind(skeleton, new T.Matrix4());
    object.geometry.dispose();
  });
  model.updateMatrixWorld(true);
  return model;
}

/**
 * The rotation track for one spinning joint.
 *
 * The angle is sampled off a sine rather than keyed at its two extremes.
 * Keying the extremes and letting the player interpolate gives constant
 * angular speed, which reads as a metronome; a pendulum is slowest at the top
 * of its arc, and that is most of what makes a swing look like a swing. With
 * no phase it starts at zero, so the first frame matches the bind pose.
 */
function spinTrack(joint: Joint) {
  const { axis, degrees, seconds, phase, mode, drift: wander } = joint.spin!;
  // Three disables smooth interpolation for quaternion tracks, so the
  // easing has to live in the samples. Two dozen is plenty for the eye.
  const steps = 24;
  const main = new T.Vector3(
    axis === 'x' ? 1 : 0,
    axis === 'y' ? 1 : 0,
    axis === 'z' ? 1 : 0,
  );
  // A real swing never stays in one plane. A little rotation about a second
  // axis at twice the rate traces the flattened figure-eight a rope swing
  // actually makes, and is the difference between a pendulum and a prop.
  // Twice the rate also means it is zero whenever the main angle is, so the
  // first frame is the bind pose and the loop closes.
  const drift = axis === 'y' ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
  // Lag shifts the joint along the same curve rather than detuning it: both
  // terms move together, so the figure-eight keeps its shape and the loop
  // still closes. A phased joint simply does not start at the bind pose,
  // which is the point — it is trailing whatever it hangs from.
  const lag = T.MathUtils.degToRad(phase);
  const times: number[] = [];
  const values: number[] = [];
  const turn = new T.Quaternion();
  const wobble = new T.Quaternion();
  for (let i = 0; i <= steps; i++) {
    const cycle = (i / steps) * Math.PI * 2 + lag;
    if (mode === 'turn') {
      // A wheel: the angle is the clock. 15° between samples is well inside
      // what slerp handles, and the last sample lands back on the first, so
      // the loop closes without a seam.
      turn.setFromAxisAngle(main, Math.sign(degrees || 1) * cycle);
    } else {
      turn.setFromAxisAngle(main, T.MathUtils.degToRad(degrees) * Math.sin(cycle));
      wobble.setFromAxisAngle(
        drift,
        T.MathUtils.degToRad(degrees * wander) * Math.sin(cycle * 2),
      );
      turn.multiply(wobble);
    }
    times.push((i / steps) * seconds);
    values.push(turn.x, turn.y, turn.z, turn.w);
  }
  return new T.QuaternionKeyframeTrack(
    `${joint.name}.quaternion`,
    times,
    values,
  );
}

/**
 * One looping clip per named clip, carrying every joint that asked for it.
 *
 * A clip per joint is the wrong unit for a mechanism: a tire on a rope is two
 * bones doing one motion, and nothing downstream can promise two clips will be
 * played in step. Joints that name the same `spin.clip` are sampled into one
 * clip with a track each, so a chain arrives in an engine as a single thing to
 * play. A joint that names no clip gets one of its own, as before.
 */
export function jointClips(joints: Joint[]): T.AnimationClip[] {
  const order: string[] = [];
  const grouped = new Map<string, Joint[]>();
  for (const joint of joints) {
    if (!joint.spin) continue;
    const name = joint.spin.clip ?? joint.name;
    const members = grouped.get(name);
    if (members) members.push(joint);
    else {
      grouped.set(name, [joint]);
      order.push(name);
    }
  }
  return order.map((name) => {
    const members = grouped.get(name)!;
    // The schema has already refused a clip whose members disagree about it.
    const seconds = members[0].spin!.seconds;
    return new T.AnimationClip(name, seconds, members.map(spinTrack));
  });
}

/**
 * Where every bone of a spec sits, whichever kind of rig it declares.
 *
 * Positions are ABSOLUTE and in model space — the same unscaled space part
 * positions and `joints[].at` use, so multiply by `spec.scale` to get world
 * space. `Root` comes first, then bones in skeleton-index order, so entry `i`
 * is skeleton bone `i` and `parent` is a name in the same list (`null` only
 * for the root). A spec with no rig has no bones and returns nothing.
 *
 * This exists so an editor can draw a handle on a bone, or write one back,
 * without building the model to find out where the bone went — which is the
 * difference between dragging a pivot and guessing at it.
 */
export function boneLayout(
  spec: AssetSpec,
): { name: string; parent: string | null; at: [number, number, number] }[] {
  if (spec.rig)
    return rigBoneLayout(spec.rig).map((place) => ({
      name: place.name,
      parent: place.parent,
      at: [place.at[0], place.at[1], place.at[2]] as [number, number, number],
    }));
  const joints = spec.joints ?? [];
  if (!joints.length) return [];
  return [
    { name: 'Root', parent: null, at: [0, 0, 0] as [number, number, number] },
    ...joints.map((joint) => ({
      name: joint.name,
      parent: joint.parent ?? 'Root',
      at: [joint.at[0], joint.at[1], joint.at[2]] as [number, number, number],
    })),
  ];
}

/** The clips an authored spec exports, whichever kind of rig it declares. */
export function specClips(spec: AssetSpec): T.AnimationClip[] {
  if (spec.rig) return rigClips();
  if (spec.joints?.length) return jointClips(spec.joints);
  return [];
}

/**
 * The clips for whichever kind of asset is on screen.
 *
 * The viewport, the exporters and the clip picker all have to agree on this,
 * and they used to agree by each hard-coding the humanoid list — which meant a
 * joint clip could reach the GLB with no way to preview it.
 */
export function clipsOf(
  spec?: AssetSpec | null,
  recipe?: Recipe | null,
): T.AnimationClip[] {
  if (spec) return specClips(spec);
  if (recipe)
    return (recipe.kind === 'creature' || recipe.kind === 'person') &&
      recipe.rigged
      ? rigClips()
      : [];
  return [];
}
