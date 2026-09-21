# Changelog

## 0.1.0 — unreleased

First public cut of Oddlings Studio: procedural 3D game assets authored as JSON specs by agents or people, built into GLB packs with an audit that measures the geometry instead of eyeballing it.

### Authoring
- Spec format with primitives, lofts, lathes, prisms, `field` parts (signed-distance functions in the spec), prefabs (`defs` + reuse), `deform` (bend / twist / taper), a `surface` mode that fuses the parts into one manifold mesh with a triangle budget.
- Humanoid `rig` (14 bones, auto-weighting or explicit `rigPart`) and `joints` mechanisms (named pivots, `parent` chains, `spin` clips).
- Materials: colour, roughness / metalness / emissive baked to atlases; `paint_*` faceted materials.

### Tooling
- CLI: `blueprints`, `generate`, `mutate`, `new`, `build`, `render` (PNGs without a browser), `audit` (with `--visual`), `measure`, `notes`, `schema`, `inspect` (reads a GLB in Node: bones, chains, clips, triangles).
- MCP server exposing the same operations to agents, with a spec-authoring guide the README is derived from.
- The audit: hidden-triangle trimming, part budgets, clip-through checks while clips play, floating parts, skin-weight sanity, silhouette and proportion notes.

### Studio
- Web editor with viewport, outliner, follow mode (watch an agent edit a spec and see the viewport update), save-back, reviewer notes, draw marks (circle a part to give an agent a visual note).

### Output
- GLB packs with the skeleton described at `scenes[0].extras.oddlings` (bones, pivots, leaf ends, chains) so a game can drive the rig from code with no sidecar file. Each part is exported as its own placed node in faceted builds.

### Rigs and export (this cut)
- `joints` can now sit alongside a humanoid `rig`: a joint's `parent` may name a rig bone, so a character carries its own cape, tail or hair chain in one skeleton. Joint bones append after the rig's, and `binds`-bound parts are pinned before auto-weighting.
- Quadruped rig: `rig: { "kind": "quadruped", "bodyHeight", "bones": { Body, Hip/Knee/Ankle × FL/FR/BL/BR } }` with distance-based auto-weighting, `rigPart` names (`body`, `hip_fl`, …), Idle and Walk clips, and a starter from `oddlings new creature --rig quadruped`.
- `taper` now applies to `cone` (a frustum whose top radius is taper × bottom; 0 stays a point).
- GLBs no longer embed per-primitive authoring data; surface-mode exports are about a quarter of the size.
- Part nodes are documented: faceted, unrigged builds export one placed node per part, which engine code can turn on its own axes.
