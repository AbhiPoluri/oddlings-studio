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

"size" is in the part's OWN axes, BEFORE "rotation". The shape is built and
fitted to the box first and turned afterwards, so the numbers describe the part
standing upright, not where it ends up. A cone you mean to point down +z is
size [0.16, 0.22, 0.16] with rotation [90, 0, 0] - 0.22 is its height along
local y, and the rotation lays that height along z. Write the box the shape
occupies before you turn it.

SHAPES
Most of the list is the usual primitives. Four of them are what separate a prop
that reads as blocks from one that reads as built:

- "extrude" sweeps a "profile" — an [x, y] polygon, convex or concave — along
  its own Z. "taper" scales the far end, so a hull plan-view outline with a
  pointed bow, extruded downwards with taper 0.76, gives you flared topsides
  and a keel narrower than the deck. This is the shape to reach for whenever a
  silhouette matters and a box will not do it: hulls, gun houses, roof plates,
  signage, a wing. Its "size" follows the rule above: the profile fills local x
  and y and the sweep runs along local z. A stock or a beam extruded sideways
  therefore has its LENGTH in size[0] and its sweep depth in size[2], however
  the "rotation" turns it afterwards.
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
- "loft" skins a run of cross-sections along a spine, which is the shape for
  anything whose silhouette changes down its length: hulls, torsos, necks,
  tails, horns, chimneys. Each station is { at, profile } - "at" a fraction of
  the spine's LENGTH, "profile" a 2D outline. With closed "mirror" (the
  default) you draw one side and the other is reflected in x and welded at
  the seam, so start and end the outline on the centreline; closed "none"
  takes the outline as a closed polygon as written. The "spine" runs straight
  from "from" to "to", or curves through "via"; leave it out and it runs
  along +Z, where the profile's x and y land on the part's x and y - a loft
  whose stations are all the same profile is exactly the extrude of it, which
  is the cheapest way to check your sections read the way you think. Sections
  ride the spine in a rotation-minimising frame, so a curved spine puts no
  twist in the middle of a hull; profiles with different point counts are
  paired by arc length, so give every station the same count and your corners
  stay where you drew them. Then it is fitted to "size" like every shape.
  With fewer than two stations a loft is a box.
- "deform" bends, twists and tapers a part along one of its own axes:
  { axis, bend, twist, taper }, degrees for the first two, a far-end scale for
  the third. "bend" curves the axis toward the next axis in cyclic order (x
  toward +y, y toward +z, z toward +x); on a cylinder, prism, cone or extrude
  "taper" is routed into the shape's own taper. Hold on to this: "size" is
  the box the part fills BEFORE it is bent, and a bend or twist reaches
  outside it - a 90 degree bend on a metre-long horn adds over half a metre.
  That is what lets both backends draw the identical shape, so place a bent
  part by its unbent box and check the result; for a bent hull, a loft with a
  curved spine gives a better solid than a bent box. Segments along the axis
  are added automatically; a twisted box still pinches a few percent between
  rings, so use a round section when the volume matters.

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
- "rest" drops a part until it touches another instead of asking you for the
  height. "on" names the part to land on, or "any" for everything authored
  before it; "from" is the side it falls from (above, below, +x, -x, +z, -z),
  and "sink" is how far past the contact to push, in metres, so a scute sits
  in the hide rather than on it. The builder sweeps the real triangles of both
  parts, so the answer is the surface and not the bounding box: a box rested
  on a sphere lands on the pole, and a repeat laid over a stepped or lumpy
  body lands every copy at its own height. A part that already overlaps its
  target is backed out until it is tangent, which is what makes "sink" mean
  the same depth for every copy of a row. The target has to be authored
  BEFORE the resting part; "any" also sees earlier copies of the row itself,
  so keep a row's copies clear of each other sideways. Nothing along that
  direction is a build error naming both parts - that is the case where you
  wanted a different "from".
- mode "along" lays a row down another part's spine. "path" names that part,
  "span" is the fraction of its length to cover (0 at its start), and "side"
  is which way round it the copies sit: up, down, left, right, or degrees
  turned about the path. A limb's spine is its from -> via -> to curve and the
  row rides at the limb's own radius, tapering with it; a capsule, cylinder,
  cone, prism or lathe is read along its own axis however it is rotated; and
  anything else along whichever way its "size" is longest. Copies are spaced
  evenly by arc length and turned so their +z runs along the path and their
  +y points out of it; "scaleStep", "sizeJitter", "twist" and "scatter" apply
  as they do to a linear repeat, the copy's own "position" is ignored because
  the path decides it, and "rotation" still turns the copy where it stands.
  "mirror" gives the row a twin reflected across the axis. Scutes down a
  tail, teeth along a jaw, rivets down a seam - and add "rest" as well when
  the row has to touch a body lumpier than the path's own surface.

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

MATERIALS
"material" on any part sets "roughness" (default 1), "metalness" (0),
"emissive" (none) and "emissiveStrength" (1); leaving it out is exactly the
matte finish every asset had before. Parts that share a colour and a tuple
share one material, so a faceted asset stays as cheap as it was. A fused
surface keeps one mesh and splits its triangles into groups by tuple, one glTF
material per group with vertex colours on, so an engine gets real materials
rather than a single flat shell; emissive strength travels as
KHR_materials_emissive_strength, which means a lamp authored at 3 arrives as a
lamp. Exports bake an extra atlas PNG per channel that actually varies - none
for an asset that authors no materials - and the OBJ's material library
carries Ns from roughness plus Ke and map_Ke for emission.

SUBTRACT
Set "subtract": true on a part to carve it out of the surface instead of
adding it. Surface mode only - the faceted builder has no CSG, so it builds
the part as the plain solid it was authored as and the audit warns
subtract-needs-surface. Parts fold in the order the spec lists them: a cut
removes everything blended before it, a cut after a cut carves the already-cut
field, and a part added after a cut fills the hole back in. A cut with nothing
in front of it does nothing. The rim where the cut meets the surface is
rounded by surface.blend, the same radius that rounds a join, so blend 0 gives
a hard edge. The cut's inner walls take the subtracting part's colour and
follow its bone - which it inherits from its parent unless you set rigPart -
so a window cut into a wall animates with the window, not the wall. Make the
cut deep enough to break the surface: one sunk entirely inside a solid hollows
out a sealed cavity, which the audit reports as a detached shell.

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

A spec may declare at most 64 joints, which is an eight-legged walker with a
hip, a knee and an ankle on every leg and room left over. Past that, bind
several parts to one joint rather than giving each its own.

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
it for speed. It goes up to 512; the grid is detail cubed, so 320 is a
33-million-point volume and 512 is four times that, several seconds and half a
gigabyte per build, worth it only for a hero asset with features finer than
its size divided by 320. budget goes up to 1,000,000 triangles. budget is the triangle count the mesh is decimated down to, so
you get a game budget rather than whatever the grid happened to produce.
shading "flat" keeps the studio's faceted look at a low budget; "smooth" reads
as a sculpt and wants a higher one.

One more knob decides whether the result reads as clean or as clay. A shell
decimated to a game budget is genuinely faceted — at 9,000 triangles on a
1.7 m character, neighbouring faces turn about 16 degrees on average — and flat
shading draws every facet as a tile, so a fused model comes out looking smudged
however carefully it was built. "crease" is an angle in degrees and replaces
"shading" when set: two faces that meet under it share one smooth normal, two
that turn harder keep a hard edge, so a pauldron shades as a curve while the
rim of a helm stays crisp. 0 is flat, 180 is smooth; 40 to 60 suits armour,
vehicles and machines, 80 or more a creature. The crease splits vertices along
hard edges in the finished mesh, which the audit and the exporter both
understand. There is no vertex-smoothing pass, on purpose: the sampled surface
is already within a fraction of a cell of the field, and relaxing vertices was
measured to widen the spread of facet angles, not narrow it.

  "surface": { "blend": 0.02, "detail": 256, "budget": 9000, "crease": 50 }

Do not add "jitter" to make plates look worked and then wonder why they look
rough: jitter is erosion, and under a crease it reads as exactly that.

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
Parts whose bounding box spans fewer than sixteen grid cells have up to
twenty-four of their vertices pinned against the decimator, so eyes, teeth,
gems and runes survive a tight surface.budget instead of being the first thing
collapsed away.

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

Some findings carry a "hint" with the fix as numbers, so you do not have to
work out which way and how far:

  "hint": { "move": [0, -0.031, 0], "toward": "hull" }

"move" is a translation to ADD to the part's "position", in spec units before
"scale" and in model space - a top-level part takes it as written; a child of a
rotated parent needs it turned into that parent's frame first. "toward" names
the part the fix is measured against. "grow" appears on detached-shell and is
the "surface.blend" that would close the gap; the gap itself is the finding's
"threshold", in the same units.
A detached-part hint moves the part until it touches the body; a no-surface
hint pushes it out along its neighbour's normal until one grid cell of it
stands proud. Apply the move and re-audit rather than guessing a second time.

MEASURING
Do not write a script to measure your own model. "measure_spec" (MCP) and
"oddlings measure" (CLI) report, for every authored part: its world bounding
box after "scale", how many meshes it expands into, the bone or joint carrying
it, how many vertices of the fused surface it owns in surface mode - zero being
the no-surface defect - and, for the parts you ask about, the NEAREST other
part with the signed gap to it. A positive gap is clear air between the two
surfaces; a negative one is how deep they interpenetrate. It also prints the
skeleton with the vertex count bound to each bone, which is how you check that
a leg is actually weighted to a leg.

Gaps are exact point-to-triangle distances between the authored primitives, not
bounding-box distances, so they are right for spheres, limbs and lathes and not
just for boxes. Pass a list of part names to measure a corner of a model
cheaply once you know where you are working.

REVIEW NOTES
A human reviewing an asset in the studio can pin a note to a part. Notes live
beside the spec: "specs/foo.spec.json" has "specs/foo.review.json", and each
note carries the part it is about, the text, and whether it is still open.

You must read them and act on them. An audit ends with "N open review notes"
whenever any exist, and "audit --json" carries them, so there is no way to miss
one. Read them with "review_notes" (MCP) or "oddlings notes <spec>", make the
change, then close each note with "resolve_note" (MCP) or
"oddlings notes <spec> --resolve <id> --reply \\"...\\"". The reply is not
optional politeness: it is the only thing the reviewer sees, and a note
resolved without one reads as a note ignored.

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

/**
 * Starter specs: one per kind of thing this tool makes.
 *
 * A blank page is where the avoidable mistakes come from. Every template below
 * is a working asset that already gets the conventions right — it faces +z, it
 * stands on the ground with nothing floating, every part is named, characters
 * pin their own bones and carry a `surface` block, the mechanism has a real
 * joint chain — so the first edit an author makes is about the shape they
 * want, not about the six rules they have not read yet.
 *
 * Each one passes `oddlings audit` as written, and a test holds them to it.
 * Keep them small: a template is read in full before it is edited.
 */
export const TEMPLATE_KINDS = [
  'creature',
  'person',
  'prop',
  'mechanism',
  'environment',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * `mechanism` is not one of the spec's four `kind` values — it is a prop with
 * moving parts, and the difference that matters is the `joints` block, not the
 * label. Everything else maps straight through.
 */
const TEMPLATES: Record<TemplateKind, AssetSpecInput> = {
  creature: {
    version: 1,
    name: 'Starter Creature',
    kind: 'creature',
    seed: 11,
    color: '#7f8f6a',
    rig: { hipHeight: 0.42, headPivot: 0.7, shoulderWidth: 0.16 },
    surface: { blend: 0.035, detail: 128, budget: 4000, shading: 'flat' },
    parts: [
      {
        name: 'body',
        shape: 'capsule',
        size: [0.42, 0.42, 0.8],
        position: [0, 0.55, 0],
        jitter: 0.12,
        rigPart: 'spine',
      },
      {
        name: 'head',
        shape: 'icosahedron',
        size: [0.34, 0.32, 0.34],
        position: [0, 0.72, 0.46],
        jitter: 0.2,
        rigPart: 'head',
      },
      {
        // Points down +z, which is the way the creature faces. The size is in
        // the cone's OWN axes, before the rotation: 0.22 is its height along
        // local y, and the 90 degrees about x lays that height along z.
        name: 'snout',
        shape: 'cone',
        size: [0.16, 0.22, 0.16],
        position: [0, 0.68, 0.6],
        rotation: [90, 0, 0],
        rigPart: 'head',
      },
      {
        name: 'foreleg',
        shape: 'limb',
        from: [0.15, 0.44, 0.28],
        to: [0.16, 0.02, 0.3],
        radius: 0.075,
        taper: 0.8,
        rigPart: 'arm_l',
        mirror: 'x',
      },
      {
        name: 'hindleg',
        shape: 'limb',
        from: [0.15, 0.44, -0.26],
        to: [0.16, 0.02, -0.24],
        radius: 0.085,
        taper: 0.8,
        rigPart: 'thigh_l',
        mirror: 'x',
      },
      {
        name: 'tail',
        shape: 'limb',
        from: [0, 0.62, -0.36],
        to: [0, 0.8, -0.72],
        via: [0, 0.64, -0.58],
        radius: 0.07,
        taper: 0.3,
        rigPart: 'spine',
      },
    ],
  },
  person: {
    version: 1,
    name: 'Starter Person',
    kind: 'person',
    seed: 3,
    color: '#5c6b8a',
    rig: { hipHeight: 0.5, headPivot: 0.88, shoulderWidth: 0.18 },
    surface: { blend: 0.03, detail: 128, budget: 4000, shading: 'flat' },
    parts: [
      {
        name: 'torso',
        shape: 'capsule',
        size: [0.34, 0.44, 0.24],
        position: [0, 0.68, 0],
        rigPart: 'spine',
      },
      {
        name: 'head',
        shape: 'sphere',
        size: [0.26, 0.3, 0.26],
        position: [0, 1.02, 0],
        rigPart: 'head',
      },
      {
        // The face. A figure with no front reads backwards from every angle
        // that is not straight on, and +z is the front.
        name: 'nose',
        shape: 'cone',
        size: [0.07, 0.09, 0.07],
        position: [0, 1.0, 0.15],
        rotation: [90, 0, 0],
        rigPart: 'head',
      },
      {
        // Authored once and mirrored, which swaps the _l binding to _r. Wave
        // lifts Arm_R, so the free hand belongs on -x.
        name: 'arm',
        shape: 'limb',
        from: [0.16, 0.86, 0],
        to: [0.24, 0.52, 0.05],
        radius: 0.06,
        taper: 0.8,
        rigPart: 'arm_l',
        mirror: 'x',
      },
      {
        name: 'leg',
        shape: 'limb',
        from: [0.1, 0.52, 0],
        to: [0.11, 0.03, 0.02],
        radius: 0.085,
        taper: 0.85,
        rigPart: 'thigh_l',
        mirror: 'x',
      },
    ],
  },
  prop: {
    version: 1,
    name: 'Starter Lantern',
    kind: 'prop',
    seed: 5,
    color: '#5a5f66',
    parts: [
      {
        // Sitting on y 0. There is no ground plane to rest against, so a prop
        // that starts above zero is a prop that floats in every scene.
        name: 'base',
        shape: 'cylinder',
        size: [0.17, 0.04, 0.17],
        position: [0, 0.02, 0],
        detail: 8,
      },
      {
        name: 'body',
        shape: 'box',
        size: [0.14, 0.2, 0.14],
        position: [0, 0.13, 0],
        bevel: 0.015,
        color: '#c8b26a',
      },
      {
        name: 'pane',
        shape: 'box',
        size: [0.09, 0.13, 0.012],
        position: [0, 0.13, 0.069],
        color: '#f2e6b8',
      },
      {
        name: 'cap',
        shape: 'cone',
        size: [0.2, 0.08, 0.2],
        position: [0, 0.27, 0],
        detail: 8,
      },
      {
        name: 'ring',
        shape: 'torus',
        size: [0.06, 0.06, 0.02],
        position: [0, 0.33, 0],
      },
    ],
  },
  mechanism: {
    version: 1,
    name: 'Starter Signpost',
    kind: 'prop',
    seed: 9,
    color: '#6b5a44',
    // Two joints in one clip, the second hanging off the first: the sign
    // trails the bracket by a quarter cycle instead of moving with it welded.
    joints: [
      {
        name: 'Swing',
        at: [0, 1.52, 0.42],
        binds: ['hanger'],
        spin: {
          axis: 'x',
          mode: 'swing',
          degrees: 16,
          seconds: 3.2,
          drift: 0.1,
          clip: 'Swing',
        },
      },
      {
        name: 'Sign',
        parent: 'Swing',
        at: [0, 1.45, 0.42],
        binds: ['sign'],
        spin: {
          axis: 'x',
          mode: 'swing',
          degrees: 5,
          seconds: 3.2,
          drift: 0,
          clip: 'Swing',
          phase: 90,
        },
      },
    ],
    parts: [
      {
        name: 'post',
        shape: 'cylinder',
        size: [0.09, 1.6, 0.09],
        position: [0, 0.8, 0],
        detail: 8,
      },
      {
        name: 'bracket',
        shape: 'box',
        size: [0.055, 0.055, 0.5],
        position: [0, 1.52, 0.22],
        bevel: 0.008,
      },
      {
        // The pivot is at the top of this, not at the middle of the sign —
        // put `at` anywhere else and the sign spins in place.
        name: 'hanger',
        shape: 'limb',
        from: [0, 1.52, 0.42],
        to: [0, 1.43, 0.42],
        radius: 0.014,
      },
      {
        name: 'sign',
        shape: 'box',
        size: [0.04, 0.34, 0.44],
        position: [0, 1.28, 0.42],
        bevel: 0.01,
        color: '#b9a179',
      },
    ],
  },
  environment: {
    version: 1,
    name: 'Starter Outcrop',
    kind: 'environment',
    seed: 21,
    color: '#6d7264',
    parts: [
      {
        name: 'mound',
        shape: 'cylinder',
        size: [2.4, 0.32, 2.4],
        position: [0, 0.16, 0],
        detail: 7,
        jitter: 0.25,
      },
      {
        name: 'boulder',
        shape: 'icosahedron',
        size: [1.1, 1.0, 1.0],
        position: [-0.5, 0.5, -0.2],
        jitter: 0.3,
      },
      {
        name: 'trunk',
        shape: 'limb',
        from: [0.55, 0.2, 0.3],
        to: [0.72, 1.5, 0.18],
        via: [0.6, 0.9, 0.3],
        radius: 0.16,
        taper: 0.55,
        color: '#4d3f2e',
      },
      {
        name: 'canopy',
        shape: 'icosahedron',
        size: [1.5, 1.1, 1.5],
        position: [0.75, 1.8, 0.2],
        jitter: 0.25,
        color: '#5f7a4a',
      },
      {
        // Dropped onto the parts above rather than ringed at a fixed radius,
        // which is what keeps them on the rock instead of in the air beside
        // it. `band` holds them to the bottom fifth of the silhouette.
        name: 'stone',
        shape: 'icosahedron',
        size: [0.26, 0.22, 0.26],
        jitter: 0.35,
        color: '#7c8071',
        repeat: {
          count: 9,
          mode: 'surface',
          band: [0, 0.2],
          embed: -0.4,
          scatter: [0.06, 0.02, 0.06],
          sizeJitter: 0.4,
        },
      },
    ],
  },
};

/** A starter spec for one kind of asset. Returns a fresh copy every call. */
export function specTemplate(kind: TemplateKind, name?: string): AssetSpecInput {
  const template = TEMPLATES[kind];
  if (!template) throw Error(`No template for "${kind}".`);
  const copy = structuredClone(template);
  if (name) copy.name = name;
  return copy;
}
