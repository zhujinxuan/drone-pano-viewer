---
name: drone-pano-viewer
description: View stitched drone panorama photos (equirectangular 踏勘全景) in a local PTGui/720yun-like web viewer — open one pano, the pano nearest a location, or a titled playlist to keyboard-review many. Use when the user mentions 全景/drone panorama viewing, 踏勘图片查看, or "find drone photos near X / open the viewer".
---

# drone-pano-viewer

Local web viewer for drone panos. This skill folder is the app repo; the app lives in `app/` (Vite + React) and shows a photo-sphere viewer with yaw/pitch/FOV overlay, title banner, and a DJI EXIF/XMP metadata panel.

## External agents: never edit, file a ticket

If you are an agent working in **any other repo/workdir** (e.g. a wind-project repo invoking this viewer): direct editing of anything in this skill repo (`app/`, `SKILL.md`, docs, configs) is **strictly prohibited**. The skill maintainer owns all code changes.

Found a bug, a missing feature, or a broken contract? File a ticket in the repo's local markdown issue tracker instead:

- Create `.scratch/<feature-slug>/issues/<NN>-<slug>.md` (next free `NN` in that feature's `issues/` dir; create the dirs if needed).
- Body: what you ran (exact `npm run pano -- …` command + photos dir), what you expected, what happened, and the impact on your workflow.
- Set `Status: needs-triage` near the top (see `docs/agents/triage-labels.md`).
- Conventions: `docs/agents/issue-tracker.md`. Then report the ticket path back to your user and continue with whatever the current viewer can do — do not work around it by patching the app.

## Viewer overlays & measurement

- **HUD** (top right): `yaw · pitch · fov · dist`, live at 10 Hz. `dist` is the flat-ground distance to the ground point at the **center reticle** (always-on crosshair): horizontal from the pano's XMP `RelativeAltitude` and the view pitch, with slant range in parentheses — meters rounded to 10 m, `> 5 km` past the cap, `—` when looking at/above the horizon or when altitude is missing. Ground is assumed flat at takeoff elevation; terrain relief degrades it, especially at shallow pitch.
- **Copy button** (right end of the HUD): copies one measurement record — `<id> · cam <lat>,<lon> (<src>) · yaw … · pitch … · fov … · dist … (slant …) · tgt <lat>,<lon> ±<err> m`, plus ` · north+x.x°` when an offset is active. `tgt` is the view-center ground point computed by Vincenty direct on WGS84 from the pano's EXIF GPS (`<src>` = `RTK σ… m`, `GNSS ±3 m`, or `geohash ±20 m` fallback); `±err` is the live along-track estimate (pitch sensitivity + 1 m terrain + position σ). `tgt n/a` when no ground point or no position.
- **North offset** (EXIF panel, "Viewer" group): typed/nudged degrees rotate the sphere (`sphereCorrection`) so a mis-stitched pano's bearings read true — compass, HUD yaw and `tgt` all follow natively. One app-wide value, persisted in `localStorage`; `?north=<deg>` in the URL selects it for the session (persisted only once the user changes it). Default `0` = assume north-aligned.
- **Metadata degrade banner**: when a photo's EXIF/XMP can't be parsed or is absent, the pano still renders — degrade, never block — but an amber `⚠ metadata unavailable — dist / annotations / measure disabled` strip appears under the title banner, the metadata panel settles to its error state (never hangs on "Parsing metadata…"), and the mode buttons stay greyed with their explanatory tooltip.

## File naming contract

The viewer reads position and identity **from filenames** — nothing else:

- `<geohash8>.jpg` — stem is an 8-char base32 geohash of the capture position; it is the pano's `id` and decodes to lon/lat (±20 m).
- `nogps-<anything>.jpg` — no position: reachable by `--id`, never by `--near`.
- Any nesting below the photos dir is fine (typically `{dir}/{date}/{geohash8}.jpg`); the scan is recursive.
- Expected content is 2:1 equirectangular (e.g. 14400×7200). Other aspect ratios currently render distorted on the sphere — a known open limitation (`.scratch/multi-pano-nav/issues/02`).

## Workflow

1. Locate the photos dir (Songyuan 1.2GW example: `resources/2026-07-27-drone-panorama/step-01-panorama/outputs/`).
2. **Pre-pull DVC-tracked panos before invoking the app — the app never runs DVC.** For qiniu remotes set `NO_PROXY='*'` (the system proxy breaks the pull); credentials stay in each project's `.dvc/config.local`. On an rclone mount the files already exist; skip the pull.
3. Run from `app/` (`npm install` once first):

   ```
   npm run pano -- view <file-or-dir> [--id <geohash8>] [--near <lon,lat>]
                       [--title <text>] [--playlist <file.json>]
                       [--annotations <path>]
                      [--layer <name>=<path.geojson>[,#hex][,label=<prop>]]…
   npm run pano -- list <dir> [--json]
   ```

   `view` serves the dir (a file argument serves its parent dir), opens the browser on the chosen pano, prints the URL. Selection precedence: `--id` > `--near` (min haversine over decoded stems — resolve place names to lon/lat yourself) > file stem > first photo. `list` prints the manifest `{ photos: [{ id, name, relPath, url, lon, lat, title? }], playlist }` and starts no server.
4. Done when the browser shows the intended pano with the intended title.

## Playlist review sessions

For "review these 10–20 spots" requests, write a playlist file yourself (titles are where you put the human meaning — spot names, turbine ids, dates):

```json
[{ "id": "wzbjs1gm", "title": "FS3 · 机位北側" }, { "id": "wzbjsr6x" }]
```

Pass it with `--playlist`; the viewer restricts to that ordered subset and the user switches with `[` / `]` (or `p` / `n`), wrap-around, bottom nav strip showing `‹ N/M ›` and the next title. Ids must exist in the dir — the CLI fails fast listing unknown ones. Viewer URLs carry `?pos=N`, so a refresh keeps the place.

## Annotations

Draw POI points, lines, polygons **on the pano** — captured from the reticle or clicks, labeled, deletable — persisted live (autosave debounced ~300 ms) to a single GeoJSON file: `<photos-dir>/annotations.geojson`, override with `pano view --annotations <path>`.

**UI contract**:

- **Mode rail** (top left): `point` / `line` / `polygon` buttons — exclusive; clicking the active mode's button or `Esc` exits.
- **Add vertex**: `Space` at the reticle ground point, or a single click (drag-guarded) at the clicked ground point — same flat-ground projection as the copy record's `tgt`.
- **Finish**: `Enter` — line needs ≥ 2 vertices, polygon ≥ 3 and auto-closes. `u` / `Backspace` undoes the last vertex; `Esc` cancels; switching photos discards the in-progress shape.
- **Reject flash**: aim at/above the horizon → no ground point, vertex rejected with a brief red reticle flash (never silent).
- **Label**: inline input on finish, auto-name pre-filled (`Point N` / `Line N` / `Polygon N`); `Enter` / `Esc` accepts. `l` re-opens it for the selected entity (bumps `updated`).
- **List panel** (`e`): current photo's entities grouped by kind; click = select + camera swing to the entity centroid; `Tab` cycles selection. `Delete` / `d` = instant delete with a 5 s undo toast (restores the same id).
- **Disabled** on `nogps-*` or missing-RelativeAltitude photos (mode buttons greyed out).
- **Overlay opacity** (`Alt+scroll`, viewer-wide): scales every drawn overlay — finished annotations (strokes `0.75`/`0.95`, polygon fills, point dots) and reference layers — by one global multiplier: effective alpha = base × multiplier, capped at solid. 10%–300% in 10% steps per wheel notch, default 100%, persisted in `localStorage` (`pano.overlayOpacity`); a transient `Overlay N%` chip under the HUD fades ~1 s after the last notch. The in-progress sketch and selection affordances (halo, vertex markers) stay at base alpha so drawing and editing never degrade. Plain scroll keeps PSV's FOV zoom untouched.

**File contract** — one FeatureCollection, `version: 1`:

- `properties`: `id` = `ann-<ULID>` (unique, k-sorted, never reused), `kind` = `point|line|polygon`, `label`, `photo` (pano id — the stable key), `photoTitle` (resolved at creation), `created` / `updated` (ISO 8601 UTC; `updated` bumps only on relabel — vertices are immutable post-finish), `cam` = `{ lat, lon, src, relAltM }` (camera fix at capture), `vertexErrM` (per-vertex along-track error, copy-record model).
- Geometry is 2D `[lon, lat]` rounded to 7 decimals on write; polygon rings are written closed.
- Load-then-rewrite of the **entire collection** on every mutation, atomic (`.tmp` + rename); lenient load preserves unknown members verbatim; features for photos outside the current playlist/session are never pruned.

**Consumer contract** — the file is a durable outbox with monotonic `(id, updated)` versioning. **Read-only for consumers; the viewer is the sole writer.**

- Upsert downstream by `properties.id`; skip when `updated` is unchanged since the last ingest.
- Deletion = the feature vanishes from the file → prune downstream rows whose known id is absent.
- The consumption receipt (e.g. an `ann_id` column in the GPKG) lives in the destination store, not the outbox.
- "Layer" = filter by `properties.photo` (stable) or `properties.photoTitle` — GeoJSON has no native layers.
- Atomic rename means no torn reads. Typical batch flow: the user labels a playlist of 10–20 photos, then the agent ingests that dir's file afterward.

See `docs/adr/0002-annotations-outbox.md`.

## Reference layers

Show **externally-owned** geo data — turbine foundations, sensitive/avoidance areas — inside the pano: read-only GeoJSON files produced and edited by outside tools (QGIS, scripts, greedy-turbine-select), passed at startup with repeatable `--layer` flags and re-loaded automatically when the file changes on disk. The viewer never writes them; there is no in-viewer editing.

**CLI contract** — repeatable flag, palette assigned in flag order:

```
npm run pano -- view <dir> --layer turbines=turbines.geojson
                          --layer avoid=areas.geojson,#cc79a7
                          --layer pads=foundations.geojson,label=turbine
```

- Grammar `<name>=<path.geojson>[,#hex][,label=<prop>]` — `#hex` and `label=` optional, either order, at most once each; malformed syntax fails fast at startup. `name` non-empty, shown in the toolbar; `path` absolute or CWD-relative. A missing file at startup warns and serves empty — not fatal, it may appear later under watch.
- Colors: `#hex` (3/4/6/8 digits) overrides the default; otherwise assigned from the Okabe-Ito colorblind-safe palette by flag order, skipping palette colors already taken by an explicit `#hex` (explicit colors never consume slots); the pool wraps when exhausted.
- Point labels: `label=<prop>` names the property; default precedence `labelProp` > `label` > `name` > `id` > `turbine` — first non-blank string wins (finite numbers stringify), no match → an unlabeled dot, never an error.
- GeoJSON only, no GPKG — producers export `.geojson` siblings instead.

**Server contract** — `GET /api/reference-layers` → `{ layers: [{ name, color, labelProp, status, dropped, vertices, features }] }` with `status: "ok" | "invalid" | "missing"`; never a 500 — a broken layer degrades with a warning. Multipart geometries (Multi*/GeometryCollection, nested arbitrarily) are flattened at load into one single-geometry feature per part, each sharing the parent feature's properties; `dropped` counts the features/parts the load rejected (invalid geometry — ⚠ in the toolbar when > 0). At load each feature is included **whole** iff it intersects the union of 600 m-radius circles around every positioned pano of the served dir (full scan, not the playlist — a playlist is a review restriction, not a data extent); no clipping — geometry and foreign properties pass through verbatim. The client fetches once on mount and refetches on every `reference-layers:changed` ws push. Each layer also carries `vertices` — its served vertex count (Point 1, LineString its length, Polygon ring sum; 0 when empty/missing, last-good kept while invalid). The serialized body and its gzip bytes are cached with the layer state — rebuilt only on an accepted change (watch reload, retry, mtime re-probe), never per request — and served with `Content-Encoding: gzip` whenever the client sends `Accept-Encoding: gzip`. A layer serving over 200 000 vertices logs one server-side warning naming the layer and suggesting producer-side simplification (e.g. 2 m Douglas-Peucker).

**Live update (file watch)** — the server watches each layer file with Vite's own watcher (no new dependency): 300 ms debounce per file → re-read → re-filter → ws push **when the served payload actually changed**. A parse failure retries once after 300 ms; still bad → keep last-good features, `status: "invalid"`. Deleted file → empty features, `status: "missing"`. Any successful parse fully replaces, `status: "ok"`. A producer wanting push semantics just writes the file. Safety net for lost watch events: each GET stats the watched files first and re-probes any whose mtime/presence changed since its last probe, unless that file already has a debounce/retry pending (same reload path, retry semantics included).

**UI contract**:

- **Render** (only when the pano has a camera position + altitude): points → colored dot + DOM label, lines → polylines, polygons → boundary + translucent fill (~15% opacity); same flat-ground projection and per-frame label discipline as annotations. Per layer everything batches into one stroke + one fill draw call, and layers build one per time slice, cheapest first — the toolbar pulses a layer's name while its slice builds.
- **Distance LOD**: a feature with no vertex within 200 m of the camera renders from a 3 m ground-DP coarse geometry computed once per payload (far features are schematic context; near features keep full fidelity). Only simplified rings are projected per switch and far fills triangulate once, so a far 68 k-vertex dissolved union costs ~nothing per pano switch.
- **Per-pano cull**: a feature with every vertex more than 700 m from the current camera is not drawn — the prefilter bounds the data extent at 600 m, the cull is per-photo render hygiene with a 100 m margin so the client never keeps what the server could have dropped. The threshold is Vincenty-exact; the per-switch cost is kept flat by per-feature caches (bbox/vertex prefilter with a safety margin, cached fill triangulation), so dense avoidance polygons don't tax `[`/`]` navigation. Features above 1000 ring vertices are additionally Douglas-Peucker-decimated in screen space before rendering (sub-pixel ε; strokes keep the true edge, fills use a 5× coarser ε under the stroke) — a dissolved 68 k-vertex avoidance union no longer stalls pano switches.
- **Layer toolbar** (bottom right): foldable, draggable by its header; position + fold persisted in `localStorage` (`pano.refLayerToolbar`). One row per layer: color swatch, name, visibility checkbox, feature count, and a ⚠ glyph when `status != "ok"` (tooltip: "invalid geojson, showing last good" / "file not found") or when `dropped > 0` (tooltip: "N feature(s) dropped: unsupported or invalid geometry"). A layer serving more than 50 000 vertices starts **hidden by default** (tooltip: "heavy layer — N vertices, hidden by default") — enable it deliberately; user toggles survive refetches. Zero layers → no toolbar at all.
- **Click-inspect**: while no capture mode is active, a click on a feature opens a small read-only readout — layer name (with swatch) + every property in file order; Esc, ✕, or a click elsewhere closes. No editing affordances.
- **Overlay opacity** (`Alt+scroll`, viewer-wide): all three shared materials (dot `0.95` / stroke `0.8` / fill `0.15`) scale by the global multiplier (10%–300%, 10% per notch, default 100%, persisted `pano.overlayOpacity`), effective alpha = base × multiplier capped at 1 — applied live by patching the built materials in place, no rebuild (heavy-layer builds are never re-costed for a notch). Transient `Overlay N%` chip under the HUD; plain scroll stays FOV zoom. Details under **Annotations → Overlay opacity**.

See `docs/adr/0003-reference-layers.md`.

## Measure mode

Ephemeral two-point ground distance/bearing on the current pano — **nothing persisted**: a measurement is not an annotation and never touches the annotations file. Needs a camera position + RelativeAltitude but no outbox.

**UI contract**:

- **Mode rail** (top left): fourth button after `point` / `line` / `polygon`, exclusive with them — entering measure exits (and clears) any annotation draft; clicking the button again or `Esc` exits and clears the measurement.
- **Capture**: `Space` at the reticle or a click (drag-guarded) sets A — same flat-ground capture as annotation vertices, same reject flash at/above the horizon. While B is unset, the dashed rubber band + chip track the live reticle aim; the second click sets B; a third click starts a new A (the finished measurement is discarded).
- **Readout chip** (projected at the measured end point): `<dist> · <bearing>° · ±<err>` — distance with the HUD `dist` formatting (10 m rounding, `> 5 km` cap), forward bearing A→B clockwise from true north at 1 dp, and ±err = the two endpoints' differential errors (pitch sensitivity + terrain) combined in quadrature; the camera-position σ is common-mode and cancels.
- **Esc chain**: in-progress annotation shape → current measurement (stays in mode) → annotation mode → measure mode → inspect readout.
- **Disabled** on `nogps-*` or missing-RelativeAltitude photos (button greyed out), like annotation modes; switching panos clears A/B.

## Caveats

- Title precedence: `--title` > playlist entry title > `id · EXIF capture time`.
- Files named `nogps-*` have `lon`/`lat` null in the manifest.
- Runs on Windows Node; no WSL involved.
