# 11 — Render-side angular decimation + projector hoisting (dense producer polygons stall every pano switch)

**Status:** done

**Filed by:** maintainer, from user report 2026-09-14: "avoid-soft on → extremely slow; turbines only → still slow but not unresponsive".

## Diagnosis (measured, reporter's 松原 layer set)

- avoid-soft keeps one **68 k-vertex polygon** (bbox ~900 km — a dissolved super-region the producer's explode/simplify didn't break up). Every `[`/`]` switch re-projects all 68 k vertices, rebuilds line + fill buffers (~10 MB of typed arrays), and re-uploads to GPU — the ~150 ms/switch overlay residual seen in ticket 10's browser A/B.
- `vertexView` is already closed-form flat-earth (M/N radii) but recomputes cam-only terms (sin/pow/sqrt) per vertex.
- Turbines-only slowness is NOT the overlay: ticket 10's layers-off A/B showed ~2 s long tasks per switch regardless — JPEG decode + 14400×7200 texture upload. Fix lives in multi-pano-nav/01 (preload), not here.

## Fix (accepted design)

1. `makeProjector(cam)` in overlay-geometry.ts: hoist cam-only WGS84 terms; per-vertex work becomes 2 mults + hypot + atan2. `vertexView` delegates (API + tests unchanged).
2. `simplifyViewRays` (overlay-geometry.ts): Douglas-Peucker over projected (yaw, pitch), ε = 2e-4 rad (≈0.3 px at 1600 px/60° FOV — bounded, sub-pixel at any sane zoom). Applied in ReferenceOverlay only to LineString/Polygon rings with > 1000 vertices; lines and fills consume the same decimated rings so fill matches boundary. Closed rings keep first/last. Decimated fills skip the per-feature faces cache (earcut on the decimated ring is milliseconds).
3. Data contract untouched: served GeoJSON and the 1100 m cull are unchanged; decimation is render-only and visually bounded.

## Acceptance

- [x] `makeProjector` ≡ `vertexView` (equivalence test)
- [x] DP bounds deviation ≤ ε; keeps endpoints; closed rings stay closed; ≥ 3 vertices kept on closed rings; dense far runs collapse
- [x] Real-data benchmark: monster-polygon per-switch construction cost collapses
- [x] Scoped vitest + typecheck green; browser smoke: avoid-soft on, switching responsive, fill visually unchanged
- [x] spec.md §Client behavior + SKILL.md updated
