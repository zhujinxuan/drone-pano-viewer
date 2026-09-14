# Reference layers — external read-only GeoJSON overlays + measure mode

Status: spec settled by grilling (2026-09-11), ready for implementation.

## Goal

Show **externally-owned** geo data — turbine foundations, sensitive/avoidance areas — inside the pano viewer. Unlike annotations (drawn in-viewer, viewer-written), these are **reference layers**: files produced and edited by outside tools (QGIS, scripts, greedy-turbine-select), passed at startup, re-loaded automatically when the file changes on disk. The viewer never writes them. Plus a **measure mode**: ephemeral two-point ground distance/bearing readout on the pano.

## CLI contract

- Repeatable flag: `pano view <dir> --layer <name>=<path.geojson>[,#hex][,label=<prop>]`.
  - `name`: non-empty, shown in the toolbar. `path`: absolute or CWD-relative GeoJSON file; missing file at startup is a warning, not fatal (it may appear later under watch).
  - `#hex`: optional layer color; omitted → assigned from the Okabe-Ito colorblind-safe palette in flag order.
  - `label=<prop>`: optional property key for point-marker labels. Default precedence: `label` > `name` > `id` > `turbine`; no match → unlabeled dot (never an error).
- GeoJSON only. No GPKG (would drag a native/wasm SQLite dep into the viewer for a read-only use; producers export `.geojson` siblings instead).
- Flows to the server via `PANO_REFERENCE_LAYERS` env (JSON array), like the existing `PANO_*` vars.

## Server endpoint & prefilter (vite.config.ts middleware)

- `GET /api/reference-layers` → `{ layers: [{ name, color, labelProp, status, dropped, features: FeatureCollection }] }`, `status: "ok" | "invalid" | "missing"`; `dropped` counts the features/parts the load rejected.
- **Prefilter at load**: union of 1 km-radius circles around every pano in the served photos-dir (geohash8-decoded positions; `nogps-*` skipped — playlist is a review restriction, not a data extent). A feature is included **whole** if it intersects the union: Point = inside any circle; LineString/Polygon = any vertex inside any circle **or** any segment's min distance to a circle center ≤ radius (vertices alone miss edge-clips). No clipping — geometry is never altered.
- Lenient load, lossless pass-through: unknown feature properties preserved verbatim; bare Feature/geometry accepted by wrapping. Multipart geometries (MultiPoint/MultiLineString/MultiPolygon/GeometryCollection, nested arbitrarily) are flattened at load into one single-geometry Feature per part, each sharing the parent feature's properties — a dissolved-MultiPolygon layer loads instead of silently serving 0 features. Structurally invalid features and parts that fail the position/ring checks are counted in `dropped` while their valid siblings still load; `dropped > 0` shows the toolbar ⚠ on a still-`ok` layer.

## Watch semantics (the live-update mechanism — no CRUD API)

- Server watches each layer file via Vite's own watcher (`server.watcher.add`) — no new dependency.
- On change: 300 ms debounce → re-read + re-filter → push `server.ws.send("reference-layers:changed")` (no payload; clients refetch).
- Parse failure: one retry after 300 ms; still bad → keep last-good features, `status: "invalid"`.
- File deleted: empty FeatureCollection, `status: "missing"`.
- Any successful parse: full replace, `status: "ok"`.
- Safety net for lost watch events: `GET /api/reference-layers` stats every watched file before answering and re-probes any whose mtime/presence changed since its last probe — through the same reload path, so the retry semantics above apply unchanged. Files with a debounce or retry timer pending are skipped: the watch path owns in-flight transitions. A dropped watch event can't outlive one request; cost is one `stat` per file per request.
- Rationale: every producer already writes files; an HTTP CRUD API would be a second write path with nothing to reconcile against. A producer wanting push semantics just writes the file.

## Client behavior

- Fetch layers once on mount; subscribe `import.meta.hot.on("reference-layers:changed", refetch)`.
- Render through the existing overlay seam (`vertexView` flat-ground projection, attach/detach/dispose discipline of the annotation overlay; scene root, not rotated by sphereCorrection):
  - Point → sprite dot in layer color + DOM label (same per-frame projection as annotation labels).
  - LineString → projected polyline. Polygon → boundary polyline + translucent fill (~15% opacity) via the existing triangulation approach.
  - **Per-pano cull**: features with every vertex > 1100 m from the current camera are not rendered (prefilter is load-time data extent; cull is per-photo render hygiene). Vertex-based, Vincenty-exact. Implementation (ticket 10): per-feature vertices+bbox cached by feature identity; three-tier reject — bbox planar (underestimating, 100 m margin) → per-vertex planar → Vincenty confirm only in-band; verdicts identical to the exact path. Polygon fill triangulation (earcut face indices) is likewise cached per feature — cam changes only recompute vertex positions, never topology.
- **Layer toolbar**: foldable + draggable floating panel (drag by header; position + fold persisted in localStorage). One row per layer: color swatch, name, visibility checkbox (all visible by default), feature count, warning glyph when `status != "ok"` (tooltip explains).
- **Click-inspect**: clicking a reference feature opens a small dismissable readout (layer name + properties table; Esc or click-elsewhere closes). Read-only — no editing affordances.

## Measure mode

- Fourth mode-rail button `measure`, exclusive with point/line/polygon; `Esc` or re-click exits.
- First click (or `Space` at reticle) sets A — same flat-ground capture as annotation vertices; mouse move shows rubber-band line + live distance; second click sets B.
- Readout chip: distance (10 m rounding, like the HUD `dist`), bearing A→B (degrees, 1 dp), ±err from the copy-record error model. Third click starts a new A.
- `Esc` clears the current measurement without exiting mode; exiting clears all. **Nothing persisted** — a measurement is not an annotation, never touches the annotations file.
- Disabled on `nogps-*` / missing-RelativeAltitude photos, same as annotation modes.

## Testing decisions

- Same seams as annotations: pure libs under unit test, endpoints verified by fetch against the programmatic server, UI verified by browser smoke.
- New pure libs: reference-layer load/parse + union-prefilter (point in/out, line edge-clip with vertices outside, polygon edge-clip, multi-circle union, empty photos list, malformed input, ring handling); measure math (distance/bearing/err against the geodesy GeodTest vectors); CLI layer-flag parsing (repeatable, palette, labelProp, malformed syntax).
- Prior art: `geodesy.test.ts` (Vincenty vectors), `annotations.test.ts` (lenient parse).

## Non-goals (v1)

GPKG input, in-viewer editing of reference features, CRUD API, geometric clipping at the 1 km boundary, per-vertex culling, multi-segment measure paths, persisting measurements, style config file, cross-layer feature dedup.

## Tickets

`issues/01-…` … `issues/06-…`. Blocking edges: 02 ← 01; 03 ← 01; 04 ← 03; 06 ← 01, 02, 04, 05. 01 and 05 start immediately.

## ADR

Further revises ADR-0001's "State: none" (after ADR-0002): reference layers add server-held, file-mirrored state with a push channel — see `docs/adr/0003-reference-layers.md` (written by ticket 06).
