---
name: drone-pano-viewer
description: View stitched drone panorama photos (equirectangular 踏勘全景) in a local PTGui/720yun-like web viewer, and open panoramas near a given location. Use when the user mentions 全景/drone panorama viewing, 踏勘图片查看, "find drone photos near X / open viewer", or pano hotspots.
---

# drone-pano-viewer

> **Status: scaffold.** This skill folder IS the app repo (code will live here
> alongside this SKILL.md), but nothing is implemented yet. Finalize this file
> (exact CLI, flags, output contract) when the app lands — do not trust the
> planned contract below without checking the actual code/README.

## How to call (planned contract — verify against the built app)

- `pano serve <photos-dir>` — start the local viewer server for a panorama directory.
- `pano open <photos-dir> --id <geohash8>` — open the browser on one panorama.
- `pano open <photos-dir> --near <lon,lat>` — open the nearest panorama to a point.
  Geocoding/place-name resolution is the agent's job; the app takes coordinates.

## Things to notice

- Photo positions decode from **geohash8 filenames**; files named `nogps-*` have no position.
- Photos may be DVC-tracked and not pulled: the app pulls a single file on demand
  (`dvc pull <file>`); for qiniu remotes `NO_PROXY='*'` must be set (system proxy breaks it).
- DVC credentials live in each project's `.dvc/config.local`, never in this app.
- If the photos dir is an rclone mount, files simply exist and pull is skipped.
- Typical photo source (Songyuan 1.2GW project):
  `resources/2026-07-27-drone-panorama/step-01-panorama/outputs/{date}/{geohash8}.jpg`,
  spatial index `panorama-index.gpkg` (per-day layers, EPSG:4326).
