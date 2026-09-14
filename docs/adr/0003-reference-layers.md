# ADR 0003: Reference layers — watched files, not a CRUD API

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amends:** ADR-0001 point 6 ("State: none"), further to ADR-0002

## Context

Reviewers need the project's surrounding geo data visible while inside a pano — turbine foundation layouts, sensitive/avoidance areas — but that data is produced and edited by external tools (QGIS projects, greedy-turbine-select, one-off scripts). ADR-0002 gave the server exactly one stateful file, the annotations outbox, with the viewer as its single writer. Reference layers are the inverse direction: foreign-written, viewer-read. The viewer must display them and keep them current without ever owning or editing them.

## Decision

1. **Layer files are watched, not managed.** `pano view --layer <name>=<path.geojson>[,#hex][,label=<prop>]` (repeatable) passes read-only GeoJSON layers to the dev server via `PANO_REFERENCE_LAYERS`. The server mirrors each file in memory and keeps it current through Vite's own watcher (no new dependency): 300 ms debounce per file, one parse retry after 300 ms, then last-good features with `status: "invalid"`; deletion → empty features, `"missing"`; any successful parse fully replaces, `"ok"`. An accepted change to the served payload pushes `reference-layers:changed` over ws (no payload — clients refetch `GET /api/reference-layers`).
2. **Deliberately no CRUD API.** Every producer already writes files; an HTTP write path would be a second writer with nothing to reconcile against — the outbox's single-writer discipline does not transfer, because here the viewer is the consumer, not the writer. A producer wanting push semantics just writes the file.
3. **GeoJSON only, no GPKG.** Layers are read-only; a GPKG reader would drag a native/wasm SQLite dependency into the viewer for no write benefit. Producers export `.geojson` siblings instead.
4. **Server-side extent prefilter, render via the existing overlay seam.** At each load, a feature is included **whole** iff it intersects the union of 1 km-radius circles around every positioned pano of the served dir (`nogps-*` skipped; the full scan, not the playlist — a playlist is a review restriction, not a data extent). No clipping — geometry passes through verbatim. Rendering reuses the annotation overlay seam (flat-ground `vertexView` projection, same attach/detach/dispose discipline); the client additionally culls features whose every vertex is more than 1100 m from the current camera.

## Consequences

- ADR-0001's "State: none" is further revised (after ADR-0002): the server now also holds foreign, file-mirrored state plus a push channel. The viewer still writes only the annotations outbox — reference layers add no write path of the viewer's own, hence no conflict surface to reconcile.
- The 1 km union is recomputed on each watch reload, not on photos-dir changes alone: newly pulled panos widen the prefilter only on the next layer-file change (accepted — mid-session, layer files change far more often than the photo set).
- Whole-feature inclusion means a large feature crossing the union is served whole; the payload is bounded by the producer's data, while the 1100 m render cull keeps per-photo draw cost bounded. File granularity is the sync unit: two layers may share one file, and one file event reloads both.
- Producers get ~300 ms-granularity live updates; a torn mid-write read is absorbed by the single retry and the last-good rule (a terminal parse failure keeps serving the last good features, flagged ⚠ in the toolbar).

## Amendment (2026-09-14, tickets 07/08)

- **Multipart geometries flatten at load.** MultiPoint/MultiLineString/MultiPolygon/GeometryCollection are exploded into one single-geometry feature per part inside `parseReferenceGeoJSON` (properties shared by reference, foreign members kept, coordinates untouched). Real producers (QGIS/geopandas dissolves) emit Multi* by construction; the v1 "dropped at load" behavior turned them into a silent `ok` with 0 features — a false-negative hazard during turbine-vs-sensitive-area review. `RefGeometry`, the prefilter, the cull, and the renderer are unchanged.
- **Silent drops are now counted, not invisible.** `RefLoadResult`/`RefLayerPayload` carry `dropped` (features/parts that survived nothing); the toolbar shows ⚠ with a dropped-count tooltip even when `status` is `ok`.
- **The endpoint stats what the watcher might miss.** `GET /api/reference-layers` stats every watched file per request and re-probes on mtime/presence change through the same `acceptLayerProbe` fold (retry semantics identical; in-flight debounce/retry timers are not preempted). Motivation: a lost chokidar event on Windows left a stale `ok` payload until restart; one `stat` per file per request makes stale-forever impossible regardless of watcher reliability.

## Amendment (2026-09-14, ticket 12)

- **The extent shrinks: prefilter 1 km → 600 m, render cull 1100 m → 700 m.** The review loop reads near-field conflicts; the smaller union reduces served payload and per-pano kept sets. The server+100 m margin pattern is preserved so the client cull never keeps a feature the prefilter could have dropped. Whole-feature inclusion is unchanged — a dissolved super-region is still served whole once any part of it intersects the union; the render cost of those is owned by ticket 11's decimation, not by the radius.
