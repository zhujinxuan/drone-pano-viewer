# 07 — Integration: App.tsx wiring (orchestrator-only)

Status: done

## Result

Wired by the orchestrator 2026-08-23. App.tsx: boot GET + load-then-rewrite autosave (300 ms debounce, saving/saved HUD indicator, load-failure disables annotation rather than risking a clobbering write); mode/draft/selection state; single merged global keydown listener (nav + annotation keymap); drag-guarded PSV click-to-add (6 px slop); reject flash via `.reticle.reject`; copyRecord rewired to the `groundTarget` seam (inline Vincenty math deleted). `cameraSourceText` exported from copy-record.ts as the `cam.src` source. Review fixes folded in: `featureVertices` moved to lib/annotations (single geometry-unwrap site), `onLookAt` = swing-only vs `onSelect` = select+swing, `onPendingLabelDone` closes the stale-pending `l`-relabel defect (SpecReview P2). vertexView/centroidView duplication recorded as deliberate (closed-form linearization on the render hot path vs iterative Vincenty for one-shot swings). Verified: 111/111 vitest, tsc clean, browser smoke on a real DJI pano (point/line/polygon, undo vertex, auto-name + CJK relabel with updated bump on disk, delete + 5 s undo toast same-id restore, photo-switch layering, reload persistence, above-horizon reject for both Space and click paths, disabled-state tooltip).
Blocked by: 01, 03, 04, 05

## Target

`app/src/App.tsx` (the only file every slice converges on), plus small glue as needed.

## Change

1. Boot: `GET /api/annotations` alongside the manifest fetch; hold the full collection in state; current-photo subset derived via `forPhoto`.
2. Autosave: every mutation → debounced (~300 ms) `POST /api/annotations` of the full collection; "saved ✓ / saving…" indicator.
3. Mode state (point/line/polygon/null), in-progress shape state, selection state; wire `AnnotationPanel` + `AnnotationOverlay` per their reported prop contracts.
4. Keyboard: extend the existing global listener — Space add vertex (reticle), Enter finish, u/Backspace undo vertex, Esc cancel/exit, Delete/d delete selected (instant + toast), l relabel selected, Tab cycle, e toggle panel. Do not break [/]/p/n. Photo switch discards in-progress.
5. Click-to-add: PSV `click` event, drag-guarded, in draw modes only → `groundTarget` at clicked yaw/pitch.
6. Vertex capture path: reticle yaw/pitch (or click coords via `dataHelper.viewerCoordsToSphericalCoords`) → `groundTarget(cam, yaw, pitch)` → vertex + `errM`; null → red reticle flash, no vertex.
7. Finish: validate min vertices (line ≥ 2, polygon ≥ 3) → `createEntity` with cam fix + auto-name → select it + open label input.
8. `canAnnotate` = current photo has position AND RelativeAltitude (same signals the copy button uses).
9. List click → select + `swingTo(centroidView(cam, vertices))`.
10. Rewire `copyRecord` to the extracted `ground-capture` seam if ticket 03 created one (delete the duplicated inline math).

## Acceptance

Full `npm test` + `npm run typecheck` green; browser smoke on a real photos-dir: draw each kind, undo, finish, relabel, delete+undo, switch photos, verify `annotations.geojson` on disk matches the schema, reload restores.
