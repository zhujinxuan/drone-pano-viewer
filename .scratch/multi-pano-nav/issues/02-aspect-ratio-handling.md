# 02 — Aspect-ratio handling: 4:3 source frames render distorted on the sphere

Status: needs-triage
Type: task

## Finding (2026-08-17 fact-check, contradicts earlier assumption)

The Songyuan `outputs/` dir was assumed to be all 2:1 equirectangular panos.
Actually the `*_V.JPG` collection rule matched **every M4T wide-camera frame**:
day 2026-07-23 has 15 files at 4032×3024 (4:3) and only 2 true panos at
14400×7200 (2:1, ~21 MB). Projecting a 4:3 frame onto the equirect sphere =
the distortion seen in the first smoke test.

PTGui/720yun-style viewers assume equirectangular 360×180 (2:1) input; that is
the correct default projection — the data, not the viewer, is the problem.

## Options

- **A. Auto-detect by aspect ratio**: exactly-2:1 → sphere; anything else → flat
  image viewer mode (pan/zoom, no sphere). Viewer stays honest for both kinds.
- **B. Sphere-only with warning**: render 2:1 normally; show a warning banner
  for non-2:1 files (still projected, distorted).
- **C. Filter at scan**: `/api/photos` only lists 2:1 files; 4:3 excluded
  (needs cheap dimension sniffing at scan time — JPEG SOF header read).

Detection can use the JPEG SOF segment (read first few KB) — no full decode.

## Comments

- 2026-08-17 — Discovered while diagnosing "image looks distorted" report.
  Sample evidence: `wzbjebuf.jpg` 4032×3024 vs `wzbjs1gm.jpg` 14400×7200, same
  day dir, both rule=DJI_V in panorama-index.gpkg.
