# 02 — North-offset input: live sphere correction for pano misalignment

Status: needs-triage
Type: task

## Goal

If a stitched pano turns out not to be north-aligned, the user can type a
**north offset** and watch the sphere rotate until the compass matches
reality — live, persisted, applied to every downstream bearing (HUD yaw,
compass, ticket 01's target WGS84).

Default is `0` = assume north-aligned (user decision 2026-08-21: no
calibration gate).

## Semantics

`offset` (degrees, 0.1° resolution) = the true compass bearing that the pano
image's center column (PSV yaw 0) actually points at. Applied as
`sphereCorrection: { pan: offset, tilt: 0, roll: 0 }` — the mesh rotates
under the camera, so after correction the camera yaw **is** the true
bearing. The exact sign is pinned down by the smoke test against the
compass, not by reasoning.

Pan only. Tilt/roll leveling is a non-goal.

## Mechanism (settled 2026-08-21 grilling, Q2)

PSV v5 supports this natively (verified in
`app/node_modules/@photo-sphere-viewer/core`): `sphereCorrection` is a
Viewer config folded into the shader's model matrix, and
`viewer.setOption("sphereCorrection", …)` re-applies it live
(`renderer.setSphereCorrection`). Two integration points in
`app/src/App.tsx`:

- The Viewer is re-created on every pano switch → pass
  `sphereCorrection: { pan: offset, ... }` from state at construction.
- On offset change while viewing → `viewer.setOption("sphereCorrection", …)`
  (fallback: `viewer.renderer.setSphereCorrection(...)` if setOption doesn't
  forward it).

Because the mesh physically rotates, the compass plugin and HUD yaw need **no
correction code** — they read camera-frame yaw, which becomes true bearing by
construction. Visual feedback while nudging is the calibration UX: align a
known N–S feature with the compass rose.

## Scope & persistence (settled, Q1)

- **One app-wide value**, `localStorage["pano.northOffsetDeg"]`, applies to
  every pano and every playlist batch. Rationale: the offset is a property of
  the drone/stitching workflow, not of individual panos.
- Precedence: `?north=<deg>` URL param > localStorage > `0`. Changing the
  value writes localStorage and mirrors into `?north` via `replaceState`
  (same pattern as `?pos`), so a URL captures the corrected session.

## UI (settled, Q3)

- New **"North offset" row in the EXIF panel's Position group** (right side,
  beside the GPS/RTK rows): numeric input (0.1° step) + nudge buttons
  ±0.1° / ±1°. Applies on change, live.
- The row is interactive state, not photo metadata: offset state lives in
  `App`; `MetadataPanel` receives `northOffset` + `onNorthOffsetChange` props
  and renders the row. (First interactive control inside the panel — keep the
  row's styling consistent with `.dji-mp-row`; input needs
  `pointer-events: auto`, already the panel body's default.)
- Value `0` shows as `+0.0°`; the row is always visible (it's config, not
  detected metadata).

## Interaction with ticket 01

Ticket 01's copy payload and target math consume the HUD yaw unchanged — the
correction is upstream in the sphere. When the offset ≠ 0 the payload appends
` · north+<x.x>°` (specced in ticket 01).

## Acceptance criteria

- Typing/nudging the offset visibly rotates the pano live; compass rose and
  HUD yaw reflect the corrected bearing immediately.
- Value survives page refresh (localStorage) and pano switches (`[`/`]`).
- `?north=5` loads with 5° applied; `?north` stays in sync on change.
- Offset `0` = pixel-identical behavior to today (no rotation, no payload
  field).
- Optional calibration script (from ticket 01's fact-find: LRF target
  bearings vs XMP yaw across panos) can be run to *discover* the value; not
  required for release.

## Comments

- 2026-08-21 — Opened after grilling round. Settled: Q1 app-wide localStorage
  + `?north=` override (user's "each playlist batch" intent is covered —
  same drone ⇒ same convention ⇒ one value serves every batch);
  Q2 sphereCorrection rotation over compute-layer offset (single code path,
  compass/HUD/target natively consistent, visual nudge feedback);
  Q3 EXIF panel Position row (user's "on the right?" instinct) with input +
  ±0.1°/±1° nudge buttons.
- 2026-08-22 — Implemented. One placement deviation, endorsed by the Spec
  reviewer: the row renders as a standalone "Viewer" group atop the panel
  instead of inside the Position group — buildGroups drops empty groups, so
  a Position-group row would vanish on nogps panos, contradicting this
  ticket's own always-visible criterion. PSV facts pinned: `parseAngle`
  treats numbers as radians (we pass radians); `setOption("sphereCorrection")`
  is public and live. Browser smoke: 15° offset visibly rotates the sphere,
  persists across reload, mirrors `?north=`, and a `?north=5` override with
  clean storage stays session-local until the first user change.
