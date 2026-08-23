# drone-pano-viewer — context

Glossary for the local drone-panorama viewer. Use these terms verbatim in issues, code, tests, and docs. The CLI/UI contract lives in `SKILL.md` (single source) — this file defines vocabulary only.

## Glossary

| Term | Definition |
| --- | --- |
| **pano** | One stitched 2:1 equirectangular drone photo (DJI), a 10–30 MB JPG. The unit the viewer displays. |
| **photos-dir** | The user-supplied directory of panos, scanned recursively. Typically nested by capture date: `{photos-dir}/{date}/{geohash8}.jpg`. |
| **geohash8** | The 8-character base32 geohash forming each pano's filename stem — the pano's `id`. Decodes to the capture position (±20 m). |
| **nogps-\*** | Stem of a pano captured without a GPS fix. Has an `id`, but `lon`/`lat` are `null`: unreachable by `--near`, reachable by `--id`. |
| **manifest** | What `GET /api/photos` returns and `pano list --json` prints: `{ photos: [{ id, name, relPath, url, lon, lat, title? }], playlist }`. |
| **playlist** | A JSON file `[{ id, title? }]` naming an ordered, titled subset of a photos-dir for keyboard review (`[`/`]`). Passed via `pano view --playlist`. |
| **pre-pull rule** | DVC-tracked panos are pulled by the invoking agent before the app starts; the app itself never runs DVC. |
| **annotation** | A user-drawn entity on a pano — a POI **point**, **line**, or **polygon** — captured from view rays projected to flat ground. The unit of the annotations feature. |
| **annotations file** | `<photos-dir>/annotations.geojson` — one GeoJSON FeatureCollection (`version: 1`) holding every annotation for the photos-dir; the viewer's only stateful file. |
| **outbox** | The annotations file's role: a durable, single-writer (viewer-only), read-only-for-consumers message store. Consumers sync by `id`/`updated`; deletion = feature vanishes. |
| **ann-id** | An annotation's stable id, `ann-<ULID>` — unique across sessions and photos-dirs, k-sorted by creation, never reused. |
| **layer** | Not a GeoJSON concept: a logical grouping of annotations by `properties.photo` / `properties.photoTitle`. Consumers filter; the file stays flat. |
| **in-progress shape** | A line/polygon being drawn — vertices captured but not yet finished with Enter. Discarded on photo switch; never written to the annotations file. |

Design decisions: see `docs/adr/0001-architecture.md` and `docs/adr/0002-annotations-outbox.md`.
