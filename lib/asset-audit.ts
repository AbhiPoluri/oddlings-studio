import * as T from 'three';
import { AUTO_WEIGHT, autoBone } from './asset-rig';

/**
 * Geometry checks that run on a finished model.
 *
 * The point is to catch, from numbers alone, the mistakes that otherwise only
 * surface when a human looks at the thing from an angle nobody rendered: parts
 * hanging in mid-air, a model that fell into pieces, a character too big for
 * the rig's fixed weighting bands.
 *
 * Every check has to be worth acting on. A check that cries wolf trains its
 * reader to skip the whole report, which is the failure this is meant to
 * design out — so anything with a high false-positive rate is deliberately
 * absent. See the closing note.
 */

export type Severity = 'error' | 'warn' | 'info';

export type Finding = {
  severity: Severity;
  /** Stable machine-readable id, e.g. `detached-part`. */
  code: string;
  message: string;
  /** The authored spec part this concerns, when the model came from a spec. */
  part?: number[];
  value?: number;
  threshold?: number;
};

export type Audit = {
  /** True when nothing was reported as an error. */
  ok: boolean;
  findings: Finding[];
};

/**
 * Surface samples kept per mesh. Low-poly parts are sampled exhaustively; the
 * cap only bites on dense geometry, where a subset tells "touching" from
 * "floating" just as well.
 */
const MESH_SAMPLES = 140;

type Piece = {
  /** One mesh — one copy of an authored part. */
  id: number;
  /** The authored part it came from; copies of one part share this. */
  partKey: string;
  path?: number[];
  points: T.Vector3[];
  /** World-space faces, so contact can be measured against the surface. */
  faces: T.Triangle[];
  box: T.Box3;
  centre: T.Vector3;
  radius: number;
  rigPart?: string;
};

/**
 * Sample points across a mesh's surface, not only at its corners.
 *
 * Two solids that interpenetrate share no vertices — a blossom pushed into a
 * leafy dome has its corners centimetres from the dome's corners even though
 * the surfaces cross. Measuring corner to corner therefore reports every part
 * of every model as detached. Face centroids and edge midpoints put samples
 * where the surfaces actually meet.
 */
function surfaceOf(mesh: T.Mesh) {
  const position = mesh.geometry.attributes.position as T.BufferAttribute;
  const triangles = Math.floor(position.count / 3);
  // Points are sampled; faces never are. Distance and containment are both
  // measured against the surface, and a surface missing four faces in five is
  // a sieve: rays pass through the gaps and the parity test lies.
  const step = Math.max(1, Math.ceil(triangles / (MESH_SAMPLES / 7)));
  const points: T.Vector3[] = [];
  const faces: T.Triangle[] = [];
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let t = 0; t < triangles; t++) {
    const i = t * 3;
    a.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, i + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, i + 2).applyMatrix4(mesh.matrixWorld);
    faces.push(new T.Triangle(a.clone(), b.clone(), c.clone()));
    if (t % step) continue;
    points.push(
      a.clone(),
      b.clone(),
      c.clone(),
      new T.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3),
      new T.Vector3().addVectors(a, b).multiplyScalar(0.5),
      new T.Vector3().addVectors(b, c).multiplyScalar(0.5),
      new T.Vector3().addVectors(a, c).multiplyScalar(0.5),
    );
  }
  return { points, faces };
}

/**
 * One entry per mesh, because a repeat makes many copies of one part and they
 * do not stand or fall together: four blossoms can sit in the foliage while
 * two hang in the air above it. Auditing the part as a whole would let the
 * attached copies vouch for the floating ones.
 */
function collect(model: T.Object3D) {
  const pieces: Piece[] = [];
  let grouped = false;
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const path = o.userData.specPath as number[] | undefined;
    if (path) grouped = true;
    const { points, faces } = surfaceOf(o);
    if (!points.length) return;
    const box = new T.Box3().setFromPoints(points);
    pieces.push({
      id: pieces.length,
      partKey: path ? path.join('.') : `mesh-${pieces.length}`,
      path,
      points,
      faces,
      box,
      centre: box.getCenter(new T.Vector3()),
      radius: box.getSize(new T.Vector3()).length() / 2,
      rigPart: o.userData.rigPart as string | undefined,
    });
  });
  return { pieces, grouped };
}

/**
 * What the rig will actually bind, as points in the model's own space.
 *
 * A faceted asset binds a whole mesh to one bone, so one sample per mesh says
 * everything. A surface asset is a single mesh covering the entire body and
 * binds vertex by vertex, so asking it for one bone would answer for the
 * creature's centre of mass and nothing else — every leg check would fail on a
 * model whose legs are bound perfectly well. Sampling vertices instead keeps
 * the rig findings measuring the binding rather than the backend.
 */
type RigSample = {
  x: number;
  y: number;
  minY: number;
  maxY: number;
  rigPart?: string;
};

function rigSamples(model: T.Object3D, scale: number) {
  const samples: RigSample[] = [];
  let perVertex = false;
  const point = new T.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!(o instanceof T.Mesh)) return;
    const bound = o.geometry.userData.rigParts as
      | (string | undefined)[]
      | undefined;
    if (bound) {
      perVertex = true;
      const position = o.geometry.attributes.position as T.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        const y = point.y / scale;
        samples.push({
          x: point.x / scale,
          y,
          minY: y,
          maxY: y,
          rigPart: bound[i],
        });
      }
      return;
    }
    const box = new T.Box3().setFromObject(o);
    const centre = box.getCenter(new T.Vector3());
    samples.push({
      x: centre.x / scale,
      y: centre.y / scale,
      minY: box.min.y / scale,
      maxY: box.max.y / scale,
      rigPart: o.userData.rigPart as string | undefined,
    });
  });
  return { samples, unit: perVertex ? 'vertex' : 'mesh' };
}

/** Shortest distance between two axis-aligned boxes; zero when they overlap. */
function boxDistance(a: T.Box3, b: T.Box3) {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
}

/**
 * Do these two meshes touch?
 *
 * Measured from the smaller mesh's sample points to the larger mesh's faces,
 * never point to point. Samples are capped per mesh, so a 2 m tower carries
 * them 20 cm apart while a 16 cm window carries them 2 cm apart; comparing the
 * two sets of points would call an embedded window detached simply because the
 * tower had no sample nearby. Distance to the surface itself does not care how
 * finely that surface was sampled.
 *
 * The tolerance scales with the smaller mesh, because a single absolute
 * epsilon cannot serve a model holding both a 2 mm bead and a 2 m tower.
 */
function touching(a: Piece, b: Piece) {
  const tolerance = Math.max(Math.min(a.radius, b.radius) * 0.25, 0.002);
  if (boxDistance(a.box, b.box) > tolerance) return false;
  const [small, large] = a.radius <= b.radius ? [a, b] : [b, a];
  const closest = new T.Vector3();
  for (const point of small.points)
    for (const face of large.faces) {
      face.closestPointToPoint(point, closest);
      if (closest.distanceTo(point) <= tolerance) return true;
    }
  // Surfaces can be far apart while the parts could not be more attached: a
  // bud pushed deep into a bush sits centimetres from the foliage's outer
  // shell. Distance alone would call that detached and push authors towards
  // parts that merely graze the body.
  return enclosedBy(small, large);
}

/**
 * Is this part inside that one? Counts how many faces a ray from its centre
 * crosses on the way out — an odd number means it started within a closed
 * surface, which every primitive here is.
 */
function enclosedBy(inner: Piece, outer: Piece) {
  if (!outer.box.containsPoint(inner.centre)) return false;
  const ray = new T.Ray(inner.centre, new T.Vector3(1, 0, 0));
  const hit = new T.Vector3();
  let crossings = 0;
  for (const face of outer.faces)
    if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) crossings++;
  return crossings % 2 === 1;
}

/**
 * Split one mesh into its connected shells.
 *
 * A surface-mode asset is a single mesh, so the mesh-to-mesh contact test above
 * has nothing to compare and would cheerfully report that the model hangs
 * together while half of it floats. Topology answers the question exactly
 * instead: two vertices belong to the same shell when a chain of triangles
 * joins them, with no distance tolerance to guess at.
 */
function shellsOf(geometry: T.BufferGeometry) {
  const index = geometry.index;
  const count = (geometry.attributes.position as T.BufferAttribute).count;
  if (!index) return [];

  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < index.count; i += 3) {
    const a = find(index.getX(i));
    const b = find(index.getX(i + 1));
    const c = find(index.getX(i + 2));
    if (a !== b) parent[b] = a;
    if (a !== c) parent[find(c)] = a;
  }
  const shells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const group = shells.get(root);
    if (group) group.push(i);
    else shells.set(root, [i]);
  }
  return [...shells.values()].sort((a, b) => b.length - a.length);
}

/**
 * Edges used by exactly one triangle — the rim of a hole.
 *
 * An open shell is the one surface defect an engine cannot work around: it has
 * no inside, so it shadows wrong, it cannot be a collider, and a physics solver
 * will happily pour things through it.
 */
function openEdges(geometry: T.BufferGeometry) {
  const index = geometry.index;
  if (!index) return 0;
  const uses = new Map<number, number>();
  const count = (geometry.attributes.position as T.BufferAttribute).count;
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? a * count + b : b * count + a;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of uses.values()) if (n === 1) open++;
  return open;
}

/** Group meshes into chunks that hang together. */
function componentsOf(pieces: Piece[]) {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++) {
      if (find(i) === find(j)) continue;
      if (touching(pieces[i], pieces[j])) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Piece[]>();
  pieces.forEach((piece, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), piece]);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

export type AuditOptions = {
  /** True when the model is rigged, which enables the weighting checks. */
  rigged?: boolean;
  /**
   * The spec's display scale. Skinning happens before it is applied, so the
   * rig's fixed height bands must be compared against unscaled geometry — a
   * 1.2 m character shown at scale 2 is still a 1.2 m character to the rigger.
   */
  scale?: number;
  /** Part paths to readable names, for the messages. */
  labels?: Map<string, string>;
};

export function auditModel(
  model: T.Object3D,
  options: AuditOptions = {},
): Audit {
  const findings: Finding[] = [];
  const { pieces, grouped } = collect(model);
  const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
  const name = (key: string) => options.labels?.get(key) ?? key;

  if (!pieces.length) {
    findings.push({
      severity: 'error',
      code: 'empty',
      message: 'This asset contains no meshes.',
    });
    return { ok: false, findings };
  }

  const tiny = new Map<string, number>();
  for (const piece of pieces)
    if (piece.radius < 1e-3)
      tiny.set(piece.partKey, (tiny.get(piece.partKey) ?? 0) + 1);
  for (const [key, count] of tiny)
    findings.push({
      severity: 'error',
      code: 'degenerate-part',
      part: pieces.find((p) => p.partKey === key)?.path,
      value: count,
      message: `"${name(key)}" is too small to see${count > 1 ? ` (${count} copies)` : ''}.`,
    });

  // --- detachment -------------------------------------------------------
  // Only meaningful for spec-built models. A generator's meshes are placed by
  // hand-tuned code, and reporting on those would be noise, not signal.
  if (grouped && pieces.length > 1) {
    const components = componentsOf(pieces);
    const [body, ...loose] = components;
    if (loose.length) {
      const strays = loose.flat();
      const stray = new Map<string, number>();
      for (const piece of strays)
        stray.set(piece.partKey, (stray.get(piece.partKey) ?? 0) + 1);
      const total = new Map<string, number>();
      for (const piece of pieces)
        total.set(piece.partKey, (total.get(piece.partKey) ?? 0) + 1);
      for (const [key, count] of stray)
        findings.push({
          severity: 'error',
          code: 'detached-part',
          part: pieces.find((p) => p.partKey === key)?.path,
          value: count,
          threshold: total.get(key),
          message: `${count} of ${total.get(key)} "${name(key)}" ${count === 1 ? 'sits' : 'sit'} in mid-air, touching nothing. Move ${count === 1 ? 'it' : 'them'} into the body, or place the part against a surface instead of at a fixed radius.`,
        });
      findings.push({
        severity: 'info',
        code: 'components',
        value: components.length,
        message: `${body.length} of ${pieces.length} meshes form the main body; ${strays.length} float free across ${loose.length} piece${loose.length === 1 ? '' : 's'}.`,
      });
    } else
      findings.push({
        severity: 'info',
        code: 'connected',
        message: `All ${pieces.length} meshes hang together.`,
      });
  }

  // --- one mesh, but is it one piece? ------------------------------------
  model.traverse((object) => {
    if (!(object instanceof T.Mesh) || !object.userData.surface) return;
    const open = openEdges(object.geometry);
    if (open)
      findings.push({
        severity: 'error',
        code: 'open-shell',
        value: open,
        message: `The mesh has ${open} edges with only one triangle on them, so it is not closed. A shell with holes has no inside: it shadows wrong and cannot be used as a collider.`,
      });
    const shells = shellsOf(object.geometry);
    if (shells.length < 2) {
      findings.push({
        severity: 'info',
        code: 'one-shell',
        message: `The mesh is a single connected shell of ${shells[0]?.length ?? 0} vertices.`,
      });
      return;
    }
    const owners = object.geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (number[] | undefined)[] }
      | undefined;
    for (const shell of shells.slice(1)) {
      const parts = new Set<string>();
      let path: number[] | undefined;
      if (owners)
        for (const vertex of shell) {
          const from = owners.paths[owners.index[vertex]];
          if (!from) continue;
          path ??= from;
          parts.add(name(from.join('.')));
        }
      const made = parts.size
        ? ` It is made of ${[...parts].slice(0, 4).join(', ')}.`
        : '';
      findings.push({
        severity: 'error',
        code: 'detached-shell',
        part: path,
        value: shell.length,
        message: `The mesh falls into ${shells.length} separate shells; one of ${shell.length} vertices floats free of the body.${made} Raise the blend so the parts fuse, or move them into contact.`,
      });
    }
  });

  // --- parts that produced no surface -----------------------------------
  // Colour and rig binding go to the nearest primitive per vertex, so a part
  // that is present but recessed inside its neighbour owns nothing: it costs
  // build time, it is in the spec, and it is invisible. Authors lose whole
  // iterations to this with no diagnostic, so name every such part.
  model.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    const owners = object.geometry.userData.surfaceOwners as
      | { index: Uint16Array; paths: (number[] | undefined)[] }
      | undefined;
    if (!owners) return;
    const seen = new Uint8Array(owners.paths.length);
    for (let i = 0; i < owners.index.length; i++) seen[owners.index[i]] = 1;
    const missing = new Map<string, { path: number[]; copies: number }>();
    owners.paths.forEach((path, prim) => {
      if (seen[prim] || !path) return;
      const key = path.join('.');
      const entry = missing.get(key) ?? { path, copies: 0 };
      entry.copies++;
      missing.set(key, entry);
    });
    for (const { path, copies } of missing.values())
      findings.push({
        severity: 'warn',
        code: 'no-surface',
        part: path,
        value: copies,
        message: `${copies > 1 ? `${copies} copies of ` : ''}"${name(path.join('.'))}" own no surface: every vertex nearby belongs to a neighbour, so the part is invisible. Make it proud of its neighbour by at least a grid cell, or remove it.`,
      });
  });

  // --- rig weighting ----------------------------------------------------
  if (options.rigged) {
    const scale = options.scale && options.scale > 0 ? options.scale : 1;
    const [low, high] = AUTO_WEIGHT.designedFor;
    const rigHeight = size.y / scale;
    const { samples, unit } = rigSamples(model, scale);
    const unpinned = samples.filter((s) => !s.rigPart);
    const share = unpinned.length / Math.max(1, samples.length);
    const many = unit === 'vertex'
      ? `${Math.round(share * 100)}% of the surface`
      : `${unpinned.length} unpinned mesh${unpinned.length === 1 ? '' : 'es'}`;
    if (rigHeight < low || rigHeight > high) {
      if (unpinned.length)
        findings.push({
          severity: 'error',
          code: 'rig-scale',
          value: Number(rigHeight.toFixed(2)),
          message: `Automatic skin weighting uses fixed height bands tuned for ${low}–${high} m, but this model is ${rigHeight.toFixed(2)} m tall before its display scale, so ${many} will bind to the wrong bone. Set rigPart on every part, or build at ${low}–${high} m and use the spec's scale field for the final size.`,
        });
      else
        findings.push({
          severity: 'info',
          code: 'rig-scale-pinned',
          message: `Model is ${rigHeight.toFixed(2)} m tall before scale, outside the automatic weighting range, but every part pins its own bone.`,
        });
    }

    // Decorations legitimately ride the head — horns, antennae, a crest — so
    // counting parts would flag correct work. What actually goes wrong is a
    // torso caught in the head band, and that shows up as head-bound geometry
    // reaching far down the body.
    const headBound = unpinned.filter(
      (s) => autoBone({ x: s.x, y: s.y }) === 'Head',
    );
    if (headBound.length) {
      let top = -Infinity;
      let bottom = Infinity;
      for (const s of headBound) {
        top = Math.max(top, s.maxY);
        bottom = Math.min(bottom, s.minY);
      }
      const reach = ((top - bottom) * scale) / Math.max(size.y, 1e-6);
      if (reach > 0.4)
        findings.push({
          severity: 'error',
          code: 'rig-head-heavy',
          value: Number(reach.toFixed(2)),
          threshold: 0.4,
          message: `Geometry bound to the head bone spans ${Math.round(reach * 100)}% of the model's height, so the body will swing with the head. Parts above ${AUTO_WEIGHT.head} m follow the head unless they set rigPart — pin the torso and limbs, or sit them lower.`,
        });
    }

    // Any geometry on a leg bone is enough, pinned or not; an explicit thigh_l
    // animates exactly as well as an automatic one.
    const legged = samples.some((s) =>
      s.rigPart
        ? s.rigPart.startsWith('thigh') ||
          s.rigPart.startsWith('shin') ||
          s.rigPart.startsWith('foot')
        : autoBone({ x: s.x, y: s.y }).startsWith('Thigh'),
    );
    if (!legged)
      findings.push({
        severity: 'warn',
        code: 'rig-no-legs',
        message: `Nothing binds to a leg bone, so the walk and jump clips will not move the lower body. Put geometry below ${AUTO_WEIGHT.legs} m or set rigPart to a thigh, shin or foot.`,
      });
  }

  // --- shape ------------------------------------------------------------
  const flat = size.y / Math.max(size.x, size.z);
  findings.push({
    severity: 'info',
    code: 'proportions',
    value: Number(flat.toFixed(2)),
    message: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m, height-to-width ${flat.toFixed(2)}${flat < 0.5 ? ' — reads flat from the side' : ''}.`,
  });

  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/**
 * Note on surface mode: `detached-shell` is the stronger of the two
 * connectivity checks. Mesh-to-mesh contact has to pick a tolerance and can
 * only ever answer "close enough"; shell topology answers exactly, because two
 * parts either share triangles or they do not.
 *
 * Deliberately absent: a "this part is buried inside another" check. Eyes sit
 * inside heads, cores inside torsos, pegs inside sockets — containment flags
 * correct work far more often than mistakes, and a report that has to be
 * ignored is worse than no report at all.
 */
