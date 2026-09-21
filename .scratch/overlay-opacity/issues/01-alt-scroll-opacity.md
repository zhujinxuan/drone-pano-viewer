# 01 — Alt+scroll global overlay opacity

Status: done — feat/overlay-opacity @ 9a28b9c

## What

Alt+scroll anywhere on the viewer adjusts a global opacity multiplier (10%–300%, 10%/notch, default 100%, persisted `pano.overlayOpacity`) applied to all overlay layers: reference layers + annotations. Transient `Overlay N%` chip near the HUD. Plain scroll (FOV zoom) untouched.

Full contract: `../spec.md` (scope, exclusions, gesture mechanics, persistence — follow it exactly).

## Where

- `app/src/App.tsx` (or a small hook) — capture-phase `wheel` listener on the viewer container; intercept only when Alt held.
- `app/src/lib/` — pure multiplier logic (quantize/clamp, effective-alpha computation), colocated vitest.
- `app/src/components/ReferenceOverlay.tsx`, `app/src/components/AnnotationOverlay.tsx` — apply multiplier to the shared stroke/fill materials; live in-place update preferred.
- `SKILL.md` — document the gesture in the "Reference layers" UI contract and the "Annotations" UI contract.
- `CONTEXT.md` — glossary row if a new term is introduced (e.g. "overlay opacity").

## Acceptance

- Alt+scroll changes effective opacity of reference layers and annotations; plain scroll zooms FOV exactly as before (regression check).
- Range clamps at 10%/300%; alpha never exceeds 1.0; step is 10% per notch.
- Reload restores the multiplier from `pano.overlayOpacity`; fresh profile = 100% = today's rendering.
- Chip shows `Overlay N%` on adjust and fades ~1 s after the last notch.
- vitest covers quantize/clamp steps and effective-alpha clamping.
- `npm test` and `npm run build` pass in `app/`.
- Ticket gets a `## Comments` entry: branch name, files changed, test/build evidence.

## Comments

**Branch**: `feat/overlay-opacity` (worktree `C:/Users/zhu_j/worktrees/dpv-overlay-opacity`), commit `9a28b9c`.

**Files changed**:

- `app/src/lib/overlay-opacity.ts` + `overlay-opacity.test.ts` (new) — pure logic: `clampMultiplier` (10%-grid quantize + clamp, float-dust-proof via ×10/÷10), `stepMultiplier` (±10%/notch), `effectiveAlpha` (base × multiplier, ≤ 1), `parseStoredMultiplier` / `loadOverlayOpacity` / `saveOverlayOpacity` (`pano.overlayOpacity`, LayerToolbar try/catch discipline). 36 vitest cases.
- `app/src/App.tsx` — state from `loadOverlayOpacity()`; capture-phase `wheel` listener on the viewer container registered **before** `new Viewer(...)` in the same effect with `stopImmediatePropagation()` when Alt held (PSV v5.15.1 registers its own wheel listener on the same container — at-target listeners fire in registration order, so ordering is what wins, not the capture flag; plain scroll falls through untouched); per-notch persist + `Overlay N%` chip state (1 s hold + 0.3 s fade, key-bump remount per notch).
- `app/src/components/ReferenceOverlay.tsx` — `opacityMultiplier` prop; the three shared materials get `userData.baseOpacity` tags at build (`scaleMaterial`); a dedicated effect patches live materials in place on multiplier change (multiplier deliberately NOT a build-effect dep — heavy-layer builds are never re-costed per notch; async slices read a ref so they land consistent).
- `app/src/components/AnnotationOverlay.tsx` — `opacityMultiplier` prop into `buildOverlay` (rebuild path, the component's existing lifecycle): finished strokes (0.75/0.95), polygon fills (0.15), point dots (0.95) scale; sketch/halo/vertex-marker affordances stay at base (spec §Scope: never dimmed below usability).
- `app/src/index.css` — `.opacity-chip` under the HUD + fade keyframes.
- `app/src/lib/three-core.d.ts` — `Material.opacity` / `Material.userData` added (mirrors real three r185 API, needed for in-place writes).
- `SKILL.md` — gesture documented in "Annotations" UI contract (full contract) and "Reference layers" UI contract (in-place application note). `CONTEXT.md` — **overlay opacity** glossary row.

**Test/build evidence**:

- `npm test`: 17 files / **290 passed** (36 new: quantize + clamp at 10%/300%, grid float-dust walk, effective-alpha caps at 1, storage parse incl. `Number("") === 0` bug the tests caught and fixed).
- `npm run build`: `tsc --noEmit` + vite build green.
- **Live browser smoke** (dev server + synthetic 2:1 pano with DJI XMP at the geohash position, real reference layer + annotations outbox, CDP `Input.dispatchMouseEvent` wheel events with Alt modifier, three.js scene dumps via page-world bridge): plain wheel 60°→57° FOV; during Alt+wheel FOV unchanged (PSV never sees the notch) while materials rescale live — at 130%: ref stroke 1.0 (0.8×1.3=1.04 capped), ref fill 0.195, ann stroke 0.975, ann fill 0.195, ann point sprite 1.0 (1.235 capped), PSV sphere materials untouched; 10%/notch chips `Overlay 140%/160%`; chip gone ~1.3 s after last notch; reload restores from `pano.overlayOpacity` with chip absent; 25 down-notches pin at `Overlay 10%` (0.08/0.075/0.015/0.095), 25 up-notches pin at `Overlay 300%` (fills 0.45, strokes capped 1); plain wheel still zooms afterward.
