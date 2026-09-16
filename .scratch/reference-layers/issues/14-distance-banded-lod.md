# 14 — Distance-banded LOD: aggressively trim reference features beyond 200 m

**Status:** done (2026-09-16)

**Filed by:** maintainer, user request 2026-09-16: "avoidance areas are mostly far from the pano; we don't need detail far from the viewpoint — aggressively trim when distance to pano > 200 m; three.js is super slow during loading and dragging with the avoidance layer on."

## Research basis

Standard practice everywhere (tippecanoe/vector tiles, mapshaper, terrain/game LOD): precompute a small set of LOD bands **once**, select per feature by camera distance; nobody re-simplifies per camera move. Screen-space error of a ground-space error `eps` at distance `d` is `≈ eps/d` rad (≈ 935 px/rad at 1080p/60° FOV). Band switches here happen only on pano switches (the camera is discrete per photo), so no hysteresis is needed — documented choice.

## Diagnosis (why tickets 10/11/12 weren't enough)

- 10/11 made the per-switch cost *bounded* but still O(served vertices): every `[`/`]` re-projects every vertex of every unculled feature (the 68 k-vertex monster included) before angular DP can drop them, and decimated fills re-triangulate per switch (no cache possible — decimation is cam-dependent).
- The monster polygon is served whole whenever any part of it is within 600 m of any pano, so panos near the farm always pay it.

**This ticket implements app-side suggestions 1+2 of `10-monster-polygon-rebuild-cost.md`** (cheap pre-projection decimation = the ground-space LOD below; cacheable fills for decimated features = cam-independent coarse rings). That ticket's producer-side mitigation stays valid discipline; the viewer must be robust without it. Close 10-monster-polygon-rebuild-cost when this lands.

## Design

1. **Ground-space LOD precompute, cam-independent, cached per feature** (new lib `reference-lod.ts`, WeakMap discipline of ticket 10): each LineString/Polygon ring is Douglas-Peucker-simplified once in local planar meters (mPerDeg scales at the ring latitude — the codebase's documented planar convention) at `FAR_LOD_EPS_M = 3 m`, kept indices addressing the original ring.
   - 3 m at 200 m ≈ 0.015 rad ≈ 14 px at 60° FOV worst case, shrinking with distance — visible corner-cutting only when zoomed into far features; accepted by the user ("aggressive").
2. **Band selection per feature per build** (`reference-cull.ts` companion): a feature is FAR when no vertex is within `NEAR_BAND_M = 200 m` of the camera — planar underestimating scales (same conservative direction as the cull: underestimate ⇒ any "far" verdict is certainly far; borderline features render near/full-fidelity). Early-exit vertex scan; bbox-reject features are already culled before this runs.
3. **Far render path** (ReferenceOverlay): project only the simplified rings; fill triangulation of the coarse rings is cam-independent → cached per feature (second WeakMap) — earcut once per feature ever, not per switch. Strokes additionally get the ticket-11 angular DP (far runs collapse to sub-pixel anyway). Near path unchanged.
4. Data contract untouched: served GeoJSON, the 600 m prefilter, the 700 m cull, and click-inspect (full geometry) are unchanged; LOD is render-only.

## Acceptance

- [x] Ground DP: deviation bounded by ε (property test), endpoints kept, closed rings stay closed with ≥ 3 vertices, cam-independent (pure function of geometry)
- [x] Band verdict: vertex within 200 m → near; all vertices beyond → far; conservative at the boundary (planar underestimate never renders a truly-near feature coarse)
- [x] Real-data-shaped benchmark: per-switch projection work for a far 68 k-vertex monster collapses to the simplified ring size
- [x] Scoped vitest + typecheck green; spec.md §Client behavior + SKILL.md render bullet updated

## Results (2026-09-16)

- New lib `reference-lod.ts` (`simplifyGroundM` ground DP, `lodGeometry` far geometry, `NEAR_BAND_M=200` / `FAR_LOD_EPS_M=3` / `SLOW_LAYER_VERTEX_BUDGET=50_000`); `entryIsFar` band verdict in reference-cull.ts sharing the cull's underestimating scales (bbox fast path → early-exit planar vertex scan; no Vincenty).
- Benchmark (synthetic 68k-vertex wiggly ring 3–8 km out, Node, one-off script since deleted): band verdict 6.3 ms/switch (camera inside the monster bbox → full planar scan, still no geodesics); LOD precompute 50 ms **once per payload** (cached per feature), 68 000 → 5 475 vertices; per-switch projection 5.25 → 1.4 ms on this deliberately worst-case wiggle. The bigger structural win: far fills triangulate **once per payload** (lodFillFaces) instead of per switch.
- Real-data smoke (松原 reporter set, 271 panos, all 5 layers enabled incl. 67 760-vertex avoid-hard): 8 draw calls/frame; synthetic drag frame times p50/p90/p99/max = 8/8/9/9 ms.
- Also closes the app-side items 1+2 of `10-monster-polygon-rebuild-cost.md` (pre-projection decimation + cacheable fills for decimated features).
