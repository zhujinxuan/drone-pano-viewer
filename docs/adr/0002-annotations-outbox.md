# ADR 0002: Annotations outbox — server gains exactly one stateful file

- **Status:** Accepted
- **Date:** 2026-08-23
- **Amends:** ADR-0001 point 6 ("State: none")

## Context

Users need to mark POIs, lines, and polygons while reviewing panos, and downstream agents need to consume those marks into persistent GIS stores (QGIS GPKG). The copy-record workflow (clipboard → paste elsewhere) does not scale to 10–20-photo batch labeling sessions. ADR-0001 declared the viewer stateless: no database, no config file, no cache.

## Decision

1. **The server gains exactly one stateful file**: `<photos-dir>/annotations.geojson` (override `--annotations <path>`), read and written through two new middlewares (`GET`/`POST /api/annotations`). Still no database, no cache, no per-user state — the file *is* the state, colocated with the photos it describes.
2. **Single-writer outbox semantics**: the viewer is the only writer; it loads the file at boot and full-rewrites it (atomic tmp+rename) on every mutation. Consumers are strictly read-only and sync by `properties.id` + `properties.updated` (upsert; deletion = feature vanishes). Consumers never "pop" the queue by editing the file — the consumption receipt lives in the destination store (e.g. an `ann_id` GPKG column).
3. **Feature ids are `ann-<ULID>`**: unique across sessions and photos-dirs with zero coordination (multiple dirs merge into one GPKG), k-sorted by creation, never reused.
4. **"Layers" are properties, not files**: every feature carries `photo` (stable pano id) and `photoTitle`; GeoJSON has no native layer concept and per-photo files would scatter the outbox.
5. **Annotations are ground geometry**: vertices are flat-ground projections (same math as the copy record), stored 2D `[lon, lat]` at 7 decimals with per-vertex error estimates — directly consumable by GIS tools. Capture requires a camera position and RelativeAltitude; `nogps-*` panos cannot be annotated.

## Consequences

- ADR-0001's statelessness is narrowed, not reversed: one append-mostly JSON file, no server-side parsing of it beyond minimal validation, still no credentials or DVC access.
- The full-rewrite autosave means a second concurrent viewer on the same photos-dir loses updates (atomic rename prevents corruption, not lost writes) — accepted: single-user local tool; don't run two instances on one dir.
- Consumers must implement upsert-by-id + prune-missing; that is their only obligation, and it makes re-runs idempotent and crash-safe.
- The file doubles as the human-authored archive of a field session; it is never pruned, even for photos later removed from the dir.
