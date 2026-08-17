---
name: drone-pano-viewer
description: View stitched drone panorama photos (equirectangular 踏勘全景) in a local PTGui/720yun-like web viewer, and open the panorama nearest a given location. Use when the user mentions 全景/drone panorama viewing, 踏勘图片查看, or "find drone photos near X / open the viewer".
---

# drone-pano-viewer

Local web viewer for stitched drone panos (2:1 equirectangular DJI JPGs, 10–30 MB). This skill folder is the app repo; the app lives in `app/` (Vite + React + TS) and shows a photo-sphere viewer with yaw/pitch/FOV overlay, title banner, and a DJI EXIF/XMP metadata panel.

## Workflow

1. Locate the photos dir. Typical (Songyuan 1.2GW project): `resources/2026-07-27-drone-panorama/step-01-panorama/outputs/` with panos at `{date}/{geohash8}.jpg`; a spatial index `panorama-index.gpkg` may sit alongside.
2. **Pre-pull DVC-tracked panos before invoking the app — the app never runs DVC.** For qiniu remotes set `NO_PROXY='*'` (the system proxy breaks the pull); credentials stay in each project's `.dvc/config.local`. On an rclone-mounted dir the files already exist and no pull is needed.
3. Run from `app/` (`npm install` once first):

   ```
   npm run pano -- view <file-or-dir> [--id <geohash8>] [--near <lon,lat>] [--title <text>]
   npm run pano -- list <dir> [--json]
   ```

   `view` starts the server and opens the browser on the chosen pano, printing its URL to stdout. A file argument serves that file's directory; a directory argument is scanned recursively. `--id` selects by filename stem; `--near` picks the pano at minimum distance from the point (positions decode from geohash8 stems — resolve place names to lon/lat yourself; the app takes raw coordinates). `list` only scans and prints the manifest — `[{ id, name, relPath, url, lon, lat }]` with `--json` — starting no server.

## Caveats

- Files named `nogps-*` have no position (`lon`/`lat` are `null`): select them with `--id`, never `--near`.
- Viewer URLs take `?id=<geohash8>&title=<text>`; without `id` the first photo is shown, titled id + EXIF datetime.
- Runs on Windows Node; no WSL involved.
