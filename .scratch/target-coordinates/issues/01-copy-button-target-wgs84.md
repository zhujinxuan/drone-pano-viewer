# 01 — Copy button on HUD + target WGS84 in the copy payload

Status: needs-triage
Type: task

## Goal

A copy button at the right end of the HUD puts a full measurement record on
the clipboard — including the WGS84 coordinates of the ground point at the
view center and a live error estimate — so a 踏勘 observation can be pasted
straight into QGIS/奥维/a report.

## Copy payload (settled 2026-08-21 grilling, Q1+Q5)

Single line, ` · `-separated, target coords in the payload only (HUD stays
compact):

```
<id> · cam <lat>,<lon> (<src>) · yaw <x.x>° · pitch <x.x>° · fov <x.x>° · dist <h> (slant <s>) · tgt <lat>,<lon> ±<err> m[ · north+<x.x>°]
```

- Coordinates: decimal degrees, **5 decimals (~1 m)** — matches the honesty
  of the error budget; more decimals are false precision.
- `<src>`: `RTK σ<x.xx> m` when `RtkStd*` present, `GNSS ±3 m` when only
  `GpsStatus` (e.g. "Normal"), `geohash ±20 m` for the fallback below.
- `<err>`: live error estimate (model below), 2 significant figures; renders
  `±>1 km` past 999 m.
- When neither EXIF GPS nor geohash lon/lat exists (`nogps-*`): `tgt n/a` —
  the rest of the record still copies.

## Geometry (settled: Q2, Q4)

- **Camera position**: the displayed pano's own EXIF
  `GpsLatitude`/`GpsLongitude` (+ XMP `GpsStatus`/`RtkStd*` for the accuracy
  tag), already parsed client-side in `MetadataPanel`. Lift to App alongside
  `RelativeAltitude` (same callback-prop pattern as `onRelativeAltitude` —
  one new prop, e.g. `onGpsFix({lat, lon, status, rtkStdH})`).
  Fallback: manifest `lon`/`lat` from the geohash8 filename (±20 m, tagged).
- **Bearing**: live view-center yaw, treated as true-north-referenced by
  default (user decision 2026-08-21: assume north-aligned, no calibration
  gate). Runtime-correctable via the north-offset feature — see
  `02-north-offset-input.md`.
- **Geodesic**: **Vincenty direct on the WGS84 ellipsoid** (a = 6378137 m,
  f = 1/298.257223563) in a new `app/src/lib/geodesy.ts` — ~40 lines, no new
  dependency, stays in EPSG:4326 end to end. No proj4js, no UTM round-trip.
  TDD seam: verify against published GeodTest reference vectors (Karney's
  test set), not self-computed values.
- Distance input: the existing `groundDistance()` horizontal component.

## Error model (live, in payload)

$$\pm\left(\frac{2d\,\delta p}{\sin 2|p|} + \frac{\Delta z}{\tan|p|} + \sigma_{pos}\right)$$

with assumed δp = 0.1° (aim/readout), Δz = 1 m (terrain relief vs the
flat-ground assumption), σ_pos from the source tag (RTK σ / 3 m / 20 m).
Along-track only — it dominates. Assumptions documented in the HUD tooltip.
Reference numbers: at d = 990 m, p = −3° → ±~55 m; at p = −30° → ±~5 m.

## North reference (updated 2026-08-21, user decision)

**Default: assume the stitched pano is north-aligned (PSV yaw 0 = true
north). No calibration gate.** If the assumption proves wrong in the field,
the user corrects it live via the north-offset input (ticket 02) — the
offset rotates the sphere (`sphereCorrection`), so the bearing used here is
corrected natively with no code change in this ticket.

The LRF/visual calibration script (fact-find below showed the data exists)
remains available as an *optional* way to discover the offset value to type
in — not a release gate.

When the offset is non-zero, the payload records it: appended field
` · north+<x.x>°`.

## UI (settled: Q5)

- Small copy button at the **right end of the HUD**; the HUD keeps
  `pointer-events: none`, the button overrides with `pointer-events: auto`.
- Click → `navigator.clipboard.writeText(payload)` → transient ✓ on the
  button (~1 s) as feedback. No toast, no new keybinding.
- Extend the HUD `title` tooltip with the error-model assumptions.

## Acceptance criteria

- Copy button renders at HUD right end, clickable, never blocks pano drag.
- Clipboard receives the full record line in the format above; target
  matches an independent Vincenty/direct-geodesic computation (e.g.
  GeographicLib online) to ≤ 0.00001°.
- `nogps-*` pano without EXIF GPS → `tgt n/a`, rest of record intact.
- geohash fallback tagged `geohash ±20 m`; RTK panos tagged with σ.
- `geodesy.ts` passes GeodTest-vector unit tests; existing suite stays green.
- When ticket 02's north offset is non-zero, the payload carries
  ` · north+<x.x>°` and the target uses the corrected bearing natively.

## Comments

- 2026-08-21 — Opened after grilling round. Settled: Q1 copy = full record
  incl. target + ±error; Q2 camera = EXIF GPS + RTK, geohash fallback;
  Q3 assume north-aligned + verify empirically first (blocking);
  Q4 Vincenty ellipsoidal direct, no new dep; Q5 target in copy payload
  only, HUD unchanged. Example HUD from user: `yaw 349.3° · pitch -3.0° ·
  fov 30.0° · dist 990 m (slant 990 m)` → h ≈ 52 m, honest error ±40–60 m.
- 2026-08-21 — XMP fact-find on `wzbjs1gm.jpg` (true 2:1 pano): GpsLat/Lon
  8 dp present; `GpsStatus Normal`, **no `RtkStd*` fields in this file**
  (wide frames may differ — check both); LRF target block present →
  calibration route viable. `GimbalYawDegree +0.00` on the stitch hints at
  DJI normalizing the reference yaw; unproven either way.
- 2026-08-21 — User decision: drop the calibration gate; assume north-aligned
  by default and ship. Correction path = runtime north offset (ticket 02,
  sphereCorrection). Calibration script demoted to optional offset-discovery.
- 2026-08-22 — Implemented. New `lib/geodesy.ts` (Vincenty direct; TDD
  against GeographicLib GeodTest-short.dat vectors — 6 vectors pass to
  1e-7…1e-9 ° — plus WGS84 quarter-meridian/equator defining constants and
  45°N curvature anchors) and `lib/copy-record.ts` (CameraFix, error model,
  payload; 11 tests). MetadataPanel lifts `onGpsFix`; HUD gained the copy
  button (✓ feedback) and the error-model tooltip. Browser smoke: payload
  target matched an independent Python Vincenty to 5 dp; ±7.5 m error
  hand-verified. Two-axis /code-review: Spec correct (2 P3 nits, fixed —
  mount-time persist eliminated by moving persistence into the change
  handler; 0.1° resolution enforced on blur). Standards correct — one hard
  finding (SKILL.md is the UI contract single-source: documented dist,
  reticle, copy record, north offset), one judgement (ref write moved out of
  render), ADR "State: none" tension noted: localStorage is a client-side
  preference, not backend state. Spec deviation kept: the spec's "+0.0°"
  display lives only in the payload; the input shows the raw number.
