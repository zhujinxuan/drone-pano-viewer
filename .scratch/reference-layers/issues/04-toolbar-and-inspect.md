# 04 — Layer toolbar + click-inspect

**What to build:** A foldable, draggable floating toolbar lists every reference layer: color swatch, name, visibility checkbox (all on by default), feature count, and a warning glyph when `status != "ok"` (tooltip: invalid → "invalid geojson, showing last good"; missing → "file not found"). Fold state and panel position persist in localStorage. Clicking a rendered reference feature opens a small readout (layer name + properties table), dismissed by Esc or clicking elsewhere. Read-only — no editing affordances anywhere.

**Blocked by:** 03 — Reference rendering.

**Status:** ready-for-agent

- [ ] Toolbar: foldable (collapses to header bar) + draggable by header; position + fold persisted in localStorage
- [ ] Per-layer row: swatch, name, visibility checkbox (drives ReferenceOverlay), feature count, status glyph + tooltip
- [ ] Click a reference feature → properties readout panel; Esc / click-elsewhere dismisses
- [ ] Zero editing affordances; annotations interactions untouched
- [ ] Works with zero layers (toolbar hidden or empty-state, not broken)

## Comments

Spec: `.scratch/reference-layers/spec.md` §Client behavior.
