/**
 * Does the asset cut through itself once it starts moving?
 *
 * Every other check in `asset-audit` looks at the bind pose, which is the one
 * pose nobody ships: a sign hangs straight, a wheel sits at zero, a walker
 * stands still. The defect this finds only exists in the poses in between —
 * the board swings into the post, the sail passes through the tower, the arm
 * sweeps through the hip — and it is invisible in every render of the rest
 * pose and in every number the static audit reports. An author who cannot see
 * it either raises the swing until it looks wrong, or ships it.
 *
 * Measured, not simulated. Each clip is sampled at a handful of frames; every
 * part is carried by the bone it is bound to; and the surface samples of one
 * part are pushed through the signed distance fields of the parts on OTHER
 * bones. Points against fields, never field against field — an SDF is only
 * honest about the point you ask it about, and two fields have no meeting to
 * report.
 *
 * Three things keep it from crying wolf. Parts that move together are never
 * compared, because a kitbash is made of parts shoved into each other on
 * purpose and their overlap is the join, not a fault (the same reasoning that
 * scopes `asset-trim` to a motion group). Only samples that stand in the open
 * at rest are followed, because a sample that starts buried in its neighbour
 * is hidden geometry whichever way the mechanism turns. And a fault is only
 * raised where the authored solids are the shipped geometry — a faceted
 * mechanism. Blend the parts into one surface, or skin them onto a character,
 * and two of them passing through each other is how the thing is built: every
 * shipped creature in `specs/` has a thigh that sweeps through its belly, and
 * a check that called those errors would be a check nobody reads. Those are
 * measured too, and reported as one note.
 */
import * as T from 'three';
import { sampleMesh, type Audit, type Finding } from './asset-audit';
import { boneLayout, jointBinder, specClips } from './asset-joints';
import { JOINTS } from './asset-rig';
import { distanceTo, type Prim } from './asset-sdf';
import { buildSpec, type AssetSpec } from './asset-spec';
import { primsOf } from './asset-surface';
import { disposeScene } from './three-world';

/**
 * Frames per clip.
 *
 * A swing is a sine, so eight samples put two of them within a few degrees of
 * each extreme, which is where a pendulum spends its depth. More frames buy
 * resolution on the instant, not on the fact — and the fact is what a finding
 * is for.
 */
export const CLIP_FRAMES = 8;

/** Depth in millimetres of world space, past which this is worth saying. */
const WARN_MM = 5;
/** Depth past which it is a defect rather than a rub. */
const ERROR_MM = 25;

/** At most this many pairs are named; the rest are counted. */
const MAX_FINDINGS = 12;

export type ClipSummary = {
  /** The clips sampled, by name. */
  clips: string[];
  /** Frames sampled per clip. */
  frames: number;
  /** Part pairs on different bones that were actually measured. */
  pairs: number;
  /** Sample points pushed through a field: the size of the job. */
  samples: number;
  /** Deepest penetration found, in millimetres of world space. */
  worst: number;
  /** Parts skipped because no single bone carries them. See `boneFor`. */
  skipped: number;
  /**
   * True when the authored solids are what ships, which is the only case a
   * depth is a fault rather than a note: a faceted mechanism. See the header.
   */
  rigid: boolean;
};

export type ClipAudit = { findings: Finding[]; summary: ClipSummary };

export type ClipOptions = {
  /** Frames sampled per clip. Defaults to `CLIP_FRAMES`. */
  frames?: number;
};

const QUIET: ClipSummary = {
  clips: [],
  frames: 0,
  pairs: 0,
  samples: 0,
  worst: 0,
  skipped: 0,
  rigid: false,
};

/** One mesh, the bone that carries it, and the field it presents to others. */
type Moving = {
  /** One mesh, not one authored part: a repeat's copies each stand alone. */
  id: number;
  label: string;
  path?: number[];
  /** The bone whose motion this mesh rides. Parts sharing one are never paired. */
  group: string;
  points: T.Vector3[];
  centre: T.Vector3;
  radius: number;
  /** Null when the part is a carve or a plane: real enough to probe, too thin to be entered. */
  solid: Prim | null;
};

type Worst = {
  a: Moving;
  b: Moving;
  depth: number;
  clip: string;
  time: number;
  duration: number;
  frame: number;
};

/**
 * The bone a rig-bound mesh follows, or null when no single bone does.
 *
 * `rigCreature` weights an unpinned part across two bones by the height of
 * each vertex, so there is no one transform that poses it and no honest
 * answer to "where will this be in a second". Those parts are counted and
 * left alone rather than guessed at.
 */
function boneFor(rigPart: string | undefined) {
  if (!rigPart) return null;
  return JOINTS.find((bone) => bone.toLowerCase() === rigPart) ?? null;
}

/** Authored names by path key, for messages an author can act on. */
function labelsOf(spec: AssetSpec) {
  const labels = new Map<string, string>();
  const walk = (parts: AssetSpec['parts'], prefix: number[]) => {
    parts.forEach((part, index) => {
      const path = [...prefix, index];
      labels.set(path.join('.'), part.name ?? part.shape);
      if (part.children) walk(part.children, path);
    });
  };
  walk(spec.parts, []);
  return labels;
}

/** The skeleton of a spec as loose bones, plus the inverse of its bind pose. */
function skeletonOf(spec: AssetSpec) {
  const layout = boneLayout(spec);
  const bones = new Map<string, T.Bone>();
  const at = new Map<string, [number, number, number]>();
  for (const place of layout) {
    const bone = new T.Bone();
    bone.name = place.name;
    bones.set(place.name, bone);
    at.set(place.name, place.at);
  }
  for (const place of layout) {
    const bone = bones.get(place.name)!;
    const base = place.parent ? at.get(place.parent)! : [0, 0, 0];
    bone.position.set(
      place.at[0] - base[0],
      place.at[1] - base[1],
      place.at[2] - base[2],
    );
    if (place.parent) bones.get(place.parent)!.add(bone);
  }
  // `boneLayout` lists the root first and a parent before its children, so the
  // first entry is the one nothing was parented to.
  const root = bones.get(layout[0].name)!;
  root.updateMatrixWorld(true);
  const bind = new Map<string, T.Matrix4>();
  for (const [name, bone] of bones)
    bind.set(name, bone.matrixWorld.clone().invert());
  return { root, bones, bind };
}

/** Every mesh of the probe build, tagged with the bone that carries it. */
function movingParts(model: T.Object3D, spec: AssetSpec) {
  const labels = labelsOf(spec);
  // Prims and meshes come out of one traversal in one order; `asset-trim`
  // pairs them the same way and for the same reason.
  const prims = primsOf(model, new T.Color('#808080'));
  const meshes: T.Mesh[] = [];
  model.traverse((o) => {
    if (o instanceof T.Mesh && o.userData.prim) meshes.push(o);
  });
  if (meshes.length !== prims.length)
    throw Error('auditClips: primitives and meshes do not line up.');

  const joints = spec.joints ?? [];
  const binder = joints.length ? jointBinder(spec) : null;
  const parts: Moving[] = [];
  let skipped = 0;
  meshes.forEach((mesh, index) => {
    const path = mesh.userData.specPath as number[] | undefined;
    const bone = binder
      ? ((b) => (b === 0 ? 'Root' : joints[b - 1].name))(binder(path))
      : boneFor(mesh.userData.rigPart as string | undefined);
    if (!bone) return void skipped++;
    const { points } = sampleMesh(mesh);
    if (!points.length) return;
    const box = new T.Box3().setFromPoints(points);
    const prim = prims[index];
    parts.push({
      id: parts.length,
      label: path ? (labels.get(path.join('.')) ?? path.join('.')) : mesh.name,
      path,
      group: bone,
      points,
      centre: box.getCenter(new T.Vector3()),
      radius: box.getSize(new T.Vector3()).length() / 2,
      solid: prim.subtract || prim.shape === 'plane' ? null : prim,
    });
  });
  return { parts, skipped };
}

/** How far inside `prim` the point is, or zero when it is outside. */
function depthIn(prim: Prim, p: T.Vector3) {
  const box = prim.box;
  if (
    p.x < box.min.x ||
    p.x > box.max.x ||
    p.y < box.min.y ||
    p.y > box.max.y ||
    p.z < box.min.z ||
    p.z > box.max.z
  )
    return 0;
  const d = distanceTo(prim, p.x, p.y, p.z);
  return d < 0 ? -d : 0;
}

/** True when two bones hold their parts in exactly the pose they bound them in. */
function unmoved(m: T.Matrix4) {
  const e = m.elements;
  for (let i = 0; i < 16; i++)
    if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  return true;
}

/**
 * Sample every clip and report where parts on different bones run into each
 * other.
 *
 * Geometry is measured in the spec's own unscaled space, which is the space
 * `joints[].at` and part positions are written in, so a `value` can be added
 * to an authored number. Depths are only turned into millimetres of world
 * space — where 5 mm means 5 mm — at the moment a threshold is applied.
 */
export function auditClips(
  spec: AssetSpec,
  options: ClipOptions = {},
): ClipAudit {
  const frames = Math.max(1, Math.round(options.frames ?? CLIP_FRAMES));
  if (!spec.joints?.length && !spec.rig)
    return { findings: [], summary: { ...QUIET } };
  const clips = specClips(spec);
  if (!clips.length) return { findings: [], summary: { ...QUIET } };

  const scale = spec.scale > 0 ? spec.scale : 1;
  const mm = (depth: number) => depth * scale * 1000;
  // The authored solids, at unit scale and untrimmed: the same rebuild the
  // static audit does, for the same reason — a trimmed model has lost exactly
  // the faces that touch a neighbour, and a fused one has lost the parts.
  const model = buildSpec({
    ...spec,
    surface: undefined,
    rig: undefined,
    joints: undefined,
    trim: false,
    scale: 1,
  });
  const summary: ClipSummary = {
    clips: clips.map((clip) => clip.name),
    frames,
    pairs: 0,
    samples: 0,
    worst: 0,
    skipped: 0,
    // A joint rig binds a whole part to one bone and a faceted build ships
    // those parts as the solids they were authored as, so a depth measured
    // here is a depth somebody sees. Neither is true of a fused surface or a
    // character; see the header.
    rigid: Boolean(spec.joints?.length) && !spec.surface,
  };
  const worst = new Map<string, Worst>();
  try {
    const { parts, skipped } = movingParts(model, spec);
    summary.skipped = skipped;
    const byGroup = new Map<string, Moving[]>();
    for (const part of parts)
      byGroup.set(part.group, [...(byGroup.get(part.group) ?? []), part]);
    if (byGroup.size < 2) return { findings: [], summary };

    const named = new Set(boneLayout(spec).map((place) => place.name));
    const groups = [...byGroup.keys()].filter((name) => named.has(name));
    // Which of A's samples are out in the open at rest, worked out once per
    // pair and only for pairs that ever come close.
    //
    // A sample that starts inside its neighbour is the join the author built —
    // a rope's end inside the bough it hangs from, a tenon in its mortise —
    // and it is hidden geometry whichever way the mechanism turns; driving it
    // deeper changes nothing anybody sees. A sample that starts in the open
    // and ends up inside is the part going somewhere it should not. Per
    // sample rather than per part: the near end of a rope is a join while its
    // far end is a surface.
    const inTheOpen = new Map<string, Uint8Array>();
    const pose = new Map<string, T.Matrix4>();
    const relative = new T.Matrix4();
    const probe = new T.Vector3();
    const reach = new T.Vector3();

    for (const clip of clips) {
      // A skeleton per clip. Reusing one would leave it wherever the last
      // clip's final frame put it unless three restores the bind pose on its
      // way out, and a wheel parked at 315° would be measured as clip two's
      // doing.
      const { root, bones, bind } = skeletonOf(spec);
      const mixer = new T.AnimationMixer(root);
      mixer.clipAction(clip).play();
      for (let frame = 0; frame < frames; frame++) {
        const time = (clip.duration * frame) / frames;
        mixer.setTime(time);
        root.updateMatrixWorld(true);
        for (const name of groups)
          pose.set(
            name,
            bones.get(name)!.matrixWorld.clone().multiply(bind.get(name)!),
          );

        for (const from of groups)
          for (const into of groups) {
            if (from === into) continue;
            // Everything is measured in the frame `into` bound its parts in,
            // so the fields can be read where they were authored.
            relative
              .copy(pose.get(into)!)
              .invert()
              .multiply(pose.get(from)!);
            if (unmoved(relative)) continue;
            for (const a of byGroup.get(from)!)
              for (const b of byGroup.get(into)!) {
                if (!b.solid) continue;
                reach.copy(a.centre).applyMatrix4(relative);
                if (reach.distanceTo(b.centre) > a.radius + b.radius) continue;
                // By mesh, not by part: a repeat's copies share a path and a
                // name, and each one stands in a different place, so a mask
                // keyed by name would answer for its sibling.
                const key = `${a.id}|${b.id}`;
                let open = inTheOpen.get(key);
                if (!open) {
                  open = new Uint8Array(a.points.length);
                  for (let i = 0; i < a.points.length; i++)
                    open[i] = depthIn(b.solid, a.points[i]) > 0 ? 0 : 1;
                  inTheOpen.set(key, open);
                  summary.pairs++;
                }
                let deepest = 0;
                for (let i = 0; i < a.points.length; i++) {
                  if (!open[i]) continue;
                  probe.copy(a.points[i]).applyMatrix4(relative);
                  const past = depthIn(b.solid, probe);
                  if (past > deepest) deepest = past;
                  summary.samples++;
                }
                if (deepest <= 0) continue;
                // One entry per pair of parts, whichever way round the deepest
                // reading came: an author fixes the pair, not the direction.
                const pair = [a.label, b.label].sort().join(' | ');
                const held = worst.get(pair);
                if (held && held.depth >= deepest) continue;
                worst.set(pair, {
                  a,
                  b,
                  depth: deepest,
                  clip: clip.name,
                  time,
                  duration: clip.duration,
                  frame,
                });
              }
          }
      }
    }
  } finally {
    disposeScene(model);
  }

  const found = [...worst.values()].sort((x, y) => y.depth - x.depth);
  summary.worst = found.length ? mm(found[0].depth) : 0;
  const deep = found.filter((hit) => mm(hit.depth) > WARN_MM);
  const where = (hit: Worst) =>
    `while "${hit.clip}" plays, deepest at ${hit.time.toFixed(2)}s of ${hit.duration.toFixed(2)}s (frame ${hit.frame + 1} of ${summary.frames})`;
  const depthOf = (hit: Worst) => {
    const depth = mm(hit.depth);
    return `${depth.toFixed(depth < 10 ? 1 : 0)} mm`;
  };
  // A fused or skinned asset is measured all the same — the number is the
  // number — but it is worth one note and never a fault. See the header.
  if (!summary.rigid) {
    const hit = deep[0];
    return {
      findings: hit
        ? [
            {
              severity: 'info',
              code: 'clip-through',
              part: hit.a.path,
              value: hit.depth,
              message: `"${hit.a.label}" passes ${depthOf(hit)} through "${hit.b.label}" ${where(hit)}${deep.length > 1 ? `, the deepest of ${deep.length} such pairs` : ''}. ${
                spec.surface
                  ? 'These parts are blended into one surface before anything is skinned, so what two of them do to each other is not what anybody sees'
                  : "A character's limbs are meant to sweep through its body"
              } — a note, not a fault.`,
            },
          ]
        : [],
      summary,
    };
  }
  const findings: Finding[] = deep.slice(0, MAX_FINDINGS).map((hit) => {
    const depth = mm(hit.depth);
    return {
      severity: depth > ERROR_MM ? ('error' as const) : ('warn' as const),
      code: 'clip-through',
      part: hit.a.path,
      value: hit.depth,
      threshold: WARN_MM / 1000 / scale,
      message: `"${hit.a.label}" drives ${depthOf(hit)} into "${hit.b.label}" ${where(hit)}. They hang off different bones, so nothing holds them apart: shorten the swing, move the pivot, or leave the clearance the arc needs.`,
      hint: { toward: hit.b.label },
    };
  });
  if (deep.length > MAX_FINDINGS)
    findings.push({
      severity: 'info',
      code: 'clip-through-more',
      value: deep.length - MAX_FINDINGS,
      message: `${deep.length - MAX_FINDINGS} more part pairs clip through each other; the ${MAX_FINDINGS} deepest are listed.`,
    });
  return { findings, summary };
}

/**
 * The static audit plus whatever the clips turn up.
 *
 * A wrapper rather than a step inside `auditModel` because the audit takes a
 * model and this takes a spec: a generator's model has no clips to sample and
 * a built model has already been rigged, which bakes the geometry the fields
 * were authored in out of reach.
 */
export function withClipFindings(
  audit: Audit,
  spec: AssetSpec,
  options: ClipOptions = {},
): Audit {
  const { findings } = auditClips(spec, options);
  if (!findings.length) return audit;
  const merged = [...audit.findings, ...findings];
  return { ok: merged.every((f) => f.severity !== 'error'), findings: merged };
}
