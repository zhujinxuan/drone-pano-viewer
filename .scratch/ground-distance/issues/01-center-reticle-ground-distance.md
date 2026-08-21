# 01 — Center reticle + live ground-distance readout

Status: needs-triage
Type: task

## Goal

When the user tilts the view so the screen center points at the ground, show
an estimated distance to that ground point, computed from the displayed pano's
altitude and the live camera pitch. Flat-ground assumption: ground = a plane
at the takeoff point's elevation.

## Geometry

Inputs:

- `h` = `drone-dji:RelativeAltitude` of the currently displayed pano (meters
  above takeoff point). Per-photo, parsed client-side.
- `p` = live view-center pitch from photo-sphere-viewer (radians; **negative =
  looking down**, +π/2 up, -π/2 nadir — matches DJI sign convention).

For `p < 0`:

- horizontal distance `d = h / tan(|p|)` — from the point below the drone to
  the aimed ground point (map-meaningful, primary).
- slant range `r = h / sin(|p|)` — line-of-sight along the view ray
  (secondary, in parentheses).

At nadir (`p = -90°`): `d = 0`, `r = h`. As `p → 0`, both → ∞; the 5 km cap
(below) absorbs the tan→0 blowup, so **no extra near-horizon clamp is needed**.

## Display (settled 2026-08-21 grilling)

- **Reticle**: small crosshair fixed at the exact center of the view,
  always on. Absolute-positioned, centered sibling inside `.viewer-wrap`,
  `z-index: 10`, `pointer-events: none` (model on `.title-flash` / `.hud`
  in `app/src/index.css`). Never blocks dragging.
- **Readout**: appended to the existing HUD line in `app/src/App.tsx`:
  `yaw 132° · pitch -38° · FOV 62° · dist 850 m (slant 940 m)`.
  Updates live with the existing 10 Hz HUD push.
- **Formatting**: meters, rounded to 10 m (`320 m`, `4850 m`).
- **Cap**: any value > 5000 m renders as `> 5 km` (applied per-number —
  slant ≥ horizontal always, so slant can cap while horizontal doesn't).
- **No-intersection cases** → `dist —`:
  - `p ≥ 0` (ray never meets flat ground), or
  - `RelativeAltitude` missing/unparseable for the photo.

## Integration points (2026-08-21 scout recon)

- `app/src/components/MetadataPanel.tsx` — already parses
  `AbsoluteAltitude`/`RelativeAltitude` via exifr (`xmp:true`) + regex
  fallback into panel-local `meta` state. Lift `RelativeAltitude` to App via
  a new callback prop, following the existing `onCaptureTime` pattern. No new
  parsing.
- `app/src/App.tsx` — HUD state already carries `pitch` (radians) via PSV
  `position-updated` + 10 Hz throttle. Add altitude to state, compute
  `d`/`r`, render the extra HUD field + the reticle `<div>` in
  `.viewer-wrap`.
- `app/src/index.css` — add `.reticle` rule (centered, z-10,
  pointer-events:none). Mind the `.viewer-wrap:has()` rule that shifts `.hud`
  when the EXIF panel opens.
- Server/manifest: **no change** — altitude is strictly client-side XMP;
  `/api/photos` (`app/src/lib/scan.ts`) stays lon/lat-only.

## Known limitations (document in HUD tooltip or CONTEXT.md)

- `RelativeAltitude` is takeoff-relative, **not true AGL**: on slopes or over
  buildings the real ground deviates from the assumed plane; error grows with
  terrain relief and with shallow pitch.
- Earth curvature ignored (intentional; within the 5 km cap the flat-model
  error is small relative to the terrain-relief error above).
- 4:3 non-pano frames (see `.scratch/multi-pano-nav/issues/02`) project
  distorted on the sphere; the readout still computes but its meaning there is
  out of scope for this ticket.

## Acceptance criteria

- Crosshair visible at view center at all times; never intercepts pointer
  events.
- HUD shows `dist …` and updates while panning/tilting (≤ 10 Hz).
- At nadir: `dist 0 m (slant ≈ h)`.
- `pitch ≥ 0` or missing altitude → `dist —`.
- Distances > 5000 m render `> 5 km`; otherwise meters rounded to 10 m.
- Switching photos re-reads that photo's `RelativeAltitude`.

## Comments

- 2026-08-21 — Opened after grilling round. Settled decisions:
  Q1 altitude = XMP `RelativeAltitude` (AGL above takeoff); Q2 show both
  distances, horizontal primary + slant secondary; Q3 above-horizon → `—`;
  Q4 always meters rounded to 10 m under the 5 km cap; Q5 HUD line +
  always-on reticle (no toggle key). User: ticket only, do not implement yet.
- 2026-08-21 — Implemented (frontend-only: new `app/src/lib/ground-distance.ts`
  + test, `onRelativeAltitude` prop in MetadataPanel, HUD `dist` field +
  `.reticle` in App/index.css). TDD at the geometry seam (11 tests),
  typecheck clean, browser smoke: pitch 0° → `dist —`; -19.9° → exact match
  vs independent recomputation; -0.5° → `> 5 km (slant > 5 km)`. Two-axis
  /code-review: Standards pass; Spec found 3 deviations, all fixed (removed
  unrequested both-capped collapse, added HUD `title` tooltip with the
  known-limitations text, spec-literal `h = 0` → `0 m`).
