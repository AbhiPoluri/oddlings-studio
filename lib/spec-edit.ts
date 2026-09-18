import * as T from 'three';
import { parseSpec, type AssetSpec, type Joint, type Part } from './asset-spec';
import { JOINTS, defaultRig, type BoneName } from './asset-rig';

/**
 * Immutable edits on a spec's part tree, addressed by path.
 *
 * A path is the chain of child indices from the top of the spec, so `[2, 0]`
 * is the first child of the third top-level part — the same addressing the
 * builder stamps onto each mesh as `userData.specPath`.
 */
export type Path = number[];

/**
 * What an edit may supply. Looser than `Part` because the stored type has the
 * schema's defaults already applied — an editor changing one repeat field
 * should not have to restate `mode`, `axis` and `arc`. Every patch is
 * revalidated, so anything genuinely incomplete is rejected there.
 */
export type PartPatch = Partial<Omit<Part, 'repeat'>> & {
  repeat?: Partial<NonNullable<Part['repeat']>>;
};

export type FlatPart = {
  path: Path;
  part: Part;
  depth: number;
  /** How many meshes this one authored part expands into. */
  copies: number;
};

export function samePath(a: Path | null, b: Path | null) {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

export function partAt(spec: AssetSpec, path: Path): Part | undefined {
  let list: Part[] | undefined = spec.parts;
  let found: Part | undefined;
  for (const index of path) {
    found = list?.[index];
    if (!found) return undefined;
    list = found.children;
  }
  return found;
}

/** How many meshes a part contributes, counting its repeat and mirror. */
export function copiesOf(part: {
  repeat?: { count: number } | undefined;
  mirror?: unknown;
}) {
  return (part.repeat?.count ?? 1) * (part.mirror ? 2 : 1);
}

export function flatten(spec: AssetSpec): FlatPart[] {
  const out: FlatPart[] = [];
  const visit = (parts: Part[], prefix: Path, depth: number) => {
    parts.forEach((part, index) => {
      const path = [...prefix, index];
      out.push({ path, part, depth, copies: copiesOf(part) });
      if (part.children) visit(part.children, path, depth + 1);
    });
  };
  visit(spec.parts, [], 0);
  return out;
}

function mapList(
  parts: Part[],
  path: Path,
  change: (siblings: Part[], index: number) => Part[],
): Part[] {
  const [index, ...rest] = path;
  if (!rest.length) return change(parts, index);
  const target = parts[index];
  if (!target?.children) return parts;
  const next = [...parts];
  next[index] = {
    ...target,
    children: mapList(target.children, rest, change),
  };
  return next;
}

function withParts(spec: AssetSpec, parts: Part[]): AssetSpec {
  // Re-validate so an edit can never produce a spec the builder would reject.
  return parseSpec({ ...spec, parts });
}

export function updatePart(
  spec: AssetSpec,
  path: Path,
  patch: PartPatch,
): AssetSpec {
  return withParts(
    spec,
    mapList(spec.parts, path, (siblings, index) => {
      const next = [...siblings];
      const merged = { ...next[index], ...patch } as Record<string, unknown>;
      // An explicit undefined means "clear this field", not "store undefined",
      // which `.strict()` would otherwise reject on the next parse.
      for (const key of Object.keys(patch))
        if ((patch as Record<string, unknown>)[key] === undefined)
          delete merged[key];
      next[index] = merged as Part;
      return next;
    }),
  );
}

export function deletePart(spec: AssetSpec, path: Path): AssetSpec {
  if (path.length === 1 && spec.parts.length === 1)
    throw Error('A spec needs at least one part.');
  return withParts(
    spec,
    mapList(spec.parts, path, (siblings, index) =>
      siblings.filter((_, i) => i !== index),
    ),
  );
}

/** Copy a part and its whole branch in beside the original. */
export function duplicatePart(spec: AssetSpec, path: Path) {
  let inserted: Path = path;
  const parts = mapList(spec.parts, path, (siblings, index) => {
    const copy = structuredClone(siblings[index]);
    copy.name = `${copy.name ?? copy.shape} copy`.slice(0, 60);
    const next = [...siblings];
    next.splice(index + 1, 0, copy);
    inserted = [...path.slice(0, -1), index + 1];
    return next;
  });
  return { spec: withParts(spec, parts), path: inserted };
}

export function labelFor(part: Part) {
  return part.name ?? part.shape;
}

/* ------------------------------------------------------------------------ *
 * Direct manipulation: turning a world-space gizmo drag back into JSON.
 * ------------------------------------------------------------------------ */

export type Vec3 = [number, number, number];

/** Committed numbers are rounded so a hand-edited spec stays readable. */
const tidy = (n: number) => Math.round(n * 1000) / 1000;
const tidyVec = (v: T.Vector3): Vec3 => [tidy(v.x), tidy(v.y), tidy(v.z)];
const clamp = (n: number, low: number, high: number) =>
  Math.min(high, Math.max(low, n));

function quaternionOf(degrees: readonly number[] | undefined) {
  const d = degrees ?? [0, 0, 0];
  // 'XYZ' because `makeMesh`'s sibling `applyRotation` writes straight into
  // `object.rotation`, which is three's default Euler order.
  return new T.Quaternion().setFromEuler(
    new T.Euler(
      T.MathUtils.degToRad(d[0]),
      T.MathUtils.degToRad(d[1]),
      T.MathUtils.degToRad(d[2]),
      'XYZ',
    ),
  );
}

function degreesOf(q: T.Quaternion): Vec3 {
  const e = new T.Euler().setFromQuaternion(q, 'XYZ');
  return [
    tidy(T.MathUtils.radToDeg(e.x)),
    tidy(T.MathUtils.radToDeg(e.y)),
    tidy(T.MathUtils.radToDeg(e.z)),
  ];
}

/** One holder's local matrix, exactly as `buildPart` composes it. */
function holderMatrix(part: {
  position?: readonly number[];
  rotation?: readonly number[];
}) {
  const m = new T.Matrix4().makeRotationFromQuaternion(
    quaternionOf(part.rotation),
  );
  const p = part.position ?? [0, 0, 0];
  m.setPosition(p[0], p[1], p[2]);
  return m;
}

/**
 * The spaces a part's own numbers are written in.
 *
 * `parent` is the world matrix of the holder `position` and `rotation` are
 * read against; `holder` is the part's own frame, which is where a limb's
 * `from`/`to` live. A gizmo hands back world-space deltas, so every edit has
 * to come back through one of these — the same mistake `buildOnSurface`
 * documents, from the other direction.
 *
 * This composes the frame from the spec rather than measuring it off the built
 * scene, because two of the three build modes have no holder left to measure:
 * a rigged or jointed spec bakes every holder into the geometry and leaves
 * flat skinned meshes under one group, and surface mode fuses the whole model
 * into a single mesh. Only the plain faceted build keeps the hierarchy, and
 * there the two agree — which is what the unit test pins down.
 */
export function frameOf(spec: AssetSpec, path: Path) {
  const parent = new T.Matrix4().makeScale(spec.scale, spec.scale, spec.scale);
  let list: Part[] | undefined = spec.parts;
  let part: Part | undefined;
  for (let depth = 0; depth < path.length; depth++) {
    part = list?.[path[depth]];
    if (!part) break;
    if (depth < path.length - 1) parent.multiply(holderMatrix(part));
    list = part.children;
  }
  const holder = part
    ? parent.clone().multiply(holderMatrix(part))
    : parent.clone();
  return { parent, holder };
}

/**
 * True when `frameOf` describes where the part actually ended up.
 *
 * A `surface` repeat puts its copies wherever a raycast landed, and a repeat
 * or mirror anywhere above a part means the part exists several times over at
 * several transforms. The authored numbers still describe copy one, so an edit
 * is applied there — it just is not the only reading of the drag.
 */
export function frameIsExact(spec: AssetSpec, path: Path) {
  let list: Part[] | undefined = spec.parts;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const part: Part | undefined = list?.[path[depth]];
    if (!part) return false;
    if (part.repeat || part.mirror) return false;
    list = part.children;
  }
  return true;
}

/** One finished gizmo drag, in world space. Modes are exclusive. */
export type TransformDelta = {
  /** Where the gizmo sat when the drag began, in world space. */
  pivot: Vec3;
  /** Translate: how far the proxy moved. */
  move?: Vec3;
  /** Rotate: the world rotation picked up, as a quaternion `[x, y, z, w]`. */
  turn?: [number, number, number, number];
  /** Scale: ratios along the part's own axes. */
  grow?: Vec3;
  /**
   * The parent frame measured off the built scene, for the cases `frameOf`
   * cannot derive — a part hanging under a surface-scattered ancestor sits
   * wherever the raycast put its holder, and nothing in the spec says where.
   */
  parentWorld?: T.Matrix4;
};

/**
 * Read a world-space drag back into the fields the part is authored with.
 *
 * Everything is pivot-corrected: the gizmo turns and scales about its own
 * position, so patching only `rotation` — which pivots on the holder origin —
 * would swing a part that sits away from that origin right across the model.
 */
export function transformPatch(
  spec: AssetSpec,
  path: Path,
  delta: TransformDelta,
): PartPatch {
  const part = partAt(spec, path);
  if (!part) return {};
  const derived = frameOf(spec, path);
  const parent = delta.parentWorld
    ? delta.parentWorld.clone()
    : derived.parent;
  const holder = parent.clone().multiply(holderMatrix(part));
  const parentInverse = parent.clone().invert();
  const holderInverse = holder.clone().invert();
  const intoParent = new T.Matrix3().setFromMatrix4(parentInverse);
  const intoHolder = new T.Matrix3().setFromMatrix4(holderInverse);
  const parentTurn = new T.Quaternion();
  const holderTurn = new T.Quaternion();
  parent.decompose(new T.Vector3(), parentTurn, new T.Vector3());
  holder.decompose(new T.Vector3(), holderTurn, new T.Vector3());

  const limb = part.shape === 'limb';
  // A `surface` repeat throws `position` away — `buildOnSurface` rebuilds every
  // copy with `position: undefined` — so committing one would write a number
  // the builder never reads and the part would snap back on the next rebuild.
  const placed = part.repeat?.mode !== 'surface';
  const from = new T.Vector3(...(part.from ?? [0, 0, 0]));
  const to = new T.Vector3(...(part.to ?? [0, 1, 0]));
  const position = new T.Vector3(...(part.position ?? [0, 0, 0]));
  const patch: PartPatch = {};

  if (delta.move) {
    const world = new T.Vector3(...delta.move);
    if (limb) {
      const step = world.clone().applyMatrix3(intoHolder);
      patch.from = tidyVec(from.add(step));
      patch.to = tidyVec(to.add(step));
    } else if (placed) {
      patch.position = tidyVec(position.add(world.applyMatrix3(intoParent)));
    }
  }

  if (delta.turn) {
    const world = new T.Quaternion(...delta.turn).normalize();
    if (limb) {
      // Endpoints live inside the part's own frame, so the turn has to be
      // rebased there, and it pivots on the gizmo rather than on the holder.
      const local = holderTurn
        .clone()
        .invert()
        .multiply(world)
        .multiply(holderTurn);
      const pivot = new T.Vector3(...delta.pivot).applyMatrix4(holderInverse);
      patch.from = tidyVec(from.sub(pivot).applyQuaternion(local).add(pivot));
      patch.to = tidyVec(to.sub(pivot).applyQuaternion(local).add(pivot));
    } else {
      const local = parentTurn
        .clone()
        .invert()
        .multiply(world)
        .multiply(parentTurn);
      patch.rotation = degreesOf(
        local.clone().multiply(quaternionOf(part.rotation)),
      );
      if (placed) {
        const pivot = new T.Vector3(...delta.pivot).applyMatrix4(parentInverse);
        patch.position = tidyVec(
          position.sub(pivot).applyQuaternion(local).add(pivot),
        );
      }
    }
  }

  if (delta.grow) {
    const [gx, gy, gz] = delta.grow;
    if (limb) {
      // A limb is a tube between two points: only its thickness is a scale,
      // and a non-uniform one would have nothing to act on.
      patch.radius = clamp(tidy((part.radius ?? 0.1) * ((gx + gy + gz) / 3)), 0.001, 50);
    } else {
      const size = part.size ?? [1, 1, 1];
      patch.size = [
        Math.max(0.001, tidy(size[0] * gx)),
        Math.max(0.001, tidy(size[1] * gy)),
        Math.max(0.001, tidy(size[2] * gz)),
      ];
      if (placed) {
        // The gizmo scales along the part's own axes, so the offset from the
        // pivot has to be stretched in those axes too, not in the parent's.
        const own = quaternionOf(part.rotation);
        const pivot = new T.Vector3(...delta.pivot).applyMatrix4(parentInverse);
        const offset = position
          .sub(pivot)
          .applyQuaternion(own.clone().invert());
        patch.position = tidyVec(
          offset
            .set(offset.x * gx, offset.y * gy, offset.z * gz)
            .applyQuaternion(own)
            .add(pivot),
        );
      }
    }
  }

  return patch;
}

/** `transformPatch`, applied. The viewport patches; tests and tools edit. */
export function applyTransform(
  spec: AssetSpec,
  path: Path,
  delta: TransformDelta,
): AssetSpec {
  return updatePart(spec, path, transformPatch(spec, path, delta));
}

/* ------------------------------------------------------------------------ *
 * Rigs: the skeleton a spec declares, made hand-editable.
 *
 * A spec carries at most one skeleton — `rig` for the 14-bone humanoid or
 * `joints` for hand-placed pivots — and the schema refuses both at once. Every
 * helper below re-validates through `parseSpec`, so an editor wired to them
 * cannot produce a spec the builder would reject: a cycle, a parent that is a
 * typo, or two halves of one clip disagreeing about its length all come back
 * as a thrown message the panel can show beside the joint that caused it.
 * ------------------------------------------------------------------------ */

/** Which of the two mutually exclusive skeletons a spec declares, if either. */
export type RigKind = 'none' | 'rig' | 'joints';

export function rigKindOf(spec: AssetSpec): RigKind {
  if (spec.rig) return 'rig';
  if (spec.joints?.length) return 'joints';
  return 'none';
}

/** What a selection in the studio is: one authored part, or one bone. */
export type Selection =
  | { kind: 'part'; path: Path }
  | { kind: 'bone'; name: string }
  | null;

/** The part path a selection names, or null when it names a bone or nothing. */
export function selectedPath(selection: Selection): Path | null {
  return selection?.kind === 'part' ? selection.path : null;
}

/** The bone a selection names, or null when it names a part or nothing. */
export function selectedBone(selection: Selection): string | null {
  return selection?.kind === 'bone' ? selection.name : null;
}

export function sameSelection(a: Selection, b: Selection) {
  if (!a || !b) return a === b;
  if (a.kind === 'part' && b.kind === 'part') return samePath(a.path, b.path);
  if (a.kind === 'bone' && b.kind === 'bone') return a.name === b.name;
  return false;
}

/**
 * Roughly where the model sits, in unscaled model space.
 *
 * Only ever used to seed a new joint somewhere the author can see it, so the
 * average of the part holders is close enough — and it costs nothing, where
 * building the model to measure a real bounding box costs every mesh.
 */
function specCentre(spec: AssetSpec): Vec3 {
  const sum = new T.Vector3();
  const rows = flatten(spec);
  if (!rows.length) return [0, 0, 0];
  const at = new T.Vector3();
  for (const row of rows)
    sum.add(at.setFromMatrixPosition(frameOf(spec, row.path).holder));
  // `frameOf` starts from the display scale; joint positions are written
  // in the unscaled space part positions use.
  sum.divideScalar(rows.length * spec.scale);
  return tidyVec(sum);
}

/**
 * A part name a joint may legally bind to, naming one if it has to.
 *
 * `binds` is by name and `jointBinder` refuses a name two parts share, so a
 * spec whose parts are all anonymous has nothing to bind and seeding a joint
 * on it would fail at build time rather than here.
 */
function firstBindable(spec: AssetSpec): { parts: Part[]; name: string } {
  const rows = flatten(spec);
  const tally = new Map<string, number>();
  for (const row of rows)
    if (row.part.name) tally.set(row.part.name, (tally.get(row.part.name) ?? 0) + 1);
  const unique = rows.find((row) => row.part.name && tally.get(row.part.name) === 1);
  if (unique?.part.name) return { parts: spec.parts, name: unique.part.name };
  const first = rows[0];
  let name = first.part.shape as string;
  for (let n = 2; tally.has(name); n++) name = `${first.part.shape} ${n}`;
  return { parts: updatePart(spec, first.path, { name }).parts, name };
}

/**
 * A skeleton this spec used to have, kept aside while another one is in play.
 *
 * The editor stashes whichever block a switch drops, so the three-way choice
 * stops being destructive: a rig with twenty-five hand-placed joints used to
 * evaporate the moment someone clicked None to look at the bare mesh.
 */
export type RememberedRig = {
  rig?: AssetSpec['rig'];
  joints?: AssetSpec['joints'];
};

/**
 * The remembered joints that still describe this spec, re-parented to close
 * any gaps, or an empty list when none of them do.
 *
 * A bind resolves exactly when one part carries that name — `jointBinder`'s
 * rule, and the reason a joint can stop being valid without anyone touching it:
 * rename the part it carried, or duplicate it, and the bind no longer names one
 * thing. Only those joints are dropped. The survivors keep their pivots, their
 * spins and their clips, and anything left parented to a dropped joint adopts
 * that joint's parent, the same way `removeJoint` closes a chain up.
 */
function restorableJoints(
  spec: AssetSpec,
  remembered: NonNullable<AssetSpec['joints']>,
): NonNullable<AssetSpec['joints']> {
  const tally = new Map<string, number>();
  for (const row of flatten(spec))
    if (row.part.name) tally.set(row.part.name, (tally.get(row.part.name) ?? 0) + 1);
  const resolves = (name: string) => tally.get(name) === 1;

  const kept = remembered.filter(
    (joint) => joint.binds.length > 0 && joint.binds.every(resolves),
  );
  const alive = new Set(kept.map((joint) => joint.name));
  /** The nearest ancestor that survived, or undefined for the root bone. */
  const anchor = (name: string | undefined, seen = new Set<string>()): string | undefined => {
    if (name === undefined || alive.has(name)) return name;
    if (seen.has(name)) return undefined;
    seen.add(name);
    return anchor(
      remembered.find((joint) => joint.name === name)?.parent,
      seen,
    );
  };
  return kept.map((joint) => {
    const parent = anchor(joint.parent);
    if (parent === joint.parent) return joint;
    const moved = { ...joint } as Record<string, unknown>;
    // `undefined`, never the string "Root": the schema rejects that spelling
    // because omitting the field is what hangs a joint off the root bone.
    if (parent === undefined) delete moved.parent;
    else moved.parent = parent;
    return moved as (typeof kept)[number];
  });
}

/**
 * Swap which skeleton a spec has, clearing the other.
 *
 * Switching to `joints` seeds one, because an empty joint list is not a rig —
 * every consumer reads `joints?.length` — and an author who picked Joints
 * wants something to drag, not an empty panel.
 *
 * `remembered` is what makes the choice reversible. Clicking None to look at
 * the mesh and then clicking back used to hand you a fresh single pivot, which
 * is the same as deleting the rig: the seeded pivot is now only the fallback
 * for when there is nothing to put back, or when the parts have moved so far
 * that what was remembered no longer describes them.
 */
export function setRigKind(
  spec: AssetSpec,
  kind: RigKind,
  remembered?: RememberedRig,
): AssetSpec {
  if (kind === rigKindOf(spec)) return spec;
  const bare = { ...spec, rig: undefined, joints: undefined };
  if (kind === 'none') return parseSpec(bare);
  if (kind === 'rig') {
    // Measurements and pinned bones name nothing outside themselves, so the
    // only thing that can go wrong is a stash from an incompatible version.
    if (remembered?.rig)
      try {
        return parseSpec({ ...bare, rig: remembered.rig });
      } catch {
        // Fall through to a default rig rather than refusing the switch.
      }
    return parseSpec({ ...bare, rig: { ...defaultRig } });
  }
  if (remembered?.joints?.length) {
    const restored = restorableJoints(spec, remembered.joints);
    if (restored.length)
      try {
        return parseSpec({ ...bare, joints: restored });
      } catch {
        // Same: a stash that will not parse is not worth an error message
        // about a rig the author is trying to create, not to repair.
      }
  }
  const seeded = firstBindable(spec);
  return parseSpec({
    ...bare,
    parts: seeded.parts,
    joints: [{ name: 'Pivot', at: specCentre(spec), binds: [seeded.name] }],
  });
}

/**
 * What one joint edit may supply.
 *
 * `spin` merges field by field so the panel can change one number without
 * restating the rest, and an explicit `undefined` for any key clears it —
 * the same rule `updatePart` follows, and the only way to say "this joint
 * hangs off the root" (the schema rejects the literal parent `"Root"`).
 */
export type JointPatch = Partial<Omit<Joint, 'spin'>> & {
  spin?: Partial<NonNullable<Joint['spin']>>;
};

/** A joint as an editor supplies it: every field optional, defaults applied on parse. */
export type NewJoint = {
  name?: string;
  at?: Vec3;
  parent?: string;
  binds?: string[];
  spin?: Partial<NonNullable<Joint['spin']>>;
};

/** One authored clip: its name, its length, and which joints are in it. */
export type ClipRow = { name: string; seconds: number; members: number[] };

/**
 * The clips a joints rig authors, by index rather than by track.
 *
 * `jointClips` in `asset-joints` answers the same question in three.js terms;
 * this answers it in spec terms, which is what a panel needs to offer "join an
 * existing clip" and to keep every member of one clip the same length.
 */
export function clipTable(spec: AssetSpec): ClipRow[] {
  const rows: ClipRow[] = [];
  (spec.joints ?? []).forEach((joint, index) => {
    if (!joint.spin) return;
    const name = joint.spin.clip ?? joint.name;
    const row = rows.find((r) => r.name === name);
    if (row) row.members.push(index);
    else rows.push({ name, seconds: joint.spin.seconds, members: [index] });
  });
  return rows;
}

function jointList(spec: AssetSpec) {
  return spec.joints ?? [];
}

function withJoints(spec: AssetSpec, joints: unknown[]): AssetSpec {
  return parseSpec({ ...spec, joints });
}

export function updateJoint(
  spec: AssetSpec,
  index: number,
  patch: JointPatch,
): AssetSpec {
  const list = jointList(spec);
  const current = list[index];
  if (!current) throw Error(`This spec has no joint ${index}.`);
  const merged = { ...current, ...patch } as Record<string, unknown>;
  if (patch.spin && current.spin) merged.spin = { ...current.spin, ...patch.spin };
  for (const key of Object.keys(patch))
    if ((patch as Record<string, unknown>)[key] === undefined) delete merged[key];
  if (merged.at) merged.at = tidyVec(new T.Vector3(...(merged.at as Vec3)));

  const spin = merged.spin as NonNullable<Joint['spin']> | undefined;
  const movedClip =
    (patch.spin && 'clip' in patch.spin) ||
    ('name' in patch && patch.name !== current.name);
  // Joining a clip means adopting its length: one clip has one duration, and
  // the schema refuses a spec whose members disagree about it. An edit that
  // states `seconds` outright is left alone — that is `setClipSeconds`' job.
  if (spin && movedClip && !(patch.spin && 'seconds' in patch.spin)) {
    const clip = spin.clip ?? (merged.name as string);
    const held = clipTable(spec).find(
      (row) => row.name === clip && row.members.some((m) => m !== index),
    );
    if (held && held.seconds !== spin.seconds)
      merged.spin = { ...spin, seconds: held.seconds };
  }

  const next = [...list];
  next[index] = merged as Joint;

  // A rename carries the chain with it. A joint's name is also what its
  // children point at and what its clip is called by default, so renaming one
  // in place would either orphan them — a parse error the author cannot get
  // out of — or quietly split one mechanism across two clips.
  const renamed = merged.name !== current.name;
  if (renamed) {
    const to = merged.name as string;
    next.forEach((joint, at) => {
      if (at !== index && joint.parent === current.name)
        next[at] = { ...joint, parent: to };
    });
    const spun = next[index].spin;
    const shared = list.some(
      (joint, at) =>
        at !== index && joint.spin && (joint.spin.clip ?? joint.name) === current.name,
    );
    if (spun && !spun.clip && shared)
      next[index] = { ...next[index], spin: { ...spun, clip: current.name } };
  }
  return withJoints(spec, next);
}

/** Append a joint. Its index is the previous joint count. */
export function addJoint(spec: AssetSpec, joint: NewJoint = {}): AssetSpec {
  const list = jointList(spec);
  if (list.length >= 16)
    throw Error('A spec carries at most 16 joints.');
  const taken = new Set(list.map((j) => j.name));
  const wanted = joint.name ?? 'Pivot';
  let name = wanted;
  for (let n = 2; taken.has(name) || name === 'Root'; n++) name = `${wanted} ${n}`;
  const seeded = firstBindable(spec);
  const binds = joint.binds?.length ? joint.binds : [seeded.name];
  let spin = joint.spin;
  if (spin) {
    const held = clipTable(spec).find((row) => row.name === (spin!.clip ?? name));
    if (held) spin = { ...spin, seconds: held.seconds };
  }
  const next: Record<string, unknown> = {
    name,
    at: joint.at ?? specCentre(spec),
    binds,
  };
  if (joint.parent !== undefined) next.parent = joint.parent;
  if (spin) next.spin = spin;
  return parseSpec({ ...spec, parts: seeded.parts, joints: [...list, next] });
}

/**
 * Drop a joint, adopting its children onto its own parent.
 *
 * Leaving them naming a joint that no longer exists is a parse error, and
 * deleting them with it would throw away whatever they carry — so the chain
 * closes up instead, exactly as it reads on screen.
 */
export function removeJoint(spec: AssetSpec, index: number): AssetSpec {
  const list = jointList(spec);
  const gone = list[index];
  if (!gone) throw Error(`This spec has no joint ${index}.`);
  if (list.length === 1)
    throw Error(
      'A joints rig needs at least one joint. Set the rig to None to remove the skeleton.',
    );
  const next = list
    .filter((_, i) => i !== index)
    .map((joint) => {
      if (joint.parent !== gone.name) return joint;
      const moved = { ...joint } as Record<string, unknown>;
      // `undefined`, never the string "Root": the schema rejects that spelling
      // because omitting the field is what hangs a joint off the root bone.
      if (gone.parent === undefined) delete moved.parent;
      else moved.parent = gone.parent;
      return moved;
    });
  return withJoints(spec, next);
}

/** Give every joint in a clip the same length, which is the only legal shape. */
export function setClipSeconds(
  spec: AssetSpec,
  clip: string,
  seconds: number,
): AssetSpec {
  const next = jointList(spec).map((joint) =>
    joint.spin && (joint.spin.clip ?? joint.name) === clip
      ? { ...joint, spin: { ...joint.spin, seconds } }
      : joint,
  );
  return withJoints(spec, next);
}

/**
 * Change one of the three body measurements, keeping any bone overrides.
 *
 * Re-validated like every other rig edit, so a slider dragged past what the
 * schema allows comes back as a message rather than as a spec the builder
 * would refuse the next time anything touched it.
 */
export function setRigSettings(
  spec: AssetSpec,
  patch: Partial<Pick<NonNullable<AssetSpec['rig']>, 'hipHeight' | 'headPivot' | 'shoulderWidth'>>,
): AssetSpec {
  if (!spec.rig) throw Error('This spec has no body rig to measure.');
  return parseSpec({ ...spec, rig: { ...spec.rig, ...patch } });
}

/**
 * Pin one humanoid bone to an absolute model-space position, or let the three
 * measurements place it again.
 *
 * Clearing the last override drops the `bones` block entirely, so a rig the
 * author has reset reads back as the three numbers it started as.
 */
export function setBoneOverride(
  spec: AssetSpec,
  name: BoneName,
  at: Vec3 | undefined,
): AssetSpec {
  if (!spec.rig)
    throw Error('This spec has no body rig, so it has no bones to override.');
  const bones: Partial<Record<BoneName, Vec3>> = { ...spec.rig.bones };
  if (at) bones[name] = tidyVec(new T.Vector3(...at));
  else delete bones[name];
  return parseSpec({
    ...spec,
    rig: {
      ...spec.rig,
      bones: Object.keys(bones).length ? bones : undefined,
    },
  });
}

/**
 * Move a bone of either kind of rig to an absolute model-space position.
 *
 * The two rigs write it to different places — a joint owns its `at`, a
 * humanoid bone becomes an entry in `rig.bones` — and a dragged handle in the
 * viewport should not have to know which kind it just grabbed.
 */
export function moveBone(spec: AssetSpec, name: string, at: Vec3): AssetSpec {
  if (spec.rig) {
    if (!(JOINTS as readonly string[]).includes(name))
      throw Error(`"${name}" is not one of the 14 bones a body rig has.`);
    return setBoneOverride(spec, name as BoneName, at);
  }
  if (name === 'Root')
    throw Error(
      'Root is the static bone a joints rig hangs off. It always sits at the origin.',
    );
  const index = jointList(spec).findIndex((joint) => joint.name === name);
  if (index < 0) throw Error(`No joint is called "${name}".`);
  return updateJoint(spec, index, { at });
}

/**
 * Which joint a validation message is about, so the panel can show it there.
 *
 * `parseSpec` folds the issue path into its message (`… at joints.1.parent: …`),
 * which is the whole of what the editor needs to put a cycle or a clash beside
 * the row that caused it rather than in a status bar the eye has left.
 */
export function jointErrorIndex(message: string): number | null {
  const found = /\bjoints\.(\d+)\b/.exec(message);
  return found ? Number(found[1]) : null;
}

/* ------------------------------------------------------------------------ *
 * Panel helpers: what an outliner needs to know that the spec only implies.
 * ------------------------------------------------------------------------ */

/**
 * A path as a stable string key — `[1, 0]` reads `"1.0"`.
 *
 * The same spelling `auditModel` takes its labels in, so a finding, a row and
 * a changed-since-last-build mark can all be looked up with one key rather
 * than with three slightly different ones that drift apart.
 */
export function pathKey(path: Path): string {
  return path.join('.');
}

/** True when `path` is, or sits under, `bound` — the rule bindings inherit by. */
function under(path: Path, bound: Path) {
  if (path.length < bound.length) return false;
  for (let i = 0; i < bound.length; i++) if (path[i] !== bound[i]) return false;
  return true;
}

/**
 * Which joint carries each part, by path key.
 *
 * `jointBinder` answers the same question for the builder and throws on a bind
 * that names nothing or names two parts, because a model that cannot be skinned
 * must not be built. A panel is the other case: it draws specs mid-edit, where
 * a half-typed bind is a message to show beside the joint rather than a reason
 * to blank the tree — so an unresolvable bind is simply skipped here.
 *
 * Deeper bindings win and children inherit, matching what the builder does, so
 * the badge on a row says which bone that row will actually follow.
 */
export function jointBindingsByPath(spec: AssetSpec): Map<string, string> {
  const out = new Map<string, string>();
  const joints = spec.joints ?? [];
  if (!joints.length) return out;
  const rows = flatten(spec);
  const byName = new Map<string, Path[]>();
  for (const row of rows)
    if (row.part.name)
      byName.set(row.part.name, [...(byName.get(row.part.name) ?? []), row.path]);

  const bound: { path: Path; joint: string }[] = [];
  for (const joint of joints)
    for (const name of joint.binds) {
      const found = byName.get(name);
      if (found?.length === 1) bound.push({ path: found[0], joint: joint.name });
    }
  bound.sort((a, b) => b.path.length - a.path.length);

  for (const row of rows) {
    const owner = bound.find((entry) => under(row.path, entry.path));
    if (owner) out.set(pathKey(row.path), owner.joint);
  }
  return out;
}

/**
 * Structural equality, treating an absent key and an explicit `undefined` as
 * the same thing.
 *
 * `JSON.stringify` would be shorter and wrong: `updatePart` spreads a patch
 * over a part, which can reorder keys, so a no-op edit would come back as a
 * change and light up the whole tree.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, i) => same(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!same(left[key], right[key])) return false;
  return true;
}

export type SpecDiff = {
  /** Path keys present in `b` and not in `a`. */
  added: Set<string>;
  /** Path keys present in `a` and not in `b`. */
  removed: Set<string>;
  /** Path keys whose own fields differ — children are compared on their own rows. */
  changed: Set<string>;
};

/**
 * What moved between two versions of a spec, by path key.
 *
 * Addressed by path rather than by identity because a path is the only handle
 * a part has: two rebuilds of the same spec share no objects, and a name is
 * optional and duplicable. Each part is compared without its `children`, so an
 * edit deep in a branch marks that row and not every ancestor above it — which
 * is what makes the mark worth showing at all.
 */
export function diffSpecs(a: AssetSpec, b: AssetSpec): SpecDiff {
  const before = new Map(
    flatten(a).map((row) => [pathKey(row.path), row.part] as const),
  );
  const after = new Map(
    flatten(b).map((row) => [pathKey(row.path), row.part] as const),
  );
  const diff: SpecDiff = {
    added: new Set<string>(),
    removed: new Set<string>(),
    changed: new Set<string>(),
  };
  const bare = ({ children: _children, ...rest }: Part) => rest;
  for (const [key, part] of after) {
    const was = before.get(key);
    if (!was) diff.added.add(key);
    else if (!same(bare(was), bare(part))) diff.changed.add(key);
  }
  for (const key of before.keys()) if (!after.has(key)) diff.removed.add(key);
  return diff;
}
