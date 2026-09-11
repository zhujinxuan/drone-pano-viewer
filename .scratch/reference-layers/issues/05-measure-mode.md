# 05 — Measure mode

**What to build:** A fourth mode-rail button `measure` (exclusive with point/line/polygon; Esc or re-click exits). First click (or `Space` at the reticle) sets point A using the same flat-ground capture as annotation vertices; mouse move shows a rubber-band line with live distance; second click sets B. A readout chip shows distance (10 m rounding, like HUD `dist`), bearing A→B (degrees, 1 dp), and ±err from the copy-record error model. A third click starts a new A. Esc clears the current measurement without exiting; exiting mode clears all. Nothing is persisted — no writes to the annotations file. Disabled on `nogps-*` / missing-RelativeAltitude photos exactly like the annotation modes.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `measure` rail button, exclusive mode, Esc/re-click exit; same disabled states as annotation modes
- [ ] A/B capture via reticle Space or drag-guarded click (annotation ground-capture reuse)
- [ ] Rubber-band line + live distance during A→B aiming
- [ ] Readout chip: distance (10 m rounding) + bearing A→B (1 dp) + ±err (copy-record model)
- [ ] Esc clears current measurement; mode exit clears all; third click restarts at A
- [ ] Pure measure lib (distance/bearing/err + formatting) unit-tested against geodesy GeodTest vectors
- [ ] Nothing persisted; annotations file untouched

## Comments

Spec: `.scratch/reference-layers/spec.md` §Measure mode. Multi-segment paths are a non-goal.
