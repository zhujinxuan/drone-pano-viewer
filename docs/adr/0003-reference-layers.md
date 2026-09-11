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
