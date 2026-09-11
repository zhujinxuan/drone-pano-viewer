# 03 — Reference layers rendered in the pano

**What to build:** The viewer fetches `/api/reference-layers` on mount, refetches on the `reference-layers:changed` HMR event, and draws every layer through the existing overlay seam: Point → sprite dot in layer color + DOM label (labelProp, else `label > name > id > turbine`, else bare dot); LineString → projected polyline; Polygon → boundary polyline + translucent fill (~15% opacity). Features whose every vertex is > 1100 m from the current camera are not rendered. Overlay attaches to the scene root exactly like the annotation overlay (not rotated by sphereCorrection), with the same attach/detach/dispose discipline. Renders nothing for `nogps-*`/altitude-less photos.

**Blocked by:** 01 — CLI layer flags + endpoint.

**Status:** done

- [x] Fetch on mount (cancelled-flag pattern like annotations) + `import.meta.hot.on("reference-layers:changed", refetch)`
- [x] ReferenceOverlay component: points/lines/polygons per spec, layer color, translucent polygon fill ~15%
- [x] Point labels as DOM markers via per-frame projection (annotation-label approach), label precedence honored
- [x] Per-pano cull at 1100 m (vertex-based, documented)
- [x] Scene-root attach, full dispose on rebuild/unmount; no annotation behavior changed
- [x] `three-core.d.ts` extended only if a needed export is missing
- [x] Visually verifiable: a layer geojson near a pano renders in the sphere view

## Comments

Spec: `.scratch/reference-layers/spec.md` §Client behavior. Toolbar (visibility toggles) and click-inspect are ticket 04 — this ticket renders all layers always-visible.

Implemented 2026-09-11. 8 cull tests green + browser smoke (synthetic pano + 3 layers: cull verified — far edge-clip line served but not rendered; HMR event → new label without reload; label precedence incl. labelProp + 水保点 fallback + bare dot; nogps renders nothing; fill 15%). Code review (Standards+Spec): pass; fixed colorNum to accept all contract hex widths (3/4/6/8) so DOM and 3D scene agree; fixed test-header margin claim. Latent pre-existing MetadataPanel exifr sync-throw hang filed as .scratch/metadata-panel/issues/01 (needs-triage).
