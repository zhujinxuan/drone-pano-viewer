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

- `GET /api/reference-layers` → `{ layers: [{ name, color, labelProp, status, dropped, vertices, features: FeatureCollection }] }`, `status: "ok" | "invalid" | "missing"`; `dropped` counts the features/parts the load rejected; `vertices` is the served vertex count (Point 1, LineString its length, Polygon its ring sum — 0 when empty/missing, last-good kept while invalid): the payload carries it so consumers can weigh a layer without re-walking its features.
- **Prefilter at load**: union of 600 m-radius circles around every pano in the served photos-dir (geohash8-decoded positions; `nogps-*` skipped — playlist is a review restriction, not a data extent). A feature is included **whole** if it intersects the union: Point = inside any circle; LineString/Polygon = any vertex inside any circle **or** any segment's min distance to a circle center ≤ radius (vertices alone miss edge-clips). No clipping — geometry is never altered. (Radius was 1 km until ticket 12.)
- Lenient load, lossless pass-through: unknown feature properties preserved verbatim; bare Feature/geometry accepted by wrapping. Multipart geometries (MultiPoint/MultiLineString/MultiPolygon/GeometryCollection, nested arbitrarily) are flattened at load into one single-geometry Feature per part, each sharing the parent feature's properties — a dissolved-MultiPolygon layer loads instead of silently serving 0 features. Structurally invalid features and parts that fail the position/ring checks are counted in `dropped` while their valid siblings still load; `dropped > 0` shows the toolbar ⚠ on a still-`ok` layer.
- **Cached gzip serving (ticket 13)**: the serialized body and its gzip bytes are cached with the layer state and recomputed only on an accepted change (boot load, watch reload, retry, request-time mtime re-probe) — never per request. Served with `Content-Encoding: gzip` when the client's `Accept-Encoding` includes `gzip`, identity otherwise.
- **Vertex budget (ticket 09 item 4)**: an accepted load serving > 200 000 vertices logs one server-side `console.warn` naming the layer and suggesting producer-side simplification (e.g. 2 m Douglas-Peucker) — the cost is otherwise invisible to producers (degrade-loudly).

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
  - **Render decimation** (ticket 11): a feature whose rings total > 1000 vertices is Douglas-Peucker-decimated in projected (yaw, pitch) space before any GPU work — ε = 2e-4 rad (sub-pixel) for strokes, 5× that for fills (the stroke draws the true edge; the fill may wobble beneath it). The decision is per FEATURE — undecimated "small" rings of a 900-ring dissolved union would still total ~54 k fill vertices and turn earcut's hole-bridging quadratic (measured: 2.0 s → 32 ms triangulation on the reporter's 68 k-vertex polygon). Data and the cull are untouched; decimation is render-only and visually bounded.
  - **Camera-local fill triangulation** (ticket 11 fix): polygon fills triangulate in a stereographic projection from the zenith (nadir = origin), not one tangent plane per feature. Ground rays always have pitch ≤ 0, so the projection is injective over the entire ground hemisphere under ANY camera — planar hole containment equals ground-truth containment even when the camera stands inside a km-scale hole whose ring surrounds it (the giant-mask leak: vertex asymmetry tilted the tangent normal off-nadir, and orthographic projection folds every ray beyond 90° from the normal over the near side). Seam: `triangulateRings` in `lib/reference-fill.ts`, property-tested with a ray–triangle oracle independent of the projection. The per-feature fill-face caches (tickets 10/14) stay valid: ring topology is cam-independent and the projection now provably preserves it. AnnotationOverlay keeps its own tangent-plane triangulation — user-drawn polygons are small, hole-less, and near-camera by construction.
  - **Distance-banded LOD** (ticket 14): a feature with no vertex within 200 m of the camera renders from a cam-independent coarse geometry — Douglas-Peucker in ground meters at 3 m tolerance, computed once per payload and cached per feature (screen error ≈ eps/d rad: ≤ ~14 px at 200 m, shrinking with distance; accepted as deliberately aggressive — far features are schematic context, near features keep full fidelity). Only the simplified rings are projected per switch, and the coarse fill triangulation is cacheable (earcut once per payload, not per switch). The band verdict reuses the cull's underestimating planar scales, so a borderline feature always renders near/full-fidelity. Data, the cull, and click-inspect keep the full geometry.
  - **Draw-call batching** (ticket 15): per layer, all strokes merge into one LineSegments and all fills into one triangle-soup Mesh — ~2 draw calls per layer regardless of feature count (frustum-culling granularity surrendered deliberately: everything drawn is within 700 m on an always-drawn sphere). **Async progressive build** (ticket 16): layers build one per time slice, cheapest served-vertex-count first (pure seam: `buildQueue`), adding each finished layer to the scene immediately; a generation counter cancels pending slices on any prop change. The toolbar pulses a layer's name while its slice builds.
  - **Per-pano cull**: features with every vertex > 700 m from the current camera are not rendered (prefilter is load-time data extent; cull is per-photo render hygiene; 700 = prefilter 600 + 100 m margin so the client never keeps what the server could have dropped). Vertex-based, Vincenty-exact. Implementation (ticket 10): per-feature vertices+bbox cached by feature identity; three-tier reject — bbox planar (underestimating, 100 m margin) → per-vertex planar → Vincenty confirm only in-band; verdicts identical to the exact path. Polygon fill triangulation (earcut face indices) is likewise cached per feature — cam changes only recompute vertex positions, never topology.
  - **Heavy layers default hidden** (ticket 17): a layer whose served vertex count (payload `vertices`) exceeds 50 000 seeds unchecked in the toolbar — detected-cost-based default-off; the user enables it deliberately. Seeding never overrides an existing user toggle (pure seam: `seedVisibility`).
- **Layer toolbar**: foldable + draggable floating panel (drag by header; position + fold persisted in localStorage). One row per layer: color swatch, name, visibility checkbox (all visible by default), feature count, warning glyph when `status != "ok"` (tooltip explains). Name pulses while the layer's overlay slice builds (ticket 16); over-budget rows carry a "heavy layer — N vertices, hidden by default" tooltip (ticket 17).
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

GPKG input, in-viewer editing of reference features, CRUD API, geometric clipping at the 600 m boundary, per-vertex culling, multi-segment measure paths, persisting measurements, style config file, cross-layer feature dedup.

## Tickets

`issues/01-…` … `issues/06-…`. Blocking edges: 02 ← 01; 03 ← 01; 04 ← 03; 06 ← 01, 02, 04, 05. 01 and 05 start immediately.

## ADR

Further revises ADR-0001's "State: none" (after ADR-0002): reference layers add server-held, file-mirrored state with a push channel — see `docs/adr/0003-reference-layers.md` (written by ticket 06).
