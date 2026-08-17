# drone-pano-viewer — context

Glossary and settled contract for the local drone-panorama viewer. Use these terms verbatim in issues, code, tests, and docs.

## Glossary

| Term | Definition |
| --- | --- |
| **pano** | One stitched 2:1 equirectangular drone photo (DJI), a 10–30 MB JPG. The unit the viewer displays. |
| **photos-dir** | The user-supplied directory of panos, scanned recursively. Typically nested by capture date: `{photos-dir}/{date}/{geohash8}.jpg`. |
| **geohash8** | The 8-character base32 geohash forming each pano's filename stem — the pano's `id`. Decodes to the capture position (±20 m). |
| **nogps-\*** | Stem of a pano captured without a GPS fix. Has an `id`, but `lon`/`lat` are `null`: unreachable by `--near`, reachable by `--id`. |
| **manifest** | What `GET /api/photos` returns and `pano list --json` prints: `[{ id, name, relPath, url, lon, lat }]`. |
| **pre-pull rule** | DVC-tracked panos are pulled by the invoking agent before the app starts; the app itself never runs DVC. |

## Viewer contract

- `pano view <file-or-dir> [--id <geohash8>] [--near <lon,lat>] [--title <text>]` — start the viewer (a file argument serves its directory; a directory is scanned recursively), pick the pano (`--id` by filename stem, `--near` = minimum distance over decoded geohashes), open the browser on it, print its URL to stdout.
- `pano list <dir> [--json]` — scan and print the manifest; starts no server.
- Viewer URL params: `?id=<geohash8>&title=<text>`; without `id` the first photo shows, titled id + EXIF datetime.

Design decisions: see `docs/adr/0001-architecture.md`.
