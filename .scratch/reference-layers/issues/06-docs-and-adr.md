# 06 — Docs: CONTEXT.md glossary + SKILL.md contract + ADR-0003

**What to build:** The paper trail matches the shipped behavior. CONTEXT.md gains **reference layer** (external, read-only, file-backed GeoJSON overlay; changed from outside, propagated by file-watch; viewer never writes it) and **measure** (ephemeral two-point distance/bearing readout, never persisted), and the existing **layer** entry explicitly notes it stays an annotation-only concept (filter by photo). SKILL.md gains a "Reference layers" section (CLI flag syntax, palette, label precedence, 1 km-union prefilter, watch semantics, toolbar, click-inspect) and measure-mode UI contract, mirroring the Annotations section's tone. ADR-0003 records the decision: watch-push, no CRUD API, geojson-only, server-side prefilter — noting it further revises ADR-0001's "State: none" after ADR-0002.

**Blocked by:** 01, 02, 04, 05.

**Status:** done

- [x] CONTEXT.md: `reference layer` + `measure` terms added; `layer` entry disambiguated (annotation-only)
- [x] SKILL.md: Reference layers section (CLI contract, prefilter, watch semantics, toolbar, inspect) + measure mode UI contract
- [x] `docs/adr/0003-reference-layers.md` in ADR-0002's format
- [x] Docs match the final implemented behavior exactly (no aspirational drift)

## Comments

Spec: `.scratch/reference-layers/spec.md`. Written last so the docs describe reality, not intent.

Implemented 2026-09-12: docs written against the shipped code (cli.ts HELP + parseLayerSpecs, vite.config.ts panoReferenceLayers, lib/reference-layers.ts + reference-cull.ts + measure.ts, ReferenceOverlay/LayerToolbar/MeasureOverlay/AnnotationPanel, App.tsx wiring). One spec nuance resolved in code's favor: spec §Watch semantics can read as if every debounced file change pushes `reference-layers:changed`, but the state machine pushes only when the served payload (status + filtered features) actually changed — a byte-identical rewrite emits nothing. SKILL.md and ADR-0003 document the code behavior. Everything else verified matching: flag grammar (any-order optional segments), Okabe-Ito slot-skipping palette, label precedence `labelProp > label > name > id > turbine`, 1 km whole-feature union prefilter over the full scan (not the playlist), 300 ms debounce + single retry + last-good/"invalid", delete→"missing", localStorage key `pano.refLayerToolbar`, ⚠ tooltips ("invalid geojson, showing last good" / "file not found"), 1100 m vertex cull, ~15% fill, measure chip `<dist> · <bearing 1dp>° · ±err` with the differential (quadrature, position-σ-excluded) error, Esc chain draft → measurement → annotation mode → measure mode → inspect, disabled on nogps/missing-altitude.
