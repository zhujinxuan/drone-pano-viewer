# 07 — Prefilter silently drops Multi* geometries (MultiPolygon serves 0 features)

**Status:** done

## What I ran

```bash
cd C:/Users/zhu_j/.agents/skills/drone-pano-viewer/app && npm run pano -- view \
  C:/Users/zhu_j/workspace/sensitive/jilb-吉林/吉林油田松原1.2GW/resources/2026-07-27-drone-panorama/step-01-panorama/outputs \
  --playlist …/decisions/2026-09-14-pano-reference-review/step-01-review-playlists/outputs/playlists/batch-01.json \
  --title "批次01 机位核查" \
  --layer primary=…/step-00-reference-layers/outputs/turbines-primary.geojson,#0072b2,label=id \
  --layer backup=…/step-00-reference-layers/outputs/turbines-backup.geojson,#56b4e9,label=id \
  --layer avoid-hard=…/step-00-reference-layers/outputs/avoid-hard.geojson,#d55e00 \
  --layer avoid-soft=…/step-00-reference-layers/outputs/avoid-soft.geojson,#e69f00 \
  --layer manual=…/step-00-reference-layers/outputs/manual-labels.geojson,#cc79a7,label=label
```

Photos dir: `resources/2026-07-27-drone-panorama/step-01-panorama/outputs` (271 positioned panos, geohash8 stems).

`avoid-hard.geojson` = 1 feature, `MultiPolygon` with 200 152 vertices, extent (113.26E, 23.30N)–(130.64E, 48.77N), covering the farm at ~(123.93E, 44.56N). `avoid-soft.geojson` similar (458 112 vertices). Both valid GeoJSON, CRS84.

## Expected

`GET /api/reference-layers` → avoid-hard / avoid-soft `status: "ok"` with the feature included (many vertices + segments sit inside the 1 km circle union around the 271 panos).

## Actual

Both layers return `status: "ok"` but `features: {type: "FeatureCollection", features: []}` — **zero** features. Point and LineString layers (primary/backup/manual) pass correctly.

## Cause (read-only diagnosis)

`app/src/lib/reference-layers.ts` `intersectsUnion()` special-cases `Point` and `LineString`, then falls through to `g.coordinates.some((ring) => …)` which assumes **Polygon** (coordinates = rings). For MultiPolygon, coordinates = array of polygons, so `hitNearCircle` iterates rings-as-"vertices": `v[0]` is a coordinate pair, not a number → distances are `NaN` → never `<= radiusM` → the feature is dropped **silently** (`status` stays `ok`, so the toolbar shows no ⚠).

Same gap likely applies to MultiLineString / MultiPoint / GeometryCollection, and possibly the client-side cull/render path (`reference-cull.ts` / overlay) — not verified.

## Impact on my workflow

High. Wind-project avoidance layers are dissolved MultiPolygons by construction (QGIS/geopandas union output). A silent empty layer during a turbine-vs-sensitive-area pano review reads as "no conflict here" — a false-negative safety hazard, worse than an error.

## Workaround in use

Producer-side: explode unions into individual Polygon features before serving (also improves payload — far-away polygons get prefiltered out). No app patch applied, per skill rules.

## Suggested fix direction

Flatten Multi*/GeometryCollection to their single-geometry parts at load (or make `intersectsUnion` + cull + render recurse), AND surface a ⚠ when a parsed feature's geometry type is unhandled instead of serving 0 features with `status: "ok"`.

## Comments

**Triage (maintainer, 2026-09-14):** Confirmed real, accepted as bug. One correction to the mechanism: the drop happens at **load**, not in the prefilter — `isRefGeometry()` returns `false` for Multi*/GeometryCollection, so `parseReferenceGeoJSON()` filters the feature out of the collection and `intersectsUnion()` never sees it. Same observable hazard as reported: silent `ok` with 0 features. Fix direction accepted with a refinement — flatten Multi*/GeometryCollection into single-geometry features **at load** (`parseReferenceGeoJSON`), which keeps `RefGeometry`, the prefilter, the cull, and the renderer untouched. Additionally thread a `dropped` count (structurally invalid features) from load through the payload and show ⚠ in the toolbar when `dropped > 0`, so a silent-empty layer becomes visible. Spec §endpoint + SKILL.md §Reference layers must be updated with the contract change.

**Resolution (2026-09-14):** Fixed as triaged. `parseReferenceGeoJSON` flattens MultiPoint/MultiLineString/MultiPolygon/GeometryCollection (nested) into single-geometry features at load — the reporter's dissolved-MultiPolygon avoidance layers now serve their intersecting parts instead of a silent empty collection. `dropped` count threaded load → machine → payload; toolbar ⚠ on `dropped > 0`. Prefilter/cull/render math untouched. 64/64 vitest green (incl. the avoid-hard.geojson scenario test). ADR-0003 amendment recorded.
