# 10 — Monster-polygon rebuild cost: project-then-decimate order leaves an 80k-ring pathology

**Status:** done (maintainer triage 2026-09-16): app-side items 1+2 implemented by ticket 14 (ground-space LOD precompute before projection + cam-independent cacheable fills for coarse features — measured: far fills triangulate once per payload, not per switch). Item 3 landed in layer-level form: ticket 13's 200 k-vertex server warning (the ticket-09 triage had already scoped the warning at layer level). Producer-side per-class-split discipline remains good practice and is what the warning nudges toward.

## What I ran

Backup-decision-round session (per ticket 09 command, 5 layers: primary/backup/candidates/avoid-hard/avoid-soft), photos dir `resources/2026-07-27-drone-panorama/step-01-panorama/outputs`. After adding cadastral masks (基本农田/基本草原/林地湿地) to the hard union, the user reported "superslow".

## Measured (2026-09-15, `GET /api/reference-layers`)

| State | Payload | avoid-hard top-1 polygon verts | avoid-soft top-1 |
|---|---|---|---|
| masks merged into one cross-class union | 6.68 MB / 278 ms | **82,571** | 68,156 |
| per-class unions + 10 m DP on masks (producer fix) | 3.67 MB / 158 ms | 11,273 | 4,025 |

## Root cause (read-only code analysis)

1. **`projectedPath` decimates only AFTER projecting every vertex** (`ReferenceOverlay.tsx` ~L285-311: `vertices.map(project)` then DP). A camera-spanning 82.5k-vertex ring (a dissolved farmland mask touches the 600 m prefilter circle of nearly every pano, and the vertex-based 700 m cull can never drop it) pays the full geodesic projection on **every rebuild** — the decimation saves earcut/GPU but not the projection.
2. **Decimated features bypass the `fillFaces` triangulation cache** (comment at ~L364: decimated rings "triangulate fresh and never touch the cache") — so the monster re-triangulates per switch too.
3. Producer whole-feature semantics ("no clipping") mean one giant feature is drawn whole at every pano — feature count looks small (386) while drawn vertex count is ~160k.

## Producer-side mitigation already applied (works today)

Emit per-source-class features instead of one cross-class union + class-specific DP (10 m for cadastral masks, 2 m for buffers): max polygon 82.5k → 11.3k verts, and small features let the 700 m cull actually drop most of the layer per pano. Session feels normal again. Boundary precision note: the 10 m DP is visual only; authoritative inside/outside checks stay script-side.

## Suggestions for the app

1. **Cheap pre-projection decimation**: run a planar (lon/lat or local equirectangular) DP at a small ε *before* the geodesic `project`, or window ring vertices to the camera cull radius (segments fully outside ~700 m + margin collapse to their entry/exit points). The angular decimator then only pays geodesic for survivors. This is the 10× lever for camera-spanning rings.
2. **fillFaces cache for decimated features**: key by (feature, decimated-vertex-count + first/last vertex) or make the decimation viewport-stable (fixed anchor grid) so indices stay cacheable across pans.
3. Optional: a producer hint — when a served feature exceeds e.g. 20k vertices, log a console/server warning suggesting per-class split, so producers learn the pattern without reading overlay internals.

## Impact

Wind-project avoidance layers are dissolved unions of cadastral data by nature; any producer following the "single union per class-group" instinct recreates the 80k-ring case. Item 1 makes the viewer robust regardless of producer discipline.
