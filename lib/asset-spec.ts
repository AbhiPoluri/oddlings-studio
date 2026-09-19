import * as T from 'three';
import { z } from 'zod';
import { random } from './world';
import { finishModel } from './asset-build';
import { surfaceModel, type SurfaceOptions } from './asset-surface';
import { mark, measure } from './perf';
import { disposeScene } from './three-world';
import { JOINTS, rigCreature } from './asset-rig';
import { jointBinder, rigJoints } from './asset-joints';
import {
  canonicalExtent,
  deformPoint,
  effectiveTaper,
  extrudeSection,
  latheSection,
  loftMesh,
  signedArea,
  warpFor,
  type Warp,
} from './asset-sdf';
import {
  contactTravel,
  inSweep,
  placeAlong,
  REST_STEPS,
  spineOf,
  worldTriangles,
  type PathPrim,
  type Triangles,
} from './asset-place';

/**
 * The from-scratch authoring layer.
 *
 * A recipe picks values inside one of the built-in generators. A spec instead
 * describes the asset itself: a tree of primitives with transforms, colors,
 * repeats and rig bindings. An agent that wants a shape no blueprint covers
 * writes a spec, and gets the same rigging, material merging and export path
 * the blueprints use.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color such as #93cec8.');

export const SHAPES = [
  'sphere',
  'box',
  'cylinder',
  'cone',
  'capsule',
  'torus',
  'icosahedron',
  'octahedron',
  'tetrahedron',
  'prism',
  'plane',
  'limb',
  'lathe',
  'extrude',
  'loft',
] as const;
export type Shape = (typeof SHAPES)[number];

/** Bones a part can be pinned to. Unpinned parts are weighted by position. */
export const RIG_PARTS = [
  'head',
  'spine',
  'hips',
  'arm_l',
  'forearm_l',
  'arm_r',
  'forearm_r',
  'thigh_l',
  'shin_l',
  'foot_l',
  'thigh_r',
  'shin_r',
  'foot_r',
] as const;

const repeatSchema = z
  .object({
    /**
     * Copies to make. Dense foliage wants hundreds, so this is deliberately
     * generous; `MAX_MESHES` is the real guard and throws by name when a
     * nested repeat multiplies out of hand.
     */
    count: z.number().int().min(1).max(512),
    mode: z.enum(['linear', 'radial', 'surface', 'along']).default('linear'),
    /** linear: translation applied per step. */
    offset: vec3.optional(),
    /** linear: extra rotation in degrees applied per step. */
    rotation: vec3.optional(),
    /** Multiplied into the part's scale once per step. */
    scaleStep: z.number().min(0.05).max(4).optional(),
    /** radial: axis to orbit, distance from it, and the arc to fill. */
    axis: z.enum(['x', 'y', 'z']).default('y'),
    radius: z.number().min(0).max(200).optional(),
    arc: z.number().min(-1440).max(1440).default(360),
    /**
     * surface: how far to sink each copy into the surface it lands on, as a
     * fraction of the copy's own size. Positive lifts it clear, negative beds
     * it in. A small negative value is usually right, so the copy reads as
     * growing out of the body rather than resting against it.
     */
    embed: z.number().min(-1).max(1).default(-0.25),
    /**
     * surface: restrict placement to a height band of the target, 0 at its
     * bottom and 1 at its top. Blossoms on the upper half of a bush is
     * [0.4, 1]; barnacles round the waterline is [0.2, 0.35].
     */
    band: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
    /** surface: turn each copy to stand along the surface normal. */
    align: z.boolean().default(true),
    /**
     * Seeded irregularity, so a repeat can read as grown rather than machined.
     * `scatter` is the maximum random offset per axis in metres, `twist` the
     * maximum random rotation in degrees, and `sizeJitter` a proportional
     * variation in scale. All are symmetric (plus or minus) and reproducible
     * from the spec seed.
     */
    scatter: vec3.optional(),
    twist: z.number().min(0).max(180).optional(),
    sizeJitter: z.number().min(0).max(1).optional(),
    /**
     * along: the part whose spine the copies follow — a limb's from → via → to
     * curve, or the long axis of anything else — and which surface line of it
     * they sit on. Scutes down a tail, teeth along a jaw, rivets down a seam:
     * every row on a curved thing, without working out the curve by hand.
     */
    path: z.string().min(1).max(60).optional(),
    /** along: the fraction of the path to cover, 0 at `from`. */
    span: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0, 1]),
    /** along: which side of the path — a named side, or degrees round it. */
    side: z.union([z.enum(['up', 'down', 'left', 'right']), z.number().min(-360).max(360)]).default('up'),
  })
  .strict()
  .superRefine((repeat, ctx) => {
    if (repeat.mode === 'along' && !repeat.path)
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'mode "along" needs "path": the name of the part whose spine the copies follow.' });
  });
export type Repeat = z.infer<typeof repeatSchema>;

const basePart = {
  name: z.string().max(60).optional(),
  shape: z.enum(SHAPES),
  /** Bounding size in meters. Every shape is fitted to this box. */
  size: vec3.optional(),
  position: vec3.optional(),
  /** Euler XYZ in degrees. */
  rotation: vec3.optional(),
  color: hex.optional(),
  /** Radial or subdivision detail. Low numbers keep the faceted look. */
  detail: z.number().int().min(3).max(24).optional(),
  /** Top-to-bottom radius ratio for cylinder, cone and prism. */
  taper: z.number().min(0).max(4).optional(),
  /** Seeded vertex displacement, 0 = smooth, 1 = heavily eroded. */
  jitter: z.number().min(0).max(1).optional(),
  /** `limb` only: a tapered tube drawn between two points. */
  from: vec3.optional(),
  to: vec3.optional(),
  /** `limb` only: bend the tube through this point instead of running straight. */
  via: vec3.optional(),
  radius: z.number().min(0.001).max(50).optional(),
  /**
   * The 2D outline `lathe` and `extrude` are built from.
   *
   * A lathe reads [radius, height] pairs and revolves them about the part's own
   * Y. An extrude reads [x, y] pairs and sweeps that polygon along Z. Either
   * way the profile is a silhouette rather than a measurement: it is fitted to
   * `size` like every other shape, so the numbers only have to be in
   * proportion to each other.
   */
  profile: z
    .array(z.tuple([z.number(), z.number()]))
    .min(2)
    .max(64)
    .optional(),
  /**
   * `box` and `extrude` only: chamfer width in metres, 0 for a sharp edge.
   *
   * A few centimetres is usually enough. Nothing man-made has a perfectly sharp
   * edge, and the highlight a chamfer catches is most of what separates a
   * machined panel from a cardboard box.
   */
  bevel: z.number().min(0).max(10).optional(),
  /**
   * `loft` only: cross-sections along a spine. Each station is a 2D outline at
   * a fraction of the spine's length; the surface is skinned between them.
   * Hulls, torsos, necks, tails, horns — anything whose silhouette changes
   * along its length. With no stations a loft is a plain box, like a lathe
   * with no profile is a cylinder.
   */
  stations: z
    .array(
      z.object({ at: z.number().min(0).max(1), profile: z.array(z.tuple([z.number(), z.number()])).min(3).max(64) }).strict(),
    )
    .min(2)
    .max(24)
    .optional(),
  /** `loft` only: the curve the stations sit along. Straight along Z when omitted. */
  spine: z.object({ from: vec3, to: vec3, via: vec3.optional() }).strict().optional(),
  /**
   * `loft` only: `mirror` reflects each station across its first axis, so an
   * author draws half a hull; `none` takes the outline as drawn.
   */
  closed: z.enum(['mirror', 'none']).optional(),
  /**
   * Bend, twist and taper the part along one of its own axes before it is
   * placed. A bent box is a sheer line; a bent, tapered cylinder is a horn.
   * Degrees for bend and twist; taper is the far end's scale.
   */
  deform: z
    .object({
      axis: z.enum(['x', 'y', 'z']).default('y'),
      bend: z.number().min(-180).max(180).default(0),
      twist: z.number().min(-720).max(720).default(0),
      taper: z.number().min(0).max(4).default(1),
    })
    .strict()
    .optional(),
  /**
   * Drop the part until it touches another. The commonest defect in an
   * authored asset is a part a few centimetres off the thing it belongs on;
   * this asks the builder to find the contact instead of the author.
   */
  rest: z
    .object({
      /** The part to land on, by name, or "any" for everything built before this one. */
      on: z.string().min(1).max(60),
      from: z.enum(['above', 'below', '+x', '-x', '+z', '-z']).default('above'),
      /** Metres to embed past the contact, so a scute sits in the hide, not on it. */
      sink: z.number().min(-1).max(1).default(0),
    })
    .strict()
    .optional(),
  /**
   * Carve this part out of everything blended before it instead of adding it.
   * Surface mode only: a window through a wall, a gun port, a niche. The cut's
   * inner walls take this part's colour.
   */
  subtract: z.boolean().optional(),
  /** Surface response. Defaults reproduce the studio's matte look. */
  material: z
    .object({
      roughness: z.number().min(0).max(1).default(1),
      metalness: z.number().min(0).max(1).default(0),
      emissive: hex.optional(),
      emissiveStrength: z.number().min(0).max(10).default(1),
    })
    .strict()
    .optional(),
  /** Pin this part and its children to one bone. */
  rigPart: z.enum(RIG_PARTS).optional(),
  /** Duplicate the part mirrored across an axis. */
  mirror: z.enum(['x', 'y', 'z']).optional(),
  repeat: repeatSchema.optional(),
};

export type Part = z.infer<z.ZodObject<typeof basePart>> & {
  children?: Part[];
};
/**
 * The rules one field cannot state about itself.
 *
 * A profile on a sphere, a bend on a box, a chamfer wider than the panel it is
 * cut into: all of them parse fine field by field and then build something the
 * author did not ask for. Refusing at parse time is what turns "why is my
 * funnel a cylinder" into a sentence that says which key to move.
 */
function checkPart(part: Part, ctx: z.RefinementCtx) {
  const shape = part.shape;
  const profiled = shape === 'lathe' || shape === 'extrude';

  if (part.profile && !profiled)
    ctx.addIssue({
      code: 'custom',
      path: ['profile'],
      message: `"profile" belongs to lathe and extrude, not to ${shape}. Revolve it with "lathe" or sweep it with "extrude".`,
    });
  if (part.via && shape !== 'limb')
    ctx.addIssue({
      code: 'custom',
      path: ['via'],
      message: `"via" bends a limb through a point, and ${shape} is not drawn between two points. Use "limb".`,
    });
  for (const key of ['stations', 'spine', 'closed'] as const)
    if (part[key] !== undefined && shape !== 'loft')
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `"${key}" belongs to loft, not to ${shape}. Skin sections along a spine with "loft".`,
      });
  if (part.bevel !== undefined && shape !== 'box' && shape !== 'extrude')
    ctx.addIssue({
      code: 'custom',
      path: ['bevel'],
      message: `"bevel" chamfers the edges of a box or an extrude; ${shape} has no edges to chamfer.`,
    });

  if (part.profile) {
    const flat = part.profile.flat();
    if (!flat.every(Number.isFinite))
      ctx.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'Every profile coordinate has to be a finite number.',
      });
    else if (shape === 'lathe') {
      if (part.profile.some(([r]) => r < 0))
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message:
            'A lathe profile is [radius, height] pairs, and a radius cannot be negative. The profile is revolved, so only one side of the axis is drawn.',
        });
      if (!part.profile.some(([r]) => r > 0))
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message:
            'Every point of this lathe profile sits on the axis, so it revolves into nothing. Give at least one point a radius.',
        });
      const ys = part.profile.map(([, y]) => y);
      if (Math.max(...ys) - Math.min(...ys) <= 0)
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message:
            'This lathe profile is flat: every point is at the same height, so it revolves into a disc with no thickness. Vary the second number.',
        });
    } else if (shape === 'extrude') {
      if (part.profile.length < 3)
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message: `An extrude profile is a polygon, so it needs at least 3 points; this one has ${part.profile.length}.`,
        });
      else if (Math.abs(signedArea(part.profile)) < 1e-12)
        ctx.addIssue({
          code: 'custom',
          path: ['profile'],
          message:
            'This extrude profile encloses no area — its points are collinear or doubled back on themselves. A profile has to be a simple closed polygon.',
        });
    }
  }

  if (part.bevel) {
    const size = part.size ?? [1, 1, 1];
    const half = Math.min(...size) / 2;
    if (part.bevel > half)
      ctx.addIssue({
        code: 'custom',
        path: ['bevel'],
        message: `A bevel of ${part.bevel} m is wider than half of the shortest side (${half} m), which would cut the part away. Use a smaller bevel or a thicker part.`,
      });
    if (shape === 'extrude' && part.taper !== undefined && part.taper !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['bevel'],
        message:
          'An extrude can be tapered or bevelled, not both: the two ask for a different width at the same end. Drop one, or build the chamfer as a second part.',
      });
  }
}

const partSchema: z.ZodType<Part> = z.lazy(() =>
  z
    .object({ ...basePart, children: z.array(partSchema).max(64).optional() })
    .strict()
    .superRefine(checkPart),
);

/** Only the fields the chain and clip rules read, so this can sit above the schema. */
type JointChain = {
  name: string;
  parent?: string;
  spin?: { seconds: number; clip?: string };
};

/**
 * The rules a list of joints has to satisfy that no single joint can check.
 *
 * All of these are parse errors rather than build-time surprises: a bone
 * parented to a typo, or two halves of one mechanism quietly landing in two
 * clips, are mistakes an author makes while hand-editing a rig and wants told
 * about at the moment they save, not when the swing turns out to jitter.
 */
function checkJointChain(joints: JointChain[], ctx: z.RefinementCtx) {
  const index = new Map<string, number>();
  joints.forEach((joint, at) => {
    if (joint.name === 'Root')
      ctx.addIssue({
        code: 'custom',
        path: [at, 'name'],
        message:
          '"Root" is the static bone every joint spec already has. Name this joint something else.',
      });
    if (index.has(joint.name))
      ctx.addIssue({
        code: 'custom',
        path: [at, 'name'],
        message: `Two joints are called "${joint.name}". Joint names must be unique: they name the bone, its clip and whatever parents to it.`,
      });
    else index.set(joint.name, at);
  });

  joints.forEach((joint, at) => {
    const parent = joint.parent;
    if (parent === undefined) return;
    if (parent === joint.name)
      return ctx.addIssue({
        code: 'custom',
        path: [at, 'parent'],
        message: `Joint "${joint.name}" is its own parent. Omit "parent" to hang a joint off the root bone.`,
      });
    if (!index.has(parent))
      return ctx.addIssue({
        code: 'custom',
        path: [at, 'parent'],
        message:
          parent === 'Root'
            ? `Joint "${joint.name}" has parent "Root". Omit "parent" instead — everything with no parent already hangs off the root bone.`
            : `Joint "${joint.name}" has parent "${parent}", but no joint is called that.`,
      });
    // Walk up to the root. A cycle has no root, so the walk is bounded by the
    // names it has already seen rather than by reaching the top.
    const trail = [joint.name];
    const seen = new Set(trail);
    let above: string | undefined = parent;
    while (above !== undefined) {
      trail.push(above);
      if (seen.has(above))
        return ctx.addIssue({
          code: 'custom',
          path: [at, 'parent'],
          message: `Joint "${joint.name}" hangs off itself: ${trail.join(' → ')}. A bone cannot be a descendant of its own child.`,
        });
      seen.add(above);
      const next = index.get(above);
      if (next === undefined) return; // Unknown parent, already reported above.
      above = joints[next].parent;
    }
  });

  const held = new Map<string, { seconds: number; joint: string }>();
  joints.forEach((joint, at) => {
    if (!joint.spin) return;
    const clip = joint.spin.clip ?? joint.name;
    const first = held.get(clip);
    if (!first) return held.set(clip, { seconds: joint.spin.seconds, joint: joint.name });
    if (first.seconds !== joint.spin.seconds)
      ctx.addIssue({
        code: 'custom',
        path: [at, 'spin', 'seconds'],
        message: `Clip "${clip}" runs ${first.seconds}s on joint "${first.joint}" but ${joint.spin.seconds}s on joint "${joint.name}". One clip has one length: give every joint sharing it the same seconds.`,
      });
  });
}

export const specSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(60),
    kind: z.enum(['creature', 'person', 'prop', 'environment']),
    /** Drives jitter and any other randomness, so specs stay reproducible. */
    seed: z.number().int().min(0).max(2147483647).default(0),
    scale: z.number().min(0.01).max(100).default(1),
    /** Fallback color for parts that do not set one. */
    color: hex.default('#93cec8'),
    /** Omit for a static mesh; supply to skin the result to the 14-bone rig. */
    rig: z
      .object({
        hipHeight: z.number().min(0.05).max(4).default(0.48),
        headPivot: z.number().min(0.05).max(6).default(0.9),
        shoulderWidth: z.number().min(0.02).max(3).default(0.28),
        /**
         * Move individual bones, in absolute model space, after the three
         * measurements above have placed them.
         *
         * Use it when a body is not the shape those three numbers can
         * describe: a head carried forward, a shoulder dropped, arms longer
         * than a person's. Moving a bone carries its children with it, and the
         * two sides are independent — set `Arm_L` and `Arm_R` yourself.
         */
        bones: z.partialRecord(z.enum(JOINTS), vec3).optional(),
      })
      .strict()
      .optional(),
    /**
     * Emit one continuous polygon mesh instead of stacked primitives.
     *
     * The parts become a blended distance field that is re-meshed into a
     * single manifold shell: no buried interior faces, one surface to unwrap,
     * and topology that stays connected when the rig bends it.
     */
    surface: z
      .object({
        /** Blend radius in metres. 0 welds parts with a hard crease. */
        blend: z.number().min(0).max(0.5).default(0.03),
        /** Grid resolution along the longest axis. Higher resolves finer detail. */
        detail: z.number().int().min(24).max(512).default(128),
        /** Triangle budget after decimation. */
        budget: z.number().int().min(200).max(1000000).default(6000),
        /** `flat` keeps the studio's faceted look; `smooth` reads as sculpted. */
        shading: z.enum(['flat', 'smooth']).default('flat'),
        /**
         * Crease angle in degrees. Set, it replaces `shading`: two faces that
         * meet under it share a smooth normal, two that turn harder keep a
         * hard edge. 0 is flat, 180 is smooth, 40 to 60 suits armour and
         * machines, 80 or more a creature.
         */
        crease: z.number().min(0).max(180).optional(),
      })
      .strict()
      .optional(),
    /**
     * Moving parts: a pivot, what hangs off it, and how it turns.
     *
     * `rig` describes a character and only a character — its bones are hips
     * and shoulders placed from body measurements. A joint is the general
     * form for everything else a mechanism does: a swinging tire, a creaking
     * sign, a turning wheel. Each one becomes a bone at `at`, carrying every
     * part named in `binds` (and their children), and `spin` gives it a
     * looping clip named after the joint.
     */
    joints: z
      .array(
        z
          .object({
            /** Names the bone, and by default the clip it animates. */
            name: z.string().min(1).max(40),
            /** Pivot position, in the same unscaled space as part positions. */
            at: vec3,
            /**
             * Hang this joint off another one, by name, to build a real chain:
             * a rope off a bough, a tire off the rope. `at` stays absolute
             * either way — the builder works out the offset from the parent —
             * so an author moves a pivot to where they see it, not to where it
             * would be if its parent were at the origin. Omit for a joint that
             * hangs off the static root bone.
             */
            parent: z.string().min(1).max(40).optional(),
            /** Part names that follow this joint. Children follow too. */
            binds: z.array(z.string().min(1).max(60)).min(1).max(64),
            /** Omit for a pivot you only want to pose from code. */
            spin: z
              .object({
                axis: z.enum(['x', 'y', 'z']).default('x'),
                /**
                 * `swing` is a pendulum: it eases out to ±degrees and back.
                 * `turn` is a wheel: one full revolution per clip, linear,
                 * the sign of `degrees` giving the direction. Sails, wheels,
                 * propellers and drills want `turn`; anything on a rope or a
                 * hinge wants `swing`.
                 */
                mode: z.enum(['swing', 'turn']).default('swing'),
                /** Peak swing either side of rest (`swing`), or direction (`turn`). */
                degrees: z.number().min(-180).max(180).default(18),
                /** Seconds for one full back-and-forth, or one revolution. */
                seconds: z.number().min(0.2).max(30).default(2.5),
                /**
                 * How much a swing wanders off its plane, as a fraction of
                 * `degrees`. The default figure-eight is what makes a rope
                 * swing read as a swing; a hinge, a sign or a cap turning on
                 * a bearing wants 0. Ignored by `turn`.
                 */
                drift: z.number().min(0).max(1).default(0.15),
                /**
                 * Which clip this spin belongs to. Defaults to the joint's own
                 * name. Joints that name the same clip animate together in one
                 * clip, which is the only way a chain reads as one mechanism:
                 * two clips cannot be relied on to play in step.
                 */
                clip: z.string().min(1).max(40).optional(),
                /**
                 * Degrees of lag against the rest of the clip. A tire on a
                 * rope does not reach the top of its arc at the same instant
                 * the rope does, and 90 here is what buys that quarter-cycle
                 * of trailing.
                 */
                phase: z.number().min(-360).max(360).default(0),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      // An eight-legged walker with hip, knee and ankle per leg is 25 joints.
      .max(64)
      .superRefine(checkJointChain)
      .optional(),
    parts: z.array(partSchema).min(1).max(200),
  })
  .strict()
  // A mesh binds to one skeleton. Merging a character rig with a mechanism is
  // a real thing to want — a rider on a swing — but it is a different feature,
  // and silently ignoring one of the two would be worse than refusing both.
  .refine((spec) => !(spec.rig && spec.joints?.length), {
    message:
      'A spec has one skeleton: use `rig` for a character or `joints` for a mechanism, not both.',
    path: ['joints'],
  });

export type AssetSpec = z.infer<typeof specSchema>;
export type Joint = NonNullable<AssetSpec['joints']>[number];
export type AssetSpecInput = z.input<typeof specSchema>;

/**
 * A part after expansion, tagged with the path of the authored part it came
 * from. One authored part can become many meshes via repeat and mirror; they
 * all carry the same `origin`, so the editor can select a part in the tree and
 * highlight every copy of it. Not part of the schema — it is attached after
 * validation.
 */
type PlacedPart = Omit<Part, 'children'> & {
  children?: PlacedPart[];
  origin?: number[];
};

/** Hard ceiling on meshes after mirrors and repeats expand, to keep exports sane. */
const MAX_MESHES = 4000;

export function parseSpec(input: unknown): AssetSpec {
  const result = specSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? ` at ${issue.path.join('.')}` : '';
    throw Error(`Invalid asset spec${where}: ${issue.message}`);
  }
  return result.data;
}

/**
 * A box with one flat facet cut across each edge and corner.
 *
 * 44 triangles: six shrunken faces, twelve edge facets and eight corner
 * triangles. `RoundedBoxGeometry` at `segments: 1` draws the same silhouette
 * with 108, because it splits every edge into two facets and every corner into
 * three — nearly a tenth of a low-poly prop's whole budget per box, spent on an
 * arc nobody asked for. One plane per edge is what a chamfer means here.
 *
 * Built at final size, so the chamfer is the width the author asked for rather
 * than something `fitToSize` stretches along the part's longest axis. Normals
 * come from the finishing pass, which is what makes each facet read flat.
 */
function chamferedBoxGeometry(size: readonly number[], bevel: number) {
  const half = [size[0] / 2, size[1] / 2, size[2] / 2];
  // The same clamp the field applies: a repeat's `sizeJitter` can shrink a copy
  // below the bevel the schema checked against the part it was copied from.
  const cut = Math.min(bevel, Math.min(...half));

  /**
   * The corner vertex that belongs to the face along `axis`: pulled in by the
   * bevel on the other two axes, and left out at full extent on this one.
   */
  const corner = (axis: number, signs: readonly number[]) => {
    const point = [0, 1, 2].map((a) => signs[a] * (half[a] - cut));
    point[axis] = signs[axis] * half[axis];
    return point;
  };

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const edge = new T.Vector3();
  const across = new T.Vector3();
  const facing = new T.Vector3();

  /**
   * Add one flat polygon, wound to face `outward`.
   *
   * Deriving the winding from the geometry rather than from the sign algebra of
   * three nested loops is the difference between a box that is inside out on
   * two of its facets and one that is not — and the answer is never in doubt,
   * because every facet here has an outward direction by construction.
   */
  const facet = (loop: number[][], outward: number[]) => {
    edge.set(
      loop[1][0] - loop[0][0],
      loop[1][1] - loop[0][1],
      loop[1][2] - loop[0][2],
    );
    across.set(
      loop[2][0] - loop[0][0],
      loop[2][1] - loop[0][1],
      loop[2][2] - loop[0][2],
    );
    facing.set(outward[0], outward[1], outward[2]);
    const points = edge.cross(across).dot(facing) < 0 ? [...loop].reverse() : loop;
    // The dominant axis of the facet's normal picks the plane to project the
    // uvs onto, which is what a box's own uvs do face by face.
    let axis = 0;
    for (let a = 1; a < 3; a++)
      if (Math.abs(outward[a]) > Math.abs(outward[axis])) axis = a;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const base = positions.length / 3;
    for (const point of points) {
      positions.push(point[0], point[1], point[2]);
      uvs.push(point[u] / (2 * half[u]) + 0.5, point[v] / (2 * half[v]) + 0.5);
    }
    for (let i = 1; i < points.length - 1; i++)
      indices.push(base, base + i, base + i + 1);
  };

  const corners = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z])),
  );

  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const outward = [0, 0, 0];
      outward[axis] = sign;
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      facet(
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([su, sv]) => {
          const signs = [0, 0, 0];
          signs[axis] = sign;
          signs[u] = su;
          signs[v] = sv;
          return corner(axis, signs);
        }),
        outward,
      );
    }

  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) {
      const along = 3 - a - b;
      for (const sa of [-1, 1])
        for (const sb of [-1, 1]) {
          const outward = [0, 0, 0];
          outward[a] = sa;
          outward[b] = sb;
          const at = (axis: number, sc: number) => {
            const signs = [0, 0, 0];
            signs[a] = sa;
            signs[b] = sb;
            signs[along] = sc;
            return corner(axis, signs);
          };
          facet([at(a, -1), at(a, 1), at(b, 1), at(b, -1)], outward);
        }
    }

  for (const signs of corners)
    facet([corner(0, signs), corner(1, signs), corner(2, signs)], signs);

  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Revolve a closed profile about Y.
 *
 * Built by hand rather than with `LatheGeometry` because the ends matter: the
 * addon leaves an open tube unless the profile itself reaches the axis, and
 * when it does reach it every quad there collapses into a degenerate triangle.
 * Revolving the axis-closed profile instead makes the end caps fall out of the
 * same loop as the walls — one code path, no zero-area faces, and exactly the
 * polygon the distance field measures against.
 */
function latheGeometry(part: Part, detail: number) {
  const points = latheSection(part);
  const segments = Math.max(3, detail);
  const rings = points.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // The seam column is duplicated rather than shared so the uvs can run 0 to 1
  // the whole way round, which is what every primitive in three does.
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);
    for (let j = 0; j < rings; j++) {
      positions.push(points[j][0] * sin, points[j][1], points[j][0] * cos);
      uvs.push(i / segments, rings > 1 ? j / (rings - 1) : 0);
    }
  }
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < rings - 1; j++) {
      const a = i * rings + j;
      const b = a + rings;
      const c = b + 1;
      const d = a + 1;
      // A ring sitting on the axis is a single point, so the half of the quad
      // that touches it is a line. Emit the other half only.
      if (points[j][0] > 1e-9) indices.push(a, b, d);
      if (points[j + 1][0] > 1e-9) indices.push(b, c, d);
    }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Inward unit normal of the edge p to q, for a counter-clockwise contour. */
function inwardNormal(p: readonly number[], q: readonly number[]) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const length = Math.hypot(dx, dy) || 1;
  return [-dy / length, dx / length] as const;
}

/**
 * Pull a contour in by `amount`, mitring at the corners.
 *
 * This is how the chamfer on an extrude is cut: the two rings nearest each end
 * are the section inset by the bevel, so the wall meets the cap at 45 degrees
 * instead of a right angle. The mitre is clamped, because at a near-needle
 * corner 1/cos of the half-angle runs away and would throw that vertex far
 * outside the shape it belongs to.
 */
function insetPolygon(points: [number, number][], amount: number) {
  if (amount <= 0) return points;
  const n = points.length;
  return points.map((here, i) => {
    const before = inwardNormal(points[(i - 1 + n) % n], here);
    const after = inwardNormal(here, points[(i + 1) % n]);
    let mx = before[0] + after[0];
    let my = before[1] + after[1];
    const length = Math.hypot(mx, my);
    if (length < 1e-9)
      return [here[0] + before[0] * amount, here[1] + before[1] * amount] as [
        number,
        number,
      ];
    mx /= length;
    my /= length;
    const reach = Math.min(
      amount / Math.max(0.2, mx * before[0] + my * before[1]),
      amount * 5,
    );
    return [here[0] + mx * reach, here[1] + my * reach] as [number, number];
  });
}

/**
 * Sweep a polygon along Z, scaling it towards one end and chamfering the rims.
 *
 * Hand-built rather than `ExtrudeGeometry` because neither of the two things
 * this shape exists for is in that geometry: it cannot taper, which is what
 * gives a hull its flare, and its bevel is measured from a contour it offsets
 * on its own terms rather than from the size the part declares.
 */
function extrudeGeometry(part: Part, rings: number) {
  const { points, halfDepth, taper, bevel: lip } = extrudeSection(part);
  const depth = halfDepth * 2;
  const rims = lip > 0
    ? [-halfDepth, -halfDepth + lip, halfDepth - lip, halfDepth]
    : [-halfDepth, halfDepth];
  const rimInsets = lip > 0 ? [lip, 0, 0, lip] : [0, 0];
  // A bend or a twist moves vertices, so an extrude with nothing between its
  // two rims has nothing to bend: the ends swing and the wall stays a flat
  // plate between them. The extra levels go in the straight span, never across
  // a chamfer, so the bevel keeps the profile it was cut with.
  const span = lip > 0 ? 1 : 0;
  const levels: number[] = [];
  const insets: number[] = [];
  rims.forEach((z, at) => {
    levels.push(z);
    insets.push(rimInsets[at]);
    if (at === span)
      for (let k = 1; k < rings; k++) {
        levels.push(z + (rims[at + 1] - z) * (k / rings));
        insets.push(0);
      }
  });

  const sections = levels.map((z, at) => {
    const k = 1 + (taper - 1) * (z / depth + 0.5);
    return insetPolygon(
      points.map(([x, y]) => [x * k, y * k] as [number, number]),
      insets[at],
    );
  });

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const count = points.length;
  sections.forEach((section, at) => {
    for (const [x, y] of section) {
      positions.push(x, y, levels[at]);
      uvs.push(x + 0.5, y + 0.5);
    }
  });
  for (let at = 0; at < sections.length - 1; at++)
    for (let i = 0; i < count; i++) {
      const low = at * count + i;
      const lowNext = at * count + ((i + 1) % count);
      const high = low + count;
      const highNext = lowNext + count;
      indices.push(low, lowNext, highNext, low, highNext, high);
    }

  // Earcut keeps the contour's winding, so the triangles come out facing +Z
  // and the near cap is the one that has to be turned around.
  const cap = T.ShapeUtils.triangulateShape(
    sections[0].map(([x, y]) => new T.Vector2(x, y)),
    [],
  );
  const last = (sections.length - 1) * count;
  for (const [a, b, c] of cap) {
    indices.push(a, c, b);
    indices.push(last + a, last + b, last + c);
  }

  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Skin a loft's stations into a closed solid.
 *
 * The skinning itself lives beside the distance field, the way `extrudeSection`
 * and `latheSection` do, because a loft is the one shape with no closed form
 * for the field to check itself against: the only way the two backends can
 * agree about where a hull's cheek is, is for both of them to be reading the
 * same triangles. This wraps those numbers in a `BufferGeometry` and nothing
 * else.
 *
 * With fewer than two stations there is nothing to skin, and a loft falls back
 * to a plain box — the same bargain a lathe with no profile makes when it comes
 * out a cylinder. Every shape has to build from `{ shape, size }` alone.
 */
function loftGeometry(part: Part) {
  const mesh = loftMesh(part);
  if (!mesh) return new T.BoxGeometry(1, 1, 1);
  const geometry = new T.BufferGeometry();
  geometry.setAttribute(
    'position',
    new T.Float32BufferAttribute(mesh.positions, 3),
  );
  geometry.setAttribute('uv', new T.Float32BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(mesh.indices);
  return geometry;
}

/**
 * Bend, twist and taper a primitive into its declared size.
 *
 * The warp runs in the canonical frame — the primitive normalised into the
 * extent `canonicalExtent` names — and the part is then scaled straight to
 * `size` rather than re-fitted to it. That ordering is the whole contract
 * between the two backends: the field divides a query point by the same
 * scale, undoes the same warp with `undeformPoint`, and evaluates the same
 * canonical shape, so a bent horn is the identical solid faceted or fused.
 *
 * Re-fitting the bent mesh back into `size` would be prettier — `size` would
 * stay the part's bounding box — but the fit depends on the deformed mesh's
 * own bounds, which the field never sees and cannot derive from `size` alone
 * for anything rounder than a box. Two backends drawing different hulls is a
 * worse bargain than a bend that reaches outside its box, so the bend reaches.
 *
 * A loft has already baked its own warp into the stations it skinned, and a
 * limb is drawn between two authored points rather than inside a box, so
 * `warpFor` returns nothing for either and this is a no-op.
 */
function deformGeometry(
  geometry: T.BufferGeometry,
  part: Part,
  warp: Warp | null,
  size: readonly number[],
) {
  if (!warp) return fitToSize(geometry, size);
  const extent = canonicalExtent(part.shape);
  // Into the canonical frame first, so the warp's own half-extents — which the
  // field takes from `canonicalExtent` — are the ones the vertices actually
  // sit in.
  fitToSize(geometry, extent);
  const position = geometry.attributes.position as T.BufferAttribute;
  const point = [0, 0, 0];
  for (let i = 0; i < position.count; i++) {
    point[0] = position.getX(i);
    point[1] = position.getY(i);
    point[2] = position.getZ(i);
    deformPoint(warp, point);
    position.setXYZ(i, point[0], point[1], point[2]);
  }
  position.needsUpdate = true;
  geometry.scale(size[0] / extent[0], size[1] / extent[1], size[2] / extent[2]);
  // Three caches a bounding box, and these vertices have just invalidated it.
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function geometryFor(
  part: Part,
  detail: number,
  taper: number,
  warp: Warp | null,
) {
  const size = part.size ?? [1, 1, 1];
  // A primitive with a single segment along the axis a bend acts on has no
  // vertices in the middle to move, so it comes out a straight thing with
  // tilted ends. One ring per six degrees keeps the chord error below the
  // faceting the studio draws anyway.
  const rings = warp?.segments ?? 1;
  const along = (axis: number) => (warp && warp.axis === axis ? rings : 1);
  switch (part.shape) {
    case 'lathe':
      return latheGeometry(part, detail);
    case 'extrude':
      return extrudeGeometry(part, rings);
    case 'loft':
      return loftGeometry(part);
    case 'sphere':
      return new T.SphereGeometry(0.5, detail * 2, detail);
    case 'icosahedron':
      return new T.IcosahedronGeometry(0.5, detail > 8 ? 2 : detail > 4 ? 1 : 0);
    case 'octahedron':
      return new T.OctahedronGeometry(0.5, detail > 8 ? 1 : 0);
    case 'tetrahedron':
      return new T.TetrahedronGeometry(0.5, 0);
    case 'box':
      // A chamfered box is built at final size from its own corner algebra, so
      // it has no segments to raise; a bevelled box that is also bent keeps its
      // chamfer and bends only at its corners.
      return part.bevel
        ? chamferedBoxGeometry(size, part.bevel)
        : new T.BoxGeometry(1, 1, 1, along(0), along(1), along(2));
    case 'cylinder':
      return new T.CylinderGeometry(0.5 * taper, 0.5, 1, detail, rings);
    case 'prism':
      return new T.CylinderGeometry(
        0.5 * taper,
        0.5,
        1,
        Math.max(3, detail),
        rings,
      );
    case 'cone':
      return new T.ConeGeometry(0.5, 1, detail, rings);
    case 'capsule':
      return new T.CapsuleGeometry(
        0.5,
        0.5,
        Math.max(2, detail >> 1),
        detail,
        rings,
      );
    case 'torus':
      return new T.TorusGeometry(0.35, 0.15, Math.max(4, detail >> 1), detail);
    case 'plane':
      return new T.PlaneGeometry(1, 1, along(0), along(1));
    default:
      return new T.BoxGeometry(1, 1, 1);
  }
}

/**
 * Fit a primitive to its declared bounding box, centred on its own origin.
 *
 * The raw primitives are not unit-sized — a capsule is 1.5 tall, a torus 0.26
 * deep, a six-sided cylinder 0.866 wide — so scaling them directly would make
 * `size` mean something different for every shape. Normalising first is what
 * lets an author say "0.5 wide, 0.25 tall" and get exactly that.
 */
function fitToSize(geometry: T.BufferGeometry, size: readonly number[]) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return geometry;
  const extent = box.getSize(new T.Vector3());
  const centre = box.getCenter(new T.Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  // A plane has no depth; leave flat axes alone rather than dividing by zero.
  geometry.scale(
    extent.x > 1e-6 ? size[0] / extent.x : 1,
    extent.y > 1e-6 ? size[1] / extent.y : 1,
    extent.z > 1e-6 ? size[2] / extent.z : 1,
  );
  return geometry;
}

/**
 * Displace vertices along their normals with seeded noise. Applied before the
 * flat-shading pass so faces stay welded and the silhouette reads as carved.
 */
function jitterGeometry(
  geometry: T.BufferGeometry,
  amount: number,
  seed: number,
) {
  geometry.computeVertexNormals();
  const position = geometry.attributes.position as T.BufferAttribute;
  const normal = geometry.attributes.normal as T.BufferAttribute;
  const rng = random(seed);
  const radius =
    new T.Box3()
      .setFromBufferAttribute(position)
      .getSize(new T.Vector3())
      .length() * 0.5;
  for (let i = 0; i < position.count; i++) {
    const push = (rng() - 0.5) * amount * radius * 0.5;
    position.setXYZ(
      i,
      position.getX(i) + normal.getX(i) * push,
      position.getY(i) + normal.getY(i) * push,
      position.getZ(i) + normal.getZ(i) * push,
    );
  }
  position.needsUpdate = true;
  // Fitting cached a bounding box that these vertices have just invalidated,
  // and three reuses a cached box rather than recomputing it.
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A limb bent through `via`: a quadratic bezier swept with a circular section.
 *
 * `TubeGeometry` would draw the same curve but cannot taper and leaves both
 * ends open, and an open end is a hole in a model the audit is right to
 * complain about. The frames come from three all the same, because choosing a
 * stable normal along a curve is the only hard part of sweeping one.
 */
function curvedLimbGeometry(
  part: Part,
  detail: number,
  taper: number,
  via: readonly number[],
) {
  const from = new T.Vector3(...(part.from ?? [0, 0, 0]));
  const to = new T.Vector3(...(part.to ?? [0, 1, 0]));
  const curve = new T.QuadraticBezierCurve3(
    from,
    new T.Vector3(via[0], via[1], via[2]),
    to,
  );
  if (curve.getLength() < 1e-6)
    throw Error(`Limb "${part.name ?? ''}" has zero length.`);
  const radius = part.radius ?? 0.1;
  const along = 8;
  const around = Math.max(3, detail);
  const stride = around + 1;
  const frames = curve.computeFrenetFrames(along, false);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const point = new T.Vector3();
  for (let s = 0; s <= along; s++) {
    const t = s / along;
    curve.getPoint(t, point);
    // Same convention as a straight limb: full radius at `from`, tapered at `to`.
    const r = radius * (1 + (taper - 1) * t);
    const normal = frames.normals[s];
    const binormal = frames.binormals[s];
    for (let i = 0; i <= around; i++) {
      const angle = (i / around) * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      positions.push(
        point.x + (cos * normal.x + sin * binormal.x) * r,
        point.y + (cos * normal.y + sin * binormal.y) * r,
        point.z + (cos * normal.z + sin * binormal.z) * r,
      );
      uvs.push(t, i / around);
    }
  }
  for (let s = 0; s < along; s++)
    for (let i = 0; i < around; i++) {
      const a = s * stride + i;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, d, b, d, c, b);
    }
  const startCap = positions.length / 3;
  positions.push(from.x, from.y, from.z);
  uvs.push(0, 0);
  const endCap = positions.length / 3;
  positions.push(to.x, to.y, to.z);
  uvs.push(1, 1);
  const lastRing = along * stride;
  for (let i = 0; i < around; i++) {
    indices.push(startCap, i + 1, i);
    indices.push(endCap, lastRing + i, lastRing + i + 1);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function limbGeometry(part: Part, detail: number, taper: number) {
  if (part.via) return curvedLimbGeometry(part, detail, taper, part.via);
  const a = new T.Vector3(...(part.from ?? [0, 0, 0]));
  const b = new T.Vector3(...(part.to ?? [0, 1, 0]));
  const radius = part.radius ?? 0.1;
  const delta = b.clone().sub(a);
  const length = delta.length();
  if (length < 1e-6) throw Error(`Limb "${part.name ?? ''}" has zero length.`);
  const geometry = new T.CylinderGeometry(
    radius * taper,
    radius,
    length,
    Math.max(3, detail),
  );
  const orient = new T.Quaternion().setFromUnitVectors(
    new T.Vector3(0, 1, 0),
    delta.clone().normalize(),
  );
  geometry.applyQuaternion(orient);
  geometry.translate(
    (a.x + b.x) / 2,
    (a.y + b.y) / 2,
    (a.z + b.z) / 2,
  );
  return geometry;
}

type BuildContext = {
  spec: AssetSpec;
  seed: number;
  count: { meshes: number };
  /** Its own stream, so surface placement does not shift with repeat scatter. */
  rng: () => number;
  /**
   * Every mesh finished so far, in build order, with the authored part it came
   * from. `rest` lands on these and `along` rides one of them, and both mean
   * "what already exists", which is the only order a builder can offer.
   */
  built: { mesh: T.Mesh; path?: number[] }[];
  /** Authored names to their paths, so `rest.on` and `repeat.path` resolve. */
  names: Map<string, number[][]>;
};

/**
 * Directions spread evenly over a sphere, offset by a seeded rotation so two
 * specs with different seeds scatter differently while each stays reproducible.
 * A Fibonacci spiral avoids the bunching at the poles that naive latitude and
 * longitude sampling produces.
 */
function spiralDirections(count: number, rng: () => number) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const turn = rng() * Math.PI * 2;
  const out: T.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i + turn;
    out.push(
      new T.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius),
    );
  }
  return out;
}

type Placement = { point: T.Vector3; normal: T.Vector3 };

/**
 * Find where copies should sit on the surface of the geometry already built.
 *
 * A radial repeat puts copies on a cylinder. Most bodies are not cylinders, so
 * decorations placed that way bury themselves at the waist and hang in the air
 * near the top — the single most common way an authored asset comes out wrong.
 * Casting a ray inward from outside the target lands each copy exactly on the
 * shape, whatever the shape is.
 */
function placeOnSurface(
  targets: T.Mesh[],
  wanted: number,
  band: [number, number] | undefined,
  rng: () => number,
): Placement[] {
  if (!targets.length) return [];
  const box = new T.Box3();
  for (const mesh of targets) box.expandByObject(mesh);
  const centre = box.getCenter(new T.Vector3());
  const reach = box.getSize(new T.Vector3()).length();
  const low = box.min.y;
  const height = Math.max(box.max.y - box.min.y, 1e-6);

  const raycaster = new T.Raycaster();
  const found: Placement[] = [];
  // Cast generously, then choose from everything that landed. Taking the first
  // matches instead would bunch them all at one end: the spiral runs pole to
  // pole, so the earliest hits inside a band are all at its top edge.
  const candidates = spiralDirections(Math.max(wanted * 12, 64), rng);
  for (const direction of candidates) {
    const origin = centre.clone().addScaledVector(direction, reach);
    raycaster.set(origin, direction.clone().negate());
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) continue;
    if (band) {
      const level = (hit.point.y - low) / height;
      if (level < band[0] || level > band[1]) continue;
    }
    found.push({
      point: hit.point.clone(),
      normal: (hit.normal ?? direction).clone().normalize(),
    });
  }
  if (found.length <= wanted) return found;
  // Stride through the hits so the chosen ones stay spread over the band.
  const stride = found.length / wanted;
  return Array.from({ length: wanted }, (_, i) => found[Math.floor(i * stride)]);
}

/** Build one mesh for a part. Shared by direct placement and surface placement. */
function makeMesh(part: PlacedPart, context: BuildContext, rigPart?: string) {
  const detail = part.detail ?? 6;
  // `deform.taper` and the bare `taper` say the same thing, so the shapes that
  // already take one are given the resolved value rather than being tapered
  // twice. `effectiveTaper` is shared with the field, which has to agree.
  const taper = effectiveTaper(part);
  const size = part.size ?? [1, 1, 1];
  const warp = warpFor(part.shape, part.deform);

  if (++context.count.meshes > MAX_MESHES)
    throw Error(
      `This spec expands past ${MAX_MESHES} meshes. Lower a repeat count.`,
    );

  const geometry =
    part.shape === 'limb'
      ? limbGeometry(part, detail, taper)
      : deformGeometry(
          geometryFor(part, detail, taper, warp),
          part,
          warp,
          size,
        );
  if (part.jitter)
    jitterGeometry(
      geometry,
      part.jitter,
      (context.seed + context.count.meshes * 7919) % 2147483647,
    );
  const mesh = new T.Mesh(
    geometry,
    new T.MeshStandardMaterial({
      color: part.color ?? context.spec.color,
      roughness: 1,
      flatShading: true,
    }),
  );
  mesh.name = part.name ?? part.shape;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (rigPart) mesh.userData.rigPart = rigPart;
  if (part.origin) mesh.userData.specPath = part.origin;
  // Surface mode rebuilds this part as a distance field rather than reading
  // its triangles back, so it needs the authored shape, not just the result.
  mesh.userData.prim = {
    shape: part.shape,
    size,
    taper,
    jitter: part.jitter,
    from: part.from,
    to: part.to,
    via: part.via,
    radius: part.radius,
    profile: part.profile,
    bevel: part.bevel,
    stations: part.stations,
    spine: part.spine,
    closed: part.closed,
    deform: part.deform,
    subtract: part.subtract,
    material: part.material,
  };
  return mesh;
}

function applyRotation(object: T.Object3D, degrees: readonly number[]) {
  object.rotation.set(
    T.MathUtils.degToRad(degrees[0]),
    T.MathUtils.degToRad(degrees[1]),
    T.MathUtils.degToRad(degrees[2]),
  );
}

/** Every mesh already built under this parent, as raycast targets. */
function targetsUnder(parent: T.Object3D) {
  const meshes: T.Mesh[] = [];
  parent.updateMatrixWorld(true);
  for (const child of parent.children)
    child.traverse((o) => {
      if (o instanceof T.Mesh) meshes.push(o);
    });
  return meshes;
}

/** Authored names to the paths that carry them, `jointBinder`'s index. */
function partPaths(
  parts: Part[],
  prefix: number[] = [],
  into = new Map<string, number[][]>(),
) {
  parts.forEach((part, index) => {
    const path = [...prefix, index];
    if (part.name) into.set(part.name, [...(into.get(part.name) ?? []), path]);
    if (part.children) partPaths(part.children, path, into);
  });
  return into;
}

/**
 * The one part this name points at.
 *
 * `binds` refuses a name two parts share and so does this: a scute told to
 * rest on "plate" when there are nine plates has no answer, and guessing the
 * first would be a placement the author cannot see or correct.
 */
function pathNamed(
  context: BuildContext,
  name: string,
  who: string,
  verb: string,
) {
  const found = context.names.get(name);
  if (!found?.length)
    throw Error(`"${who}" ${verb} "${name}", but no part is called that.`);
  if (found.length > 1)
    throw Error(
      `"${who}" ${verb} "${name}", but ${found.length} parts share that name. Give them distinct names.`,
    );
  return found[0];
}

/** Is this mesh's part the one at `root`, or something hanging off it? */
function beneath(path: number[] | undefined, root: number[]) {
  return Boolean(path && root.every((step, at) => path[at] === step));
}

function rootOf(object: T.Object3D) {
  let top = object;
  while (top.parent) top = top.parent;
  return top;
}

/**
 * A finished mesh's world triangles and bounds, remembered.
 *
 * Nothing moves a mesh once it is recorded — `rest` moves only the part it is
 * resting, and the model's own scale is applied after every part is placed —
 * so the reading cannot go stale, and a row of forty scutes resting on one
 * body reads that body's triangles once instead of forty times.
 */
const SETTLED = new WeakMap<T.Mesh, { tris: Triangles; box: T.Box3 }>();

function settled(mesh: T.Mesh) {
  let shape = SETTLED.get(mesh);
  if (!shape) {
    shape = { tris: worldTriangles(mesh), box: new T.Box3().setFromObject(mesh) };
    SETTLED.set(mesh, shape);
  }
  return shape;
}

function record(context: BuildContext, mesh: T.Mesh, part: PlacedPart) {
  context.built.push({ mesh, path: part.origin });
}

/**
 * Drop a placed part along one world direction until it touches another.
 *
 * The travel is worked out in world space and applied in the parent's, which
 * is the distinction `buildOnSurface` learnt the hard way: a part hanging off
 * a body that has been turned and carried still falls straight down, and
 * writing the world answer into a rotated parent's `position` sends it
 * sideways instead.
 *
 * Children are built afterwards and so come along untouched, keeping the
 * offsets the author gave them relative to the part that moved.
 */
function applyRest(
  part: PlacedPart,
  holder: T.Group,
  mesh: T.Mesh,
  parent: T.Object3D,
  context: BuildContext,
) {
  const rest = part.rest;
  if (!rest) return;
  const label = part.name ?? part.shape;
  const wanted =
    rest.on === 'any' ? null : pathNamed(context, rest.on, label, 'rests on');
  rootOf(parent).updateMatrixWorld(true);

  const step = new T.Vector3(...REST_STEPS[rest.from]);
  const axis = step.x !== 0 ? 0 : step.y !== 0 ? 1 : 2;
  const box = new T.Box3().setFromObject(mesh);
  const targets: Triangles[] = [];
  let named = 0;
  for (const entry of context.built) {
    if (wanted && !beneath(entry.path, wanted)) continue;
    named++;
    const shape = settled(entry.mesh);
    if (!inSweep(box, shape.box, axis)) continue;
    targets.push(shape.tris);
  }
  if (!named)
    throw Error(
      `"${label}" rests on "${rest.on}", but ${rest.on === 'any' ? 'nothing is' : `"${rest.on}" is not`} built before it. Put it later in the parts list.`,
    );
  const travel = targets.length
    ? contactTravel(worldTriangles(mesh), targets, step)
    : null;
  if (travel === null)
    throw Error(
      `"${label}" rests on "${rest.on}" from ${rest.from}, but it never meets it: nothing lies along that direction. Move the part over the target, or rest it from the side it should land on.`,
    );

  const landed = holder
    .getWorldPosition(new T.Vector3())
    .addScaledVector(step, travel + rest.sink);
  holder.position.copy(parent.worldToLocal(landed));
  holder.updateMatrixWorld(true);
}

function buildPart(
  part: PlacedPart,
  parent: T.Object3D,
  context: BuildContext,
  inheritedRig: string | undefined,
  depth: number,
) {
  if (depth > 8) throw Error('Spec nesting is deeper than 8 levels.');
  const rigPart = part.rigPart ?? inheritedRig;

  if (part.repeat?.mode === 'surface')
    return buildOnSurface(part, parent, context, rigPart, depth);
  if (part.repeat?.mode === 'along')
    return buildAlong(part, parent, context, rigPart, depth);

  const holder = new T.Group();
  holder.name = part.name ?? part.shape;
  holder.position.set(...(part.position ?? [0, 0, 0]));
  applyRotation(holder, part.rotation ?? [0, 0, 0]);
  parent.add(holder);
  const mesh = makeMesh(part, context, rigPart);
  holder.add(mesh);
  applyRest(part, holder, mesh, parent, context);
  record(context, mesh, part);

  for (const child of part.children ?? [])
    buildPart(child, holder, context, rigPart, depth + 1);
  return holder;
}

/**
 * Lay copies of a part along another part's spine.
 *
 * A row of scutes down a tail, teeth along a jaw, rivets down a seam: the
 * copies are the easy half, and the curve they sit on is the half an author
 * ends up computing by hand, one position at a time, and re-computing every
 * time the tail moves. Naming the tail instead keeps the row on it.
 *
 * The path has to be built already, for the same reason surface placement
 * needs its body first: this reads where the part actually ended up, so a row
 * follows a limb that has itself been moved, turned or rested.
 */
function buildAlong(
  part: PlacedPart,
  parent: T.Object3D,
  context: BuildContext,
  rigPart: string | undefined,
  depth: number,
) {
  const repeat = repeatSchema.parse(part.repeat);
  const label = part.name ?? part.shape;
  // The schema refuses `along` without a path, so this is only ever a name.
  const wanted = pathNamed(context, repeat.path ?? '', label, 'repeats along');
  const source = context.built.find(
    (entry) => entry.path?.length === wanted.length && beneath(entry.path, wanted),
  );
  if (!source)
    throw Error(
      `"${label}" repeats along "${repeat.path}", but "${repeat.path}" is not built before it. Put the path earlier in the parts list.`,
    );

  rootOf(parent).updateMatrixWorld(true);
  const spine = spineOf(
    source.mesh.userData.prim as PathPrim,
    source.mesh.matrixWorld,
  );
  const placements = placeAlong(
    spine,
    repeat.count,
    repeat.span,
    repeat.side,
  );

  const group = new T.Group();
  group.name = `${label}_along`;
  parent.add(group);
  parent.updateMatrixWorld(true);
  // The spine answers in world space and a holder is read in its parent's, as
  // in `buildOnSurface`.
  const toLocal = new T.Matrix4().copy(parent.matrixWorld).invert();
  const unturn = new T.Quaternion().setFromRotationMatrix(toLocal);
  const base = { ...part, repeat: undefined, mirror: undefined } as PlacedPart;
  const flip = part.mirror
    ? part.mirror === 'x'
      ? 0
      : part.mirror === 'y'
        ? 1
        : 2
    : null;

  const place = (
    copy: PlacedPart,
    position: T.Vector3,
    quaternion: T.Quaternion,
  ) => {
    const holder = new T.Group();
    holder.name = copy.name ?? copy.shape;
    holder.position.copy(position);
    holder.quaternion.copy(quaternion);
    group.add(holder);
    const mesh = makeMesh(copy, context, rigPart);
    holder.add(mesh);
    applyRest(copy, holder, mesh, group, context);
    record(context, mesh, copy);
    for (const child of copy.children ?? [])
      buildPart(child, holder, context, rigPart, depth + 1);
  };

  placements.forEach((placement, i) => {
    const copy: PlacedPart = {
      ...base,
      name: `${base.name ?? base.shape}_${i + 1}`,
      position: undefined,
      rotation: undefined,
    };
    const factor = (repeat.scaleStep ?? 1) ** i;
    // One draw per station, shared with the mirrored row: two rows that
    // differ in their irregularity are two decorations, not one mirrored one.
    const vary = repeat.sizeJitter
      ? 1 + (context.rng() - 0.5) * 2 * repeat.sizeJitter
      : 1;
    const scale = factor * vary;
    if (scale !== 1) {
      if (base.size)
        copy.size = [base.size[0] * scale, base.size[1] * scale, base.size[2] * scale];
      if (base.radius) copy.radius = base.radius * scale;
    }

    const position = placement.position.clone().applyMatrix4(toLocal);
    const quaternion = unturn.clone().multiply(placement.quaternion);
    // The part's own rotation turns it where it stands, after the path has
    // aimed it — a scute leaning back down the tail is `rotation` on the copy.
    if (part.rotation)
      quaternion.multiply(
        new T.Quaternion().setFromEuler(
          new T.Euler(
            T.MathUtils.degToRad(part.rotation[0]),
            T.MathUtils.degToRad(part.rotation[1]),
            T.MathUtils.degToRad(part.rotation[2]),
          ),
        ),
      );
    if (repeat.twist)
      quaternion.multiply(
        new T.Quaternion().setFromEuler(
          new T.Euler(
            T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
            T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
            T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
          ),
        ),
      );
    if (repeat.scatter)
      position.set(
        position.x + (context.rng() - 0.5) * 2 * repeat.scatter[0],
        position.y + (context.rng() - 0.5) * 2 * repeat.scatter[1],
        position.z + (context.rng() - 0.5) * 2 * repeat.scatter[2],
      );

    place(copy, position, quaternion);
    if (flip === null) return;
    // Reflecting one axis negates the rotation about the other two, the same
    // rule `flipPart` applies to an authored part's euler angles.
    const mirrored = new T.Quaternion(
      flip === 0 ? quaternion.x : -quaternion.x,
      flip === 1 ? quaternion.y : -quaternion.y,
      flip === 2 ? quaternion.z : -quaternion.z,
      quaternion.w,
    );
    place(
      flipPart(copy, flip),
      position.clone().setComponent(flip, -position.getComponent(flip)),
      mirrored,
    );
  });
  return group;
}

/**
 * Scatter copies of a part across the surface of whatever was built before it.
 *
 * The targets are the preceding siblings only. Raycasting the whole model
 * would let blossoms land on the soil mound and the twigs underneath the bush,
 * which is not what "put these on the body" means.
 */
function buildOnSurface(
  part: PlacedPart,
  parent: T.Object3D,
  context: BuildContext,
  rigPart: string | undefined,
  depth: number,
) {
  const repeat = repeatSchema.parse(part.repeat);
  const group = new T.Group();
  group.name = `${part.name ?? part.shape}_surface`;
  const targets = targetsUnder(parent);
  parent.add(group);

  if (!targets.length)
    throw Error(
      `"${part.name ?? part.shape}" uses surface placement but nothing is built before it. Put the body earlier in the parts list.`,
    );

  const placements = placeOnSurface(
    targets,
    repeat.count,
    repeat.band,
    context.rng,
  );

  const base = { ...part, repeat: undefined } as PlacedPart;
  const size = base.size ?? [1, 1, 1];
  const reach = Math.max(...size);
  // Raycasts land in world space, but a holder's position is read in its
  // parent's. Those are the same thing only when the parent sits at the origin
  // — which is why scattering onto a top-level body worked and scattering onto
  // a part that had been moved sent every copy off into space.
  parent.updateMatrixWorld(true);
  const toLocal = new T.Matrix4().copy(parent.matrixWorld).invert();
  const toLocalBasis = new T.Matrix3().setFromMatrix4(toLocal);
  for (const placement of placements) {
    const point = placement.point.clone().applyMatrix4(toLocal);
    const normal = placement.normal
      .clone()
      .applyMatrix3(toLocalBasis)
      .normalize();
    const holder = new T.Group();
    holder.name = part.name ?? part.shape;
    holder.position.copy(point);
    // Sink or lift the copy along the surface normal so it reads as part of
    // the body rather than balanced on it.
    holder.position.addScaledVector(normal, repeat.embed * reach * 0.5);
    if (repeat.scatter)
      holder.position.set(
        holder.position.x + (context.rng() - 0.5) * 2 * repeat.scatter[0],
        holder.position.y + (context.rng() - 0.5) * 2 * repeat.scatter[1],
        holder.position.z + (context.rng() - 0.5) * 2 * repeat.scatter[2],
      );
    if (repeat.align)
      holder.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), normal);
    if (part.rotation) {
      const turn = new T.Quaternion();
      const euler = new T.Euler(
        T.MathUtils.degToRad(part.rotation[0]),
        T.MathUtils.degToRad(part.rotation[1]),
        T.MathUtils.degToRad(part.rotation[2]),
      );
      holder.quaternion.multiply(turn.setFromEuler(euler));
    }
    if (repeat.twist) {
      const wobble = new T.Euler(
        T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
        T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
        T.MathUtils.degToRad((context.rng() - 0.5) * 2 * repeat.twist),
      );
      holder.quaternion.multiply(new T.Quaternion().setFromEuler(wobble));
    }
    const copy: PlacedPart = { ...base, position: undefined, rotation: undefined };
    if (repeat.sizeJitter) {
      const vary = 1 + (context.rng() - 0.5) * 2 * repeat.sizeJitter;
      if (base.size)
        copy.size = [base.size[0] * vary, base.size[1] * vary, base.size[2] * vary];
      if (base.radius) copy.radius = base.radius * vary;
    }
    group.add(holder);
    const mesh = makeMesh(copy, context, rigPart);
    holder.add(mesh);
    applyRest(copy, holder, mesh, group, context);
    record(context, mesh, copy);
    for (const child of part.children ?? [])
      buildPart(child, holder, context, rigPart, depth + 1);
  }
  return group;
}

function expand(part: PlacedPart, rng: () => number): PlacedPart[] {
  let copies: PlacedPart[] = [part];
  // Surface and along placement both need geometry that does not exist yet,
  // so they are left alone here and resolved in buildPart against what has
  // been built. Along carries its mirror through with it too: the two rows
  // are reflections of where the path put them, which is not a fact this
  // pass can know.
  const deferred = part.repeat?.mode === 'along';
  if (part.repeat && part.repeat.mode !== 'surface' && !deferred) {
    const {
      count,
      mode,
      offset,
      rotation,
      scaleStep,
      axis,
      radius,
      arc,
      scatter,
      twist,
      sizeJitter,
    } = {
      ...repeatSchema.parse(part.repeat),
    };
    const base = { ...part, repeat: undefined } as PlacedPart;
    copies = [];
    for (let i = 0; i < count; i++) {
      const copy: PlacedPart = { ...base, name: `${base.name ?? base.shape}_${i + 1}` };
      const position = [...(base.position ?? [0, 0, 0])] as [
        number,
        number,
        number,
      ];
      const spin = [...(base.rotation ?? [0, 0, 0])] as [
        number,
        number,
        number,
      ];
      if (mode === 'linear') {
        const step = offset ?? [0, 0, 0];
        for (let a = 0; a < 3; a++) position[a] += step[a] * i;
        const turn = rotation ?? [0, 0, 0];
        for (let a = 0; a < 3; a++) spin[a] += turn[a] * i;
      } else {
        const sweep = Math.abs(arc % 360) < 1e-6 && arc !== 0 ? arc / count : arc / Math.max(1, count - 1);
        const angle = T.MathUtils.degToRad(sweep * i);
        const r = radius ?? 1;
        const plane: Record<'x' | 'y' | 'z', [number, number]> = {
          y: [0, 2],
          x: [1, 2],
          z: [0, 1],
        };
        const [u, v] = plane[axis];
        position[u] += Math.cos(angle) * r;
        position[v] += Math.sin(angle) * r;
        const spinIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        // The (u, v) planes above are right-handed about x and z but
        // left-handed about y (x then z), so the copy's own turn has to run
        // the other way there — otherwise an asymmetric part comes out
        // mirrored on the copies at ±90°.
        spin[spinIndex] += (axis === 'y' ? -sweep : sweep) * i;
      }
      if (scatter)
        for (let a = 0; a < 3; a++) position[a] += (rng() - 0.5) * 2 * scatter[a];
      if (twist) for (let a = 0; a < 3; a++) spin[a] += (rng() - 0.5) * 2 * twist;
      copy.position = position;
      copy.rotation = spin;
      if (sizeJitter) {
        const vary = 1 + (rng() - 0.5) * 2 * sizeJitter;
        if (base.size)
          copy.size = [
            base.size[0] * vary,
            base.size[1] * vary,
            base.size[2] * vary,
          ];
        if (base.radius) copy.radius = base.radius * vary;
      }
      if (scaleStep && base.size) {
        const factor = scaleStep ** i;
        copy.size = [
          base.size[0] * factor,
          base.size[1] * factor,
          base.size[2] * factor,
        ];
        if (base.radius) copy.radius = base.radius * factor;
      }
      copies.push(copy);
    }
  }
  if (part.mirror && !deferred) {
    const axis = part.mirror;
    const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    copies = copies.flatMap((copy) => [
      copy,
      flipPart({ ...copy, mirror: undefined }, index),
    ]);
  }
  return copies;
}

function flipAxis(v: readonly number[], index: number) {
  const out = [...v] as [number, number, number];
  out[index] *= -1;
  return out;
}

/** The axis each `rest` direction falls along, and its opposite. */
const REST_AXIS = { above: 1, below: 1, '+x': 0, '-x': 0, '+z': 2, '-z': 2 } as const;
const REST_OPPOSITE = {
  above: 'below',
  below: 'above',
  '+x': '-x',
  '-x': '+x',
  '+z': '-z',
  '-z': '+z',
} as const;

/**
 * Reflect a part and everything hanging off it. Children carry local
 * transforms, so mirroring only the top of the branch would leave the two
 * sides asymmetric — an eye hung off a mirrored head has to move too.
 */
function flipPart(part: PlacedPart, index: number): PlacedPart {
  const rotation = [...(part.rotation ?? [0, 0, 0])] as [
    number,
    number,
    number,
  ];
  // Reflecting one axis negates rotation about the other two.
  for (let a = 0; a < 3; a++) if (a !== index) rotation[a] *= -1;
  const flipped: PlacedPart = {
    ...part,
    name: `${part.name ?? part.shape}_m`,
    position: flipAxis(part.position ?? [0, 0, 0], index),
    rotation,
    rigPart: mirrorRig(part.rigPart),
    children: part.children?.map((child) => flipPart(child, index)),
  };
  // A copy that fell from +x lands from -x once it is on the far side, and a
  // direction left alone would send the mirrored copy away from the body it
  // was meant to sit on.
  if (part.rest && REST_AXIS[part.rest.from] === index)
    flipped.rest = { ...part.rest, from: REST_OPPOSITE[part.rest.from] };
  if (part.from && part.to) {
    flipped.from = flipAxis(part.from, index);
    flipped.to = flipAxis(part.to, index);
    // The bend has to come with them, or the mirrored cable sags the wrong way
    // and its ends no longer meet what they were tied to.
    if (part.via) flipped.via = flipAxis(part.via, index);
  }
  if (part.spine)
    flipped.spine = {
      from: flipAxis(part.spine.from, index),
      to: flipAxis(part.spine.to, index),
      ...(part.spine.via ? { via: flipAxis(part.spine.via, index) } : {}),
    };
  return flipped;
}

function mirrorRig(rigPart: Part['rigPart']) {
  if (!rigPart) return rigPart;
  if (rigPart.endsWith('_l')) return `${rigPart.slice(0, -2)}_r` as typeof rigPart;
  if (rigPart.endsWith('_r')) return `${rigPart.slice(0, -2)}_l` as typeof rigPart;
  return rigPart;
}

function walk(
  parts: PlacedPart[],
  rng: () => number,
  prefix: number[] = [],
): PlacedPart[] {
  return parts.flatMap((part, index) => {
    const origin = [...prefix, index];
    // Tagging before expansion means every copy inherits the path for free,
    // because expand and flipPart both spread the part they are given.
    return expand({ ...part, origin }, rng).map((copy) => ({
      ...copy,
      children: copy.children ? walk(copy.children, rng, origin) : undefined,
    }));
  });
}

/**
 * Build a spec into a finished three.js model, rigged when the spec asks for it.
 * Deterministic: the same spec always produces the same geometry.
 *
 * `options` reaches surface mode only. `{ uv: false }` skips planning the
 * texture atlas, which is what every preview path passes — the geometry is
 * identical either way, so a model built without it can still be audited,
 * measured and drawn. Only the exporters need the layout, and they take the
 * default.
 */
export function buildSpec(input: unknown, options: SurfaceOptions = {}) {
  const whole = mark();
  const spec = parseSpec(input);
  let model = new T.Group();
  model.name = spec.name;
  const context: BuildContext = {
    spec,
    seed: spec.seed,
    count: { meshes: 0 },
    rng: random(spec.seed + 7919),
    built: [],
    names: partPaths(spec.parts),
  };
  // One stream for the whole expansion pass: walk visits parts in a fixed
  // order, so the same spec always draws the same numbers.
  const placement = random(spec.seed + 104729);
  options.onPhase?.('parts');
  const parts = mark();
  for (const part of walk(spec.parts, placement))
    buildPart(part, model, context, undefined, 0);
  measure('build.parts', parts);
  model.userData = { generator: 'Oddlings Studio', spec };
  if (spec.surface) {
    const blended = surfaceModel(
      model,
      spec.surface,
      new T.Color(spec.color),
      `${spec.kind}_surface`,
      options,
    );
    disposeScene(model);
    model = blended;
    // No finishing pass here: it would weld the vertex colours into one flat
    // material and recompute the normals the field already got right.
  } else {
    finishModel(model, spec.kind);
  }
  if (spec.rig || spec.joints?.length) options.onPhase?.('skinning');
  const skin = mark();
  if (spec.rig) model = rigCreature(model, spec.rig);
  else if (spec.joints?.length)
    model = rigJoints(model, spec.joints, jointBinder(spec));
  measure('build.rig', skin);
  model.scale.setScalar(spec.scale);
  model.updateMatrixWorld(true);
  measure('build', whole);
  return model;
}

/** JSON Schema for the spec, handed to agents so they can author against it. */
export function specJSONSchema() {
  return z.toJSONSchema(specSchema, { io: 'input' });
}
