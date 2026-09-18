import type { AssetSpecInput } from '../lib/asset-spec';

export const SPEC_GUIDE = `A spec describes an asset directly, as a tree of primitives. Nothing is sampled
from a generator, so you control the exact silhouette.

COORDINATES
Y is up, +Z is front, so a character's own left is +x. One unit is one metre. A character reads well between
0.8 m and 2 m tall. Rotations are Euler XYZ in degrees.

SIZING
Every shape is fitted to its "size" bounding box, so a sphere with
size [0.6, 0.4, 0.6] is a squashed ball 0.6 m wide and 0.4 m tall. The
exception is "limb", which is drawn between "from" and "to" with "radius".

SHAPES
Most of the list is the usual primitives. Four of them are what separate a prop
that reads as blocks from one that reads as built:

- "extrude" sweeps a "profile" — an [x, y] polygon, convex or concave — along
  its own Z. "taper" scales the far end, so a hull plan-view outline with a
  pointed bow, extruded downwards with taper 0.76, gives you flared topsides
  and a keel narrower than the deck. This is the shape to reach for whenever a
  silhouette matters and a box will not do it: hulls, gun houses, roof plates,
  signage, a wing.
- "lathe" revolves a "profile" of [radius, height] pairs about its own Y.
  Radii are never negative, and the result is SOLID to its axis: a lathe is
  a filled body of revolution, not a shell. A hat brim therefore needs a
  profile that runs out along the underside and back in along the top, and a
  robe is a solid column that will swallow anything you place inside it. Step
  the radius back out near the top and you have a funnel with a lip; the same
  trick gives you vases, bells, domes, capstans, chimney pots.
- "bevel" (metres, box and extrude) cuts one flat facet across each edge. Two
  or three centimetres on a deckhouse is the difference between a machined
  panel and a cardboard carton, because a chamfer catches a highlight and a
  sharp edge does not. It costs: 44 triangles against a plain box's 12, so
  bevel the shapes a viewer reads the silhouette of and leave the rest sharp.
  It also has to fit — no wider than half the shortest side.
- "via" on a limb bends it through a point, as a quadratic curve from "from"
  through "via" to "to". Hang a cable between a mast and a funnel by putting
  "via" below the straight line between them and it sags like a cable instead
  of being strung like a wire.

A profile is a silhouette, not a measurement: it gets fitted to "size" like
every other shape, so the numbers in it only have to be in proportion to each
other, and "size" still means the bounding box you asked for. Two to sixty-four
points, at least three for an extrude, and no crossing itself. Leave "profile"
off and a lathe is a plain cylinder and an extrude is a plain box, which makes
them safe to switch a part to before you have drawn the outline. One caution:
"mirror" reflects where a part sits - position, from, to, via and the
rotations about the other two axes all flip - but not the part's own outline,
so a mirrored extrude with an asymmetric profile is a second left-hand bracket,
not a right-hand one. Write the mirrored profile out as its own part.

COMPOSITION
- children inherit their parent's transform, so build a head once and hang
  eyes, horns and ears off it. A child's "position" is RELATIVE to its parent,
  not a world coordinate: a head at [0, 1, 0] with an eye at [0.1, 0.05, 0.14]
  puts the eye at [0.1, 1.05, 0.14]. Writing the world position there instead
  is the single most common way to end up with a model twice as tall as you
  meant. The exception is "limb", whose "from" and "to" are already in the
  parent's frame, so a limb's own children use the same numbers the limb does.
- mirror: "x" duplicates a part on the far side and swaps _l / _r rig bindings,
  so author one arm, not two.
- repeat builds an array: mode "linear" steps by "offset" and "rotation" each
  time, mode "radial" orbits "axis" at "radius" across "arc" degrees. Use it for
  teeth, spikes, fence posts, windows. Both turn each copy about the PARENT's
  origin, not about the copy itself, so a linear repeat cannot fan fingers and
  a radial one cannot ring claws around an off-centre staff - author those
  individually. And a part's own "rotation" turns it in place; it does not
  move it. Four sails that share a position and differ only in rotation fan
  around one corner, not around the hub - swing the positions too, or use a
  radial repeat, which does both.
- mode "surface" is the one to reach for when decorating a body: blossoms on a
  bush, barnacles on a hull, rivets on a tank, moss on a rock. Each copy is
  dropped onto the surface of the parts authored BEFORE it in the list, so the
  body comes first and the decoration after. "band" limits it to a height slice
  of that body, 0 at its foot and 1 at its crown, and "embed" sinks each copy
  into the surface as a fraction of its own size. There is no radius to guess,
  which matters because a radius that clears the widest point of a body leaves
  copies hanging in the air everywhere the body is narrower. That single
  mistake accounts for most floating parts.
- a plain repeat is perfectly regular, which reads as machined. For anything
  grown — foliage, rocks, barnacles, blossoms — add "scatter" (max random
  offset per axis, in metres), "twist" (max random rotation in degrees) and
  "sizeJitter" (proportional size variation). They are seeded from the spec, so
  the irregularity is reproducible. A ring of flowers with no scatter looks like
  a clock face; the same ring with scatter [0.07, 0.23, 0.07] looks like a bush.
  When you scatter a decoration over a body, push its "radius" out past the
  body's own silhouette or the scatter will bury it inside.

LOOK
Keep "detail" low (4-8). The studio's look is faceted and flat-shaded, and a
low-poly primitive reads better than a smooth one. "jitter" (0.1-0.4) erodes a
shape along its normals with seeded noise, which turns a sphere into a rock and
a cylinder into a weathered trunk. Same spec, same seed, same geometry, always.

Under surface mode both behave differently. A part's own "detail" does nothing,
because the part is never triangulated - resolution comes from the "detail"
inside the surface block instead. And "jitter" perturbs the blended field
rather than a part's vertices, so it still reads as erosion but at a gentler
amplitude - and the amplitude scales with the part's SMALLEST dimension, so
the same number barely ripples a wide lathe and clearly roughens a thin limb.
Raise jitter rather than part detail if a surface asset looks too clean.

RIGGING
Add a "rig" block to skin the asset to the 14-bone skeleton and export Idle,
Walk, Jump, Wave and Attack. hipHeight is where the legs meet the body,
headPivot is the base of the neck, and shoulderWidth is half the distance
between the shoulders, all in metres. Those three numbers place the spine
column only: the arm pivots sit at hipHeight + 0.1 and the thigh, shin and
foot pivots are pinned at y 0.34, 0.19 and 0.05 whatever you set. That fits a
figure of 1 to 1.3 m. Taller or shorter, set "rig.bones" - absolute positions
per bone, named Arm_L, Forearm_L, Thigh_L, Shin_L, Foot_L and their _R
twins, plus Hips, Spine, Head - or the shoulders end up at the waist and the
ankles underground. Wave lifts Arm_R, so put the free hand on -x.

Parts without a "rigPart" are auto-weighted by where their centre sits, against
FIXED thresholds that do not follow your rig numbers: above y 0.82 binds to the
head, below y 0.36 to the nearer leg, wider than 0.28 from the centre line to
the nearer arm, and everything else blends hips into spine. Those thresholds
suit a character roughly 1 to 1.3 m tall standing on the ground plane. Build at
that scale and auto-weighting is free; then use the top-level "scale" field if
the engine needs a giant or a gnome, since it multiplies the finished model.

If your proportions fall outside that range, do not rely on auto-weighting —
set "rigPart" explicitly on every part. A 1.8 m figure with its torso centred
above y 0.82 would otherwise bind its whole chest to the head bone.

Three measurements cannot describe every body, so "rig.bones" moves individual
bones outright:

  "rig": { "hipHeight": 0.48, "headPivot": 0.9, "shoulderWidth": 0.28,
           "bones": { "Head": [0, 1.05, 0.06], "Arm_L": [-0.42, 0.7, 0.05] } }

Each entry is an ABSOLUTE model-space position, in the same space part
positions use, replacing whatever the measurements derived for that bone. The
names are the rig's own: Root, Hips, Spine, Head, Arm_L, Forearm_L, Arm_R,
Forearm_R, Thigh_L, Shin_L, Foot_L, Thigh_R, Shin_R, Foot_R. Anything else is
refused. Moving a bone carries its children — drop Arm_L and the forearm goes
with it — and the two sides are independent, so set Arm_L and Arm_R yourself if
you want them to match. Skin weighting reads vertex positions, not bone
positions, so moving a bone never re-binds geometry: use it to put a pivot
where the body actually hinges, not to re-weight a part. Root is the exception
worth knowing: Walk, Jump and Attack key its position, so an override there
sets the rest pose and Idle, and is driven over by the clips that move it.

JOINTS
"rig" describes a character and nothing else: its bones are hips and shoulders
placed from body measurements. For anything else that moves - a swinging tire,
a creaking sign, a turning wheel, a lid - use "joints" instead. A spec has one
skeleton, so the two cannot both be set.

  "joints": [
    { "name": "Swing", "at": [0.47, 0.72, 0.12], "binds": ["rope"],
      "spin": { "axis": "x", "degrees": 22, "seconds": 3.2, "clip": "Swing" } },
    { "name": "Tire", "parent": "Swing", "at": [0.46, 0.4, 0.12],
      "binds": ["tire"],
      "spin": { "axis": "x", "degrees": 6, "seconds": 3.2,
                "clip": "Swing", "phase": 90 } }
  ]

Each joint becomes one bone at "at", in the same unscaled space part positions
use. Everything named in "binds" rides that bone, and so do its children, so
binding a branch brings its leaves with it. Everything else stays on a static
root bone. Names must be unique among the parts they bind - an ambiguous or
missing name fails the build rather than binding to the wrong thing.

"spin" gives the joint a looping clip named after it. mode "swing" (the
default) is a pendulum: it eases out to ±degrees and back, starting from the
bind pose, with a small figure-eight "drift" off its plane (a fraction of
degrees, default 0.15) that makes a rope read as a rope - set drift 0 for a
hinge, a sign or a cap on a bearing. mode "turn" is a wheel: one full linear
revolution per "seconds", no drift, the sign of degrees giving the direction.
Sails, wheels, propellers and drills want turn; a swing that tries to reach
180 degrees will sweep its load through whatever it hangs from.
Place "at" at the real pivot - the top of the rope, the hinge of the lid - not
at the centre of the thing that moves, or it will spin in place instead of
swinging. Leave "spin" off for a bone you only want to pose from engine code.

"parent" hangs one joint off another by name, which is how you build a chain
rather than a row of independent pivots: the tire above hangs off the rope, so
the rope's swing carries it and the tire only adds its own small turn on top.
"at" stays ABSOLUTE whether a joint has a parent or not - put the pivot where
you see it and the offset is worked out for you. Joint names must be unique,
"Root" is taken by the static bone, and a missing parent or a loop is refused
at parse time. Omit "parent" for a joint that hangs off the root.

"clip" puts several joints in ONE clip - without it each joint gets a clip of
its own, and two clips cannot be relied on to play in step, so a chain comes
apart. Every joint sharing a clip must repeat the same "seconds"; disagreeing
is an error. "phase" is degrees of lag along that shared cycle, so a joint
trails what it hangs from: 90 on the tire means it reaches the top of its arc a
quarter of a cycle after the rope does, which is most of what stops a chain
looking welded together.

MESH BACKEND
By default each part is exported as its own closed solid, and the model is a
pile of primitives pushed into each other. That reads fine but it is not a game
asset: the buried faces cost triangles nothing can see, there is no single
surface to unwrap, and the separate solids slide apart from each other when the
rig bends them.

Add a "surface" block and the same parts are instead treated as a signed
distance field, blended together and re-meshed into ONE continuous manifold
polygon mesh. The spec does not change; only the geometry that comes out does.

  "surface": { "blend": 0.03, "detail": 128, "budget": 6000, "shading": "flat" }

blend is how softly the parts melt into one another, in metres. It closes gaps
up to HALF its own width, so a blend of 0.06 fuses parts sitting 0.03 apart.
Zero welds them with a hard crease instead. detail is the sampling resolution
along the longest axis - raise it to resolve small features like teeth, lower
it for speed. budget is the triangle count the mesh is decimated down to, so
you get a game budget rather than whatever the grid happened to produce.
shading "flat" keeps the studio's faceted look at a low budget; "smooth" reads
as a sculpt and wants a higher one.

Use surface for anything organic, and for anything that has to deform: a
creature, a person, a character. Leave it off for hard-surface props and
architecture where you want the primitives to stay crisp and separate.

Two things behave differently under surface. Small features need detail to
survive: the grid cell is longest-axis / detail, and a feature needs three
cells to exist at all - a 3 cm tooth on a 2 m body is invisible at detail 64.
Past that, decimation is the real floor: the simplifier is allowed about 2% of
the longest axis of error, so on a 1.9 m figure anything shallower than ~4 cm
tends to be flattened whatever the detail. Small parts must also be PROUD of
their neighbour, not merely present - colour and rig binding go to whichever
part is nearest each surface vertex, so a recessed eye or a buried buckle owns
nothing and disappears without a trace. The audit's no-surface finding names
those. And parts keep their
own colour as vertex colours on the one mesh rather than as separate materials,
so the whole asset exports as a single draw call.

UVS AND THE COLOUR ATLAS
Every exported mesh carries a UV0 channel; you do not ask for it and there is
no spec field for it. In faceted mode the UVs are three.js's own per-primitive
ones, so each part is unwrapped in its own 0-1 square and parts overlap each
other - fine for tiling a material, not an atlas. In surface mode the fused
shell is unwrapped automatically: each triangle is box-projected along
whichever of six axis directions it faces, triangles are grouped into charts
by direction and owning part, and the charts are packed into one 1024x1024
atlas with 2-texel gutters. The unwrap is deterministic, and the seams are cut
only on the way out, so the mesh you audit is still one welded, closed shell.

A surface asset also writes <name>.png next to the model: the per-part colours
baked at those atlas UVs, referenced from the .mtl as map_Kd. The GLB keeps
the colours as vertex colours and does not embed the image, so point a
material at the PNG after import if you want it there. Charts are bounding-box
projections, not a true unwrap - expect roughly a quarter of the atlas to be
covered, and repaint by editing part colours in the spec rather than by hand.

CHECKS
Every build is audited and the result comes back with it. An audit.ok of false
means a real defect, not a style note: parts left hanging in mid-air, a model
that falls into separate pieces, or geometry that would bind to the wrong bone.
Read the findings, fix the spec, build again. The audit_spec tool runs the same
checks without writing files, so iterate with that. The commonest error is a
decoration placed at a fixed radius around a body that is not a cylinder — the
copies near the top of a dome end up in the air. Push the radius out, drop the
scatter, or place fewer of them. There is no ground plane: a stone lying on
the ground next to a tower touches nothing and is an error, so overlap it
into the plinth or leave it out.

BUDGET
Specs cap at 200 top-level parts and 4000 meshes after mirrors and repeats
expand. A game-ready character usually needs 10-40 parts.

One repeat can make up to 512 copies, which is what dense foliage needs - a
convincing tree canopy runs to several hundred individual leaves. The 4000-mesh
ceiling is the real limit, and a nested repeat that multiplies past it fails by
name rather than hanging. Reach for a second repeat only when you want the
copies to differ, say a layer of larger leaves over a layer of smaller ones.`;

export const EXAMPLE_SPEC: AssetSpecInput = {
  version: 1,
  name: 'Lantern Keeper',
  kind: 'creature',
  seed: 42,
  color: '#93cec8',
  rig: { hipHeight: 0.5, headPivot: 0.95, shoulderWidth: 0.3 },
  surface: { blend: 0.03, detail: 128, budget: 4000, shading: 'flat' },
  parts: [
    {
      name: 'head',
      shape: 'icosahedron',
      size: [0.62, 0.58, 0.6],
      position: [0, 1.02, 0],
      jitter: 0.3,
      rigPart: 'head',
      children: [
        {
          name: 'eye',
          shape: 'sphere',
          size: [0.13, 0.13, 0.13],
          position: [0.15, 0.05, 0.27],
          color: '#1d2321',
          mirror: 'x',
        },
        {
          name: 'horn',
          shape: 'cone',
          size: [0.1, 0.3, 0.1],
          position: [0.14, 0.3, 0],
          rotation: [0, 0, -14],
          color: '#d2c385',
          mirror: 'x',
        },
        {
          name: 'tooth',
          shape: 'cone',
          size: [0.05, 0.09, 0.05],
          // Centred on the jaw, not running off one side of it.
          position: [-0.08, -0.18, 0.23],
          rotation: [180, 0, 0],
          color: '#f2efe6',
          repeat: { count: 3, mode: 'linear', offset: [0.08, 0, 0] },
        },
      ],
    },
    {
      name: 'torso',
      shape: 'capsule',
      size: [0.5, 0.62, 0.42],
      position: [0, 0.62, 0],
      jitter: 0.15,
      rigPart: 'spine',
    },
    {
      name: 'arm',
      shape: 'limb',
      from: [0.26, 0.8, 0],
      to: [0.42, 0.42, 0.06],
      radius: 0.075,
      taper: 0.7,
      rigPart: 'arm_l',
      mirror: 'x',
    },
    {
      name: 'leg',
      shape: 'limb',
      from: [0.15, 0.36, 0],
      to: [0.17, 0.02, 0.02],
      radius: 0.09,
      rigPart: 'thigh_l',
      mirror: 'x',
    },
    {
      name: 'backspike',
      shape: 'cone',
      size: [0.08, 0.16, 0.08],
      position: [0, 0.95, -0.2],
      color: '#6f8f86',
      repeat: { count: 5, mode: 'radial', axis: 'y', radius: 0.26, arc: 180 },
    },
  ],
};
