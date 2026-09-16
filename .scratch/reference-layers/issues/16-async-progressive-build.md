# 16 — Async progressive overlay build + per-layer building state in the toolbar

**Status:** done (2026-09-16)

**Filed by:** maintainer, user requests 2026-09-16: "is it possible to make the rendering async?" and "when a layer is rendering, have a visual effect on the layer name so I know which is rendering/loading and which are not."

## Design

1. **Per-layer build units**: `buildReferenceOverlay` splits into per-layer builders (one batched `LineSegments` + one fill `Mesh` + point sprites per layer — ticket 15). The component builds **one layer per time slice** (`setTimeout(0)` yields between layers), adding each finished layer's group to the scene immediately — the pano is draggable from the first frame, light layers (turbines, pads) appear within milliseconds, monster layers pop in when ready.
2. **Build order**: ascending by served vertex count (payload `vertices`, ticket 13) — cheapest first, so a heavy avoid layer never delays the light ones. Flag order remains the toolbar/color order; only build scheduling reorders.
3. **Cancellation**: a generation counter; a prop change (pano switch, visibility toggle, layer reload) invalidates pending slices, which drop their half-built state (disposed) instead of adding stale objects. Synchronous-build semantics are preserved for correctness tests via a `buildAll` path used when there is nothing to yield for (≤ 1 visible layer or all layers tiny — under a vertex threshold the build is one slice anyway).
4. **Toolbar building state**: while a visible layer's slice is pending, its toolbar row name gets a pulsing/italic `.is-building` style; `ready` when its group is in the scene. Hidden layers never build (no wasted work). State flows ReferenceOverlay → App → LayerToolbar via an `onLayerStatus` callback (same discipline as the other App-owned UI state).

## Acceptance

- [x] Two visible layers, one heavy: the light layer's objects are in the scene before the heavy layer's slice runs (ordering seam `buildQueue` in reference-build.ts, unit-tested cheapest-first)
- [x] A pano switch mid-build adds no stale objects and disposes half-built state (generation counter; cleanup disposes completed builds, pending slices drop)
- [x] Toolbar rows reflect building → ready (pulsing italic `.is-building` on the name); hidden layers show neither
- [x] Scoped vitest + typecheck green; browser smoke: layers progress candidates → backup → primary → avoid-soft and all reach ready; the stuck-building bug the smoke exposed was the cam-identity rebuild loop (see ticket 15), fixed by memoization, then re-verified
- [x] spec.md §Client behavior + SKILL.md render/toolbar bullets updated
