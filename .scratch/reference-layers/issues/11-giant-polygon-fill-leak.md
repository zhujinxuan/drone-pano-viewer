# 11 — Giant polygon fill renders over holes/nearby ground (tangent-plane triangulation leak)

**Status:** ready-for-human — fix implemented and unit-verified (2026-09-16); needs one visual confirmation pass in the pano (mask layer over the FSGr232 pad area) before closing.

## What I ran

Candidates review session, photos dir `resources/2026-07-27-drone-panorama/step-01-panorama/outputs`, 17 layers incl. `基本农田和生态红线` = `…/step-00-reference-layers/outputs/avoid/mask-nongtian-hongxian.geojson` (2241 features, per-class explode, max ≤20k verts each). Viewing pano `wzbjm3m0` area (FSGr232).

## Expected

The mask must NOT cover the turbine/candidate pads. Verified data-side with hole-aware point-in-polygon on the exact served file (EPSG:4326 and reprojected 4529): `contains=False`, pad edge 22.8 m clear, center 38.1 m clear of the mask. The reference layer data is provably correct.

## Actual

In the pano the mask fill renders **on top of** FSGr232's pad — the brown fill covers ground that is a hole (allowed area) in the polygon. Distant boundaries look plausible; the leak is near-camera.

## Suspected mechanism (read-only)

`ReferenceOverlay.tsx` / `AnnotationOverlay.tsx` triangulate fills with earcut on **one tangent plane per feature** ("chord sag ≪ a pixel for ≤5 km edges"). The farmland mask rings span tens of km with km-scale holes; in that warped plane the hole-bridging fill spills into the hole — near the camera the spill is meters-to-hundreds-of-meters on ground. Possibly aggravated by the render-time decimation collapsing hole edges (fill ε = 5× stroke ε).

Reproducer math: take the served geojson, polygon P with a big hole; camera inside the hole; fill renders over the camera area. Verified `contains` on data = False while pixels show fill → rendering, not data.

## Workaround in use

Producer clips mask classes to turbines-bbox + 2 km (small rings → small tangent-plane error). Masks are semantic areas; far parts are never renderable anyway (600 m prefilter / 700 m cull).

## Suggested fix direction

Triangulate in a camera-local frame (or per-ring-segment window around the camera) instead of one feature-level tangent plane; or cap ring extent at import with an automatic bbox split for rings spanning > N km; test: hole containment must hold under any camera inside a hole.

## Comments

**2026-09-16 — fix implemented (camera-local stereographic triangulation)**

Root cause, narrowed while building the reproducer: the tangent plane's normal is the normalized centroid of all ring points, so any azimuthal vertex-density asymmetry tilts it off nadir; orthographic projection folds every ray > 90° from the normal onto the near side. A giant near-horizon exterior ring that surrounds the camera folds its far arc onto a near-camera hole ring, earcut bridges the "hole", fill covers the pad. The fix took the first suggested direction, in a stronger form: instead of a tangent plane or clip window, `triangulateRings` (moved to `app/src/lib/reference-fill.ts`) projects stereographically from the zenith pole — injective over the entire ground hemisphere for ANY camera (ground rays have pitch ≤ 0; nadir → origin, horizon → unit circle), so planar hole containment equals ground containment exactly, no clipping needed. Side benefit: the per-feature fill-face caches (tickets 10/14) are now provably cam-independent — the "near-affine reprojection keeps a valid triangulation valid" caveat is gone.

Verification: `app/src/lib/reference-fill.test.ts` reproduces the leak through the seam (300 m hole centered on the camera, 8 km exterior centered 5 km north; rays built with the real `makeProjector`, oracle = projection-independent 3D ray–triangle intersection). RED against the old tangent-plane math (in-hole ray hit 1 fill triangle, expected 0 — the other assertions passed, so the red is a genuine hole-bridge, not a vacuous null), GREEN after the fix. Full suite 257/257, `tsc --noEmit` clean. AnnotationOverlay deliberately untouched: its polygons are user-drawn, hole-less, and near-camera — the fold requires a surrounding giant ring. The producer-side bbox clip workaround can be dropped once the visual pass confirms.
