# 03 — Ground-capture lib: yaw/pitch ray → ground lon/lat + err

Status: done
Blocked by: —

Read `.scratch/annotations/spec.md` first. The computation already exists inline in `App.tsx`'s `copyRecord` (App.tsx ~L216-247) built on `app/src/lib/ground-distance.ts` and `app/src/lib/geodesy.ts` (`vincentyDirect`) and the error model in `app/src/lib/copy-record.ts`. This ticket extracts it into a reusable seam; `App.tsx` rewiring is ticket 07's job — **do not edit App.tsx**.

## Target

New pure module `app/src/lib/ground-capture.ts` (+ test). May add small exports to existing libs if needed, but do not change their behavior.

## Change

1. `groundTarget(cam: CameraFix & { relAltM: number }, yawDeg: number, pitchDeg: number) → { lon, lat, errM } | null` — flat-ground projection of a view ray: horizontal distance from `groundDistance(relAltM, pitchRad)`, target position via `vincentyDirect(cam.lat, cam.lon, yawDeg, horizontal)`, `errM` from the copy-record error model (pitch sensitivity + 1 m terrain + position σ — reuse/export that computation rather than reimplementing). Returns `null` when there is no ground point: pitch at/above horizon, missing/zero/negative altitude, or missing position — the same conditions that render `tgt n/a` / `—` today.
2. North offset: yaw is already corrected by `sphereCorrection` at the sphere level, so this function takes view-true yaw and needs no offset parameter. (Verify this against how `copyRecord` consumes yaw today — if the existing code applies the offset at computation time instead, mirror that and note it in your report.)
3. `centroidView(cam, vertices: [lon,lat][]) → { yawDeg, pitchDeg }` — inverse direction for the "click list item → camera swing" feature: bearing via Vincenty inverse from cam to centroid, pitch from flat-ground distance and altitude. Add `vincentyInverse` to `geodesy.ts` if not present, TDD'd against known GeodTest vectors like the existing direct function (check the existing test file for the pattern). Returns null when cam position is missing.

## Acceptance

Scoped vitest green for the new/changed lib tests: ground point matches a hand-computed Vincenty worked example; null cases (horizon, no altitude, no position) covered; inverse agrees with direct (round-trip within float tolerance); errM monotonic in pitch shallowness. `npx tsc --noEmit` clean for touched files. Do NOT run the full suite, do NOT edit App.tsx or any component, do NOT run formatters/linters.

## Result

Delivered `app/src/lib/ground-capture.ts` (+18 tests) and `vincentyInverse` in `geodesy.ts` (+10 tests); scoped suites 39/39 green, `tsc --noEmit` clean for all touched files (only pre-existing concurrent errors in ticket 05's AnnotationPanel.tsx remain). Contracts for 04/05/07: `GroundCam = CameraFix & { relAltM: number }`; `groundTarget(cam | null, yawDeg, pitchDeg) → { lon, lat, errM } | null` (cam widened to nullable so "missing position" is a callable null case); `centroidView(cam | null, [lon,lat][]) → { yawDeg, pitchDeg } | null` (yaw normalized [0,360), nadir when centroid is directly below); `vincentyInverse(lat1, lon1, lat2, lon2) → { distanceM, bearingDeg }` (coincident → {0, 0}). Verified per ticket point 2: App.tsx `copyRecord` passes PSV's `hud.yaw` straight into `vincentyDirect` — the north offset lives in `sphereCorrection` at the sphere level, so `groundTarget` correctly takes view-true yaw with no offset parameter. errM reuses the exported `estimateErrorM`/`positionSigmaM` from `copy-record.ts` unchanged; `relAltM` must be strictly > 0 (h = 0 → null, stricter than bare `groundDistance` which keeps 0 m, per this ticket's null-case list). No edits to App.tsx or any component.
