# Annotations — in-pano POI/line/polygon capture with GeoJSON outbox

Status: spec settled by grilling (2026-08-23), ready for implementation.

## Goal

Let the user draw annotations **on the pano** — points (POI), lines, polygons — captured from the view (reticle aim or click), labeled, listed, editable (label only) and deletable, persisted **live** to a single GeoJSON file next to the photos. The file is a **durable outbox**: downstream agents consume it read-only into QGIS/GPKG persistent stores.

## File contract

- Path: `<photos-dir>/annotations.geojson` (override: `pano view --annotations <path>`).
- One file per photos-dir. **Load-then-rewrite**: the app loads the file at boot and autosaves the **entire collection** (debounced ~300 ms) on every mutation — including features for photos not in the current playlist/session.
- **Single writer**: the viewer is the only process that ever writes this file. Consumers are read-only.
- Server writes are **atomic**: write `<file>.tmp`, rename over the original.
- Lenient load, lossless rewrite: unknown top-level foreign members and unknown feature properties are preserved verbatim, never stripped.
- Features for photos missing from the current manifest are kept in the file untouched (never pruned).

### Schema (version 1)

```json
{
  "type": "FeatureCollection",
  "version": 1,
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] },
      "properties": {
        "id": "ann-01J8KQ3M7V9W2X4Y5Z6A8B0C1D",
        "kind": "line",
        "label": "北侧山脊线",
        "photo": "wzbjs1gm",
        "photoTitle": "FS3 · 机位北側",
        "created": "2026-08-23T10:42:11.000Z",
        "updated": "2026-08-23T10:42:11.000Z",
        "cam": { "lat": 44.9, "lon": 125.1, "src": "GNSS ±3 m", "relAltM": 112.5 },
        "vertexErrM": [4, 5, 6]
      }
    }
  ]
}
```

- `id`: `ann-` + ULID (26-char Crockford base32: 48-bit ms timestamp + 80-bit random). Unique across sessions/dirs with zero coordination; k-sorted ≈ creation order; **never reused** — redraw-after-delete gets a fresh id.
- `kind`: `point | line | polygon`.
- `label`: user label or auto-name (`Point N` / `Line N` / `Polygon N`, N per-kind per-photo sequence at creation).
- `photo`: pano `id` (geohash8 stem) the feature was captured from. `photoTitle`: resolved title at creation (titles can change; `photo` is the stable key). "Layer" = filter features by `photo`/`photoTitle` — GeoJSON has no native layers.
- `created`/`updated`: ISO 8601 UTC. `updated` == `created` at birth; bumped **only** on relabel (vertices are immutable post-finish).
- `cam`: camera fix at capture — `src` string mirrors the copy-record source (`RTK σ…` / `GNSS ±3 m` / `geohash ±20 m`), `relAltM` = XMP RelativeAltitude.
- `vertexErrM`: per-vertex along-track error (same model as the copy record).
- Geometry: 2D `[lon, lat]` only (flat-ground projection makes z fake precision), rounded to **7 decimals** on write. Polygon rings written **closed** (first == last); the UI never stores the duplicated closing vertex — serialization adds it.

## Server endpoints (vite.config.ts middleware)

- `GET /api/annotations` → 200 with file JSON; if the file does not exist, 200 with `{ "type": "FeatureCollection", "version": 1, "features": [] }`.
- `POST /api/annotations` → body = full FeatureCollection; minimal validation (`type: "FeatureCollection"`, `features` array); atomic tmp+rename write; 204 on success, 400 on invalid body. Path-traversal-safe like `/photos/*`.
- CLI: `pano view … --annotations <path>` overrides the default `<photos-dir>/annotations.geojson`; env-passed to the middleware like `PANO_PHOTOS_DIR`.

## Capture & interaction

- **Modes**: point / line / polygon, entered via 3 buttons on a **top-left rail** (no `1/2/3` keys). Mode is exclusive; clicking the active mode's button (or `Esc`) exits.
- **Add vertex**: `Space` adds at the **reticle** ground point; a single click (not drag — PSV `click` event, drag-guarded) adds at the clicked ground point. Both use the same flat-ground projection as the copy record (Vincenty direct from camera fix + RelativeAltitude).
- **Finish**: `Enter` or the ✓ button. Line needs ≥ 2 vertices; polygon needs ≥ 3 and **auto-closes** (never re-aim at the first vertex). `Esc` cancels the in-progress shape.
- **Undo**: `u` / `Backspace` removes the last vertex while drawing.
- **Reject flash**: if the aim point has no ground intersection (at/above horizon), the vertex is rejected with a brief red reticle flash — no silent skips.
- **Photo switch discards** any in-progress shape (it is not yet an entity; no toast).
- **HUD hint line while drawing**: e.g. `LINE · 3 verts · Space/click add · u undo · Enter finish · Esc cancel`.

## Selection, labels, deletion

- Entity **list panel** (rail-anchored, `e` toggles): current photo's entities grouped by kind. Click an item → select + **camera swing** (animated rotate to the entity centroid's yaw/pitch). `Tab` cycles selection without moving the camera. Selected entity is highlighted on the sphere.
- **Label**: on finish/add, an inline input opens with the auto-name pre-filled; type to replace, `Enter`/`Esc` accepts as-is. `l` or the list item's edit affordance re-opens it for the selected entity (bumps `updated`).
- **Delete**: `Delete`/`d` key or list button — instant, no dialog; a 5-second toast ("deleted — undo") restores the feature with the **same id and updated** (consumer-side this is vanish-then-return, handled by upsert).
- **Disabled states**: photos with no position (`nogps-*`) or missing RelativeAltitude grey out the mode buttons (tooltip: "no position/altitude — annotation unavailable").

## Rendering

- Custom **three.js overlay** inside the PSV scene (three ships with PSV; the markers plugin is not installed and its polyline API fights live in-progress feedback): finished entities, in-progress shape, selection highlight. Overlay meshes sit at a slightly smaller radius than the sphere so they are always visible from inside.
- **Labels render as DOM markers** projected per-frame via `dataHelper.sphericalCoordsToViewerCoords` (cheap, stylable, no text-sprite machinery).

## Small print (settled)

2D coords at 7dp · photo-switch discards in-progress · lenient load / lossless rewrite · undo-delete keeps same id · panel lists current photo only · shortcuts dropdown is help (no rebinding) · no "clear all" button in v1.

## Consumer contract (for SKILL.md)

Consumers treat the file as a **durable outbox with monotonic `(id, updated)` versioning**:

- Read freely (atomic rename means no torn reads); never write the file.
- Upsert downstream by `properties.id`; skip when `updated` is unchanged since last ingest.
- Deletion = feature disappears: prune downstream rows whose known `id` is absent from the file.
- The ack lives in the destination store (e.g. an `ann_id` column in the GPKG), not in the outbox.
- Filter by `properties.photo` (stable) or `properties.photoTitle` for per-photo "layers".

## Non-goals (v1)

Vertex move/insert, entity move, cross-pano display of annotations, mouse-free-reticle-only mode, key rebinding, bulk clear, consumed-state sidecar, NDJSON/GPKG interchange.

## Tickets

`issues/01-annotation-lib.md` … `issues/07-integration.md`. Blocking edges: 07 ← 01, 03, 04, 05. Everything else is independent.

## ADR

This feature amends ADR-0001's "State: none" — see `docs/adr/0002-annotations-outbox.md`.
