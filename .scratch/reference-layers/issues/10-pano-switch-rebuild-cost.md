# 10 — Per-pano-switch overlay rebuild re-derives everything (Vincenty-per-vertex cull + full re-triangulation)

**Status:** done

**Filed by:** maintainer, from the 2026-09-14 "browser super slow even after image loading" report (evidence: ticket 09's measurements — 234 served polygons at ~900 vertices avg).

## Diagnosis

`ReferenceOverlay.tsx` tears down and rebuilds the whole overlay on every photo switch (`useEffect(..., [viewer, cam, layers, visible])`). Per rebuild:

1. **Cull cost**: `featureIsCulled` (lib/reference-cull) runs `vincentyInverse` — iterative, trig-heavy — on *every vertex of every served feature*. With dense dissolved avoidance polygons that is ~160 k Vincenty inversions per `[`/`]` keypress (~0.3–0.8 s main-thread). The module docstring assumed "a small prefiltered set"; dissolved MultiPolygon avoidance layers (ticket 07) broke that assumption.
2. **Triangulation cost**: every visible polygon fill is re-run through `ShapeUtils.triangulateShape` (earcut with holes) and all GPU buffers re-allocated, although the triangulation topology does not depend on the camera.

## Fix (accepted design)

1. **Two-tier cull** in lib/reference-cull: precompute each feature's vertex bbox once per layer payload (referentially stable — features pass through by reference); per rebuild, reject whole features with a cheap planar bbox-vs-camera distance (linearized mPerDeg math, 100 m safety margin — planar-vs-geodesic error at this scale is sub-meter), and run the exact per-vertex Vincenty loop only for features in the margin band. Verdicts are identical to the old path by construction; the 1100 m spec threshold stays Vincenty-pinned.
2. **Triangulation cache** in ReferenceOverlay: `WeakMap<RefFeature, faces>` — earcut output (face indices into the ring vertex list) is cam-independent up to a near-affine tangent-plane reprojection, so cache it per feature and per switch only recompute ring vertex positions. Cache dies with the feature objects on layer reload — no invalidation logic.

## Acceptance

- [x] Cull verdicts unchanged (property test: fast path === exact Vincenty path over random cams/features incl. margin-band cases)
- [x] Per-switch cull cost on the real 松原 layer set drops from ~160 k Vincenty calls to bbox-scan + band confirms (benchmarked)
- [x] Polygon fills render identically (same vertices, same faces; only positions recomputed)
- [x] Scoped vitest green; live browser smoke: pano switching responsive with the reporter's 5 layers
- [x] spec.md §Client behavior + SKILL.md cull bullet updated
