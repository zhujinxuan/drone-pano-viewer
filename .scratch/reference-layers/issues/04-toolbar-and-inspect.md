# 04 — Layer toolbar + click-inspect

**What to build:** A foldable, draggable floating toolbar lists every reference layer: color swatch, name, visibility checkbox (all on by default), feature count, and a warning glyph when `status != "ok"` (tooltip: invalid → "invalid geojson, showing last good"; missing → "file not found"). Fold state and panel position persist in localStorage. Clicking a rendered reference feature opens a small readout (layer name + properties table), dismissed by Esc or clicking elsewhere. Read-only — no editing affordances anywhere.

**Blocked by:** 03 — Reference rendering.

**Status:** done

- [x] Toolbar: foldable (collapses to header bar) + draggable by header; position + fold persisted in localStorage
- [x] Per-layer row: swatch, name, visibility checkbox (drives ReferenceOverlay), feature count, status glyph + tooltip
- [x] Click a reference feature → properties readout panel; Esc / click-elsewhere dismisses
- [x] Zero editing affordances; annotations interactions untouched
- [x] Works with zero layers (toolbar hidden or empty-state, not broken)

## Comments

Spec: `.scratch/reference-layers/spec.md` §Client behavior.

Implemented 2026-09-12. New `lib/reference-inspect.ts` (pure screen-space nearest-stroke hit-test: point/segment/closed-ring paths, threshold-inclusive, stable layer-order ties) with 9 vitest cases; `LayerToolbar.tsx` (+css) carries the draggable/foldable panel (pointer-capture header drag, `pano.refLayerToolbar` localStorage) and the read-only `InspectReadout`; ReferenceOverlay gained an `onInspect` prop and a container-level drag-guarded click listener (same 6 px slop as App's click-to-add) that projects visible unculled features via `vertexView` → `sphericalCoordsToViewerCoords`, frustum-filtered; App gates the sink to `onInspect = mode === null && !measureOn ? handleInspect : null` so annotation/measure capture is never stolen, appends inspect-dismiss to the end of the Esc chain, and clears the readout on pano switch. `npx tsc --noEmit` clean; scoped vitest 3 files/67 tests green (incl. new reference-inspect). Browser smoke (synthetic 64×32 XMP pano + turbines/zone/gone layers): 3 rows with swatches/counts, ⚠ "file not found" on gone; checkbox hides/restores dots+labels; drag clamped at viewport edge persisted exactly across reload, fold persisted (folded header still draggable), unfold via real click; T1/T2 point clicks and a zone polygon mid-edge click (segment math, vertex 40 px away) opened the properties readout; Esc and click-elsewhere dismissed; point-mode click on a reference dot created an annotation (label input) with no readout; measure two clicks produced the chip with no readout; inspect re-enabled after mode exit; zero-layer server renders no toolbar; 0 console errors.

Code review (Standards+Spec) 2026-09-11: pass. Fixed: false INSPECT_HIT_PX comment (inverted slop claim); inspect readout now also clears on entering annotation/measure mode (was lingering). Accepted cosmetic partial: click-elsewhere dismiss registers on pano-canvas clicks only (chrome clicks keep it open; Esc/✕ always close).
