---
name: drone-pano-viewer
description: View stitched drone panorama photos (equirectangular 踏勘全景) in a local PTGui/720yun-like web viewer — open one pano, the pano nearest a location, or a titled playlist to keyboard-review many. Use when the user mentions 全景/drone panorama viewing, 踏勘图片查看, or "find drone photos near X / open the viewer".
---

# drone-pano-viewer

Local web viewer for drone panos. This skill folder is the app repo; the app lives in `app/` (Vite + React) and shows a photo-sphere viewer with yaw/pitch/FOV overlay, title banner, and a DJI EXIF/XMP metadata panel.

## Viewer overlays & measurement

- **HUD** (top right): `yaw · pitch · fov · dist`, live at 10 Hz. `dist` is the flat-ground distance to the ground point at the **center reticle** (always-on crosshair): horizontal from the pano's XMP `RelativeAltitude` and the view pitch, with slant range in parentheses — meters rounded to 10 m, `> 5 km` past the cap, `—` when looking at/above the horizon or when altitude is missing. Ground is assumed flat at takeoff elevation; terrain relief degrades it, especially at shallow pitch.
- **Copy button** (right end of the HUD): copies one measurement record — `<id> · cam <lat>,<lon> (<src>) · yaw … · pitch … · fov … · dist … (slant …) · tgt <lat>,<lon> ±<err> m`, plus ` · north+x.x°` when an offset is active. `tgt` is the view-center ground point computed by Vincenty direct on WGS84 from the pano's EXIF GPS (`<src>` = `RTK σ… m`, `GNSS ±3 m`, or `geohash ±20 m` fallback); `±err` is the live along-track estimate (pitch sensitivity + 1 m terrain + position σ). `tgt n/a` when no ground point or no position.
- **North offset** (EXIF panel, "Viewer" group): typed/nudged degrees rotate the sphere (`sphereCorrection`) so a mis-stitched pano's bearings read true — compass, HUD yaw and `tgt` all follow natively. One app-wide value, persisted in `localStorage`; `?north=<deg>` in the URL selects it for the session (persisted only once the user changes it). Default `0` = assume north-aligned.

## File naming contract

The viewer reads position and identity **from filenames** — nothing else:

- `<geohash8>.jpg` — stem is an 8-char base32 geohash of the capture position; it is the pano's `id` and decodes to lon/lat (±20 m).
- `nogps-<anything>.jpg` — no position: reachable by `--id`, never by `--near`.
- Any nesting below the photos dir is fine (typically `{dir}/{date}/{geohash8}.jpg`); the scan is recursive.
- Expected content is 2:1 equirectangular (e.g. 14400×7200). Other aspect ratios currently render distorted on the sphere — a known open limitation (`.scratch/multi-pano-nav/issues/02`).

## Workflow

1. Locate the photos dir (Songyuan 1.2GW example: `resources/2026-07-27-drone-panorama/step-01-panorama/outputs/`).
2. **Pre-pull DVC-tracked panos before invoking the app — the app never runs DVC.** For qiniu remotes set `NO_PROXY='*'` (the system proxy breaks the pull); credentials stay in each project's `.dvc/config.local`. On an rclone mount the files already exist; skip the pull.
3. Run from `app/` (`npm install` once first):

   ```
   npm run pano -- view <file-or-dir> [--id <geohash8>] [--near <lon,lat>]
                       [--title <text>] [--playlist <file.json>]
   npm run pano -- list <dir> [--json]
   ```

   `view` serves the dir (a file argument serves its parent dir), opens the browser on the chosen pano, prints the URL. Selection precedence: `--id` > `--near` (min haversine over decoded stems — resolve place names to lon/lat yourself) > file stem > first photo. `list` prints the manifest `{ photos: [{ id, name, relPath, url, lon, lat, title? }], playlist }` and starts no server.
4. Done when the browser shows the intended pano with the intended title.

## Playlist review sessions

For "review these 10–20 spots" requests, write a playlist file yourself (titles are where you put the human meaning — spot names, turbine ids, dates):

```json
[{ "id": "wzbjs1gm", "title": "FS3 · 机位北側" }, { "id": "wzbjsr6x" }]
```

Pass it with `--playlist`; the viewer restricts to that ordered subset and the user switches with `[` / `]` (or `p` / `n`), wrap-around, bottom nav strip showing `‹ N/M ›` and the next title. Ids must exist in the dir — the CLI fails fast listing unknown ones. Viewer URLs carry `?pos=N`, so a refresh keeps the place.

## Caveats

- Title precedence: `--title` > playlist entry title > `id · EXIF capture time`.
- Files named `nogps-*` have `lon`/`lat` null in the manifest.
- Runs on Windows Node; no WSL involved.
