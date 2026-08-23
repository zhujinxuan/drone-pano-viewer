# 04 — Drawing overlay: three.js shapes + DOM labels on the sphere

Status: done
Blocked by: — (code against the `AnnFeature` type contract in `.scratch/annotations/spec.md`; ticket 01 implements that exact shape — do not wait for it, and do NOT edit `annotations.ts` yourself; define a local minimal interface matching the spec if the module isn't there yet)

Read `.scratch/annotations/spec.md` first — "Rendering" and "Capture & interaction" sections are binding.

## Target

New files only: `app/src/components/AnnotationOverlay.tsx` (+ CSS, matching existing component CSS conventions) and any small pure helpers under `app/src/lib/`. Do NOT edit App.tsx (ticket 07 wires you in).

## Change

1. **React component** `AnnotationOverlay({ viewer, features, inProgress, selectedId, onLabelPositions })`-ish props (you own the exact prop shape; document it in your report and in the file header — ticket 07 will conform to it):
   - `viewer`: the PSV `Viewer` instance. `features`: current photo's finished entities. `inProgress`: `{ kind: 'line' | 'polygon', vertices: [lon,lat][] } | null`. `selectedId`.
   - Renders into the PSV three.js scene: finished lines/polylines (per `kind`), polygons as filled semi-transparent faces + outline, points as small billboarded markers, in-progress shape with a distinct "sketch" style (dashed/brighter), selected entity highlighted. Overlay meshes at slightly smaller radius than the sphere so they render on top of the photo from inside. Colors: match the app's existing palette; distinguish kinds by color, selection by glow/width, not by color alone.
   - Get the three.js scene from PSV internals the supported way for 5.15.1 (`viewer.renderer` / `dataHelper` — check `app/node_modules/@photo-sphere-viewer/core/index.d.ts` for what's public; `sphericalCoordsToViewerCoords` / vector conversions exist on `dataHelper`). Convert lon/lat → sphere position via the pano's own camera position + flat-ground inverse: vertices are ground lon/lat, the overlay must place them at the correct yaw/pitch ray from the camera (use the `centroidView`-style inverse math per vertex — if ticket 03's `ground-capture.ts` exists use it, otherwise write the minimal inverse locally and note the duplication for 07 to clean up).
2. **DOM labels**: label text rendered as absolutely-positioned divs projected per-frame (`dataHelper.sphericalCoordsToViewerCoords`), hidden when behind the camera or off-screen; pointer-events route to the list, labels themselves are display-only in v1.
3. **Camera swing helper**: expose `swingTo(viewer, target: { yawDeg, pitchDeg })` (animated `viewer.rotate`) for ticket 07.
4. **Cleanup**: remove all three.js objects on unmount / prop change (no leaks across photo switches — PSV re-renders per pano).

## Acceptance

`npx tsc --noEmit` clean for new files. No tests required (smoke-tested in browser by the integrator) — but any pure conversion helper you write goes in `lib/` with a vitest. Report your exact prop interface and any PSV-internal access you relied on. Do NOT run the full suite, do NOT edit App.tsx / vite.config.ts / cli.ts, do NOT run formatters/linters.

## Result

Shipped `app/src/components/AnnotationOverlay.tsx` (+ `AnnotationOverlay.css`), pure helpers in `app/src/lib/overlay-geometry.ts` (+ vitest, 10/10 green), and `app/src/lib/three-core.d.ts` (minimal ambient "three" declarations — three is only a transitive dep of PSV and ships no types; replace with `@types/three` when three becomes direct, 07). `npx tsc --noEmit` clean project-wide; component import chain smoke-tested through vite/vitest.

- **Props (07 conforms)**: `{ viewer: Viewer; cam: OverlayCam | null ({lat,lon,relAltM} — current photo's fix; null draws nothing); features: OverlayFeature[] ({id, kind:"point"|"line"|"polygon", label, vertices:[lon,lat][] — polygon rings WITHOUT closing dup}); inProgress: {kind:"line"|"polygon", vertices:[lon,lat][]} | null; selectedId: string | null; onLabelPositions?: ({id,x,y,visible}[]) => void }`. Types exported: `OverlayFeature`, `InProgressShape`, `LabelPosition`, `AnnotationOverlayProps`; `OverlayCam` from lib/overlay-geometry. Also exports `swingTo(viewer, {yawDeg, pitchDeg}, speed="50dps")` — PSV `animate`, shortest yaw arc, cancels running animation. Mount inside `.viewer-wrap` (label layer is `inset:0`, pointer-events none, z-index 5).
- **PSV public API used (5.15.1)**: `viewer.renderer.addObject/removeObject` (scene root, NOT the rotated mesh container → overlay ignores sphereCorrection by design, matching the view-true yaw convention the app already uses); `dataHelper.sphericalCoordsToVector3/sphericalCoordsToViewerCoords/isPointVisible`; `viewer.addEventListener("render")` for per-frame label projection; `viewer.needsUpdate()`; `CONSTANTS.SPHERE_RADIUS`.
- **Geometry**: overlay radius 9.92 (halo 9.965); dashed bright-yellow sketch style + closing-edge preview for in-progress; selection = white halo line + bigger sprite markers + CSS glow (never color-only); polygon fill triangulated on the ring's tangent plane via `ShapeUtils`; full rebuild on prop change, full dispose on teardown (no leaks).
- **Duplication for 07 to fold**: `vertexView` (ground lon/lat → view-true yaw/pitch, WGS84 local radii) + `verticesCentroid` in `overlay-geometry.ts` overlap ticket 03's `ground-capture.ts`/`centroidView` — unify on 03's seam.
