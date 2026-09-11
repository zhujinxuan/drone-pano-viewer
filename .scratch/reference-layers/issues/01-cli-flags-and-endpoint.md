# 01 — CLI layer flags + reference-layer endpoint with 1km-union prefilter

**What to build:** `pano view <dir> --layer <name>=<path.geojson>[,#hex][,label=<prop>]` (repeatable) starts the server with named reference layers; `GET /api/reference-layers` returns `{ layers: [{ name, color, labelProp, status: "ok", features }] }` with each file's features whole-included by the union of 1 km circles around every positioned pano in the served dir. Malformed flag syntax fails fast with usage. Missing file at startup warns but serves (status will be exercised by ticket 02; for now absent file → empty features).

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Repeatable `--layer` parsing: name=path[,#hex][,label=prop]; Okabe-Ito palette by flag order when color omitted; malformed syntax → fail fast with usage
- [x] `PANO_REFERENCE_LAYERS` env JSON flows cli → vite middleware like existing `PANO_*` vars
- [x] Pure lib: lenient GeoJSON load (bare Feature/geometry wrapped), unknown properties preserved verbatim
- [x] Pure lib: union prefilter — Point inside any circle; LineString/Polygon vertex-inside OR segment-min-distance ≤ 1000 m; whole-feature inclusion, no clipping; `nogps-*` positions skipped
- [x] `GET /api/reference-layers` returns filtered layers per spec
- [x] Unit tests: point in/out, line edge-clip with vertices outside, polygon edge-clip, multi-circle union, empty photos list, malformed file, ring handling, flag parsing (repeatable/palette/labelProp/syntax error)
- [x] Smoke: `npm run pano -- view <dir> --layer a=… --layer b=…,#e69f00,label=tid` serves and endpoint answers

## Comments

Spec: `.scratch/reference-layers/spec.md`. No file watch in this ticket — that is 02.

Implemented 2026-09-11, commit 2b69cce. Code review (Standards+Spec) fixed: HELP synopsis had dropped --playlist/--annotations; palette now skips colors taken by explicit #hex. 30 tests green.
