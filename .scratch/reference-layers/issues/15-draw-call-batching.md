# 15 — Batch reference-layer draw calls: one stroke + one fill object per layer

**Status:** done (2026-09-16)

**Filed by:** maintainer, user report 2026-09-16: viewer dragging is super slow with the avoidance layer on.

## Diagnosis

`buildReferenceOverlay` creates one `Line` per ring and one `Mesh` per polygon fill: the reporter's 5-layer set (234 avoid polygons, one with ~900 rings, plus turbines/pads/manual layers) yields ~10³ draw calls per frame. While dragging, PSV re-renders every frame, so WebGL draw-call submission overhead (~0.01–0.05 ms each) alone can eat the 16 ms frame budget on an iGPU. Geometry is static between pano switches — the per-frame cost is pure draw-call count + overdraw.

## Design

Per layer, per build: accumulate every stroke into ONE `LineSegments` (segment pairs appended to a per-layer vertex list) and every fill into ONE non-indexed triangle-soup `Mesh` (current `makeFill` already builds non-indexed triangles — concatenate). Per-layer draw calls become ~2 (+ one per point sprite) instead of O(features). Frustum culling granularity is lost, but everything rendered is within 700 m of the camera on an always-drawn sphere — nothing to win back. Materials are already per-layer shared; visual output identical.

## Acceptance

- [x] One LineSegments + one fill Mesh per visible layer (browser-measured: 8 draw calls/frame with all 5 reporter layers visible, was ~10³)
- [x] Strokes/fills render identically (same vertices, same colors/opacities; browser screenshot verified avoid-hard outlines + fills)
- [x] Scoped vitest + typecheck green; browser smoke: dragging smooth with the reporter's layer set (p50/p90/p99/max = 8/8/9/9 ms)
- [x] SKILL.md render bullet + spec.md §Client behavior note updated

## Additional root cause found during the smoke (2026-09-16)

Batching was necessary but not sufficient: App's `camFix`/`groundCam` were plain per-render objects, so every App re-render (HUD ticks at 10 Hz — continuous during a drag) changed the overlay effect's `cam` dep identity and **restarted the entire overlay build per HUD tick**. Observed symptom: layers stuck at "building" forever, only the cheapest slice ever completing. Fixed by memoizing `camFix`/`groundCam` on value identity (plus `labels` in ReferenceOverlay and a stable EMPTY_LAYERS constant). This, not draw calls alone, was likely the dominant "superslow while dragging" term. Same class of bug as the stale-closure family: prop identity is an effect contract.
