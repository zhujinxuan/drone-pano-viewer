# 01 — Height mode: vertical measurement (tree base → tree top)

Status: ready-for-agent

## What

Add a fifth mode-rail button `height` for ephemeral vertical measurement: A = tree base on the ground (standard flat-ground capture), B = tree top (free capture, pitch-only). Readout chip `H 23.5 m · d 180 m · ±2 m`. Nothing persisted.

Full contract: `../spec.md` (math, chip format, Esc chain, disabled states — follow it exactly).

## Where

- `app/src/components/AnnotationPanel.tsx` — mode rail gets the `height` button after measure.
- `app/src/App.tsx` — mode state, Space/click/Esc wiring, pano-switch clearing.
- `app/src/lib/` — height math + error model (new module, e.g. `height.ts`, colocated vitest like `measure.test.ts`; GeodTest-style reference vectors where applicable).
- `app/src/components/` — overlay (vertical 3D line at A + DOM chip; follow `MeasureOverlay.tsx` patterns: three.js objects on the sphere, chip positioned per PSV `render` event, `MeasureOverlay.css` chip styling).
- `SKILL.md` — new "Height mode" section after "Measure mode" (same contract style).
- `CONTEXT.md` — glossary row for the height measurement term.

## Acceptance

- `height` button exclusive with the four existing modes; entering exits/clears annotation draft and measure A/B; re-click/Esc exits and clears.
- A capture, horizon reject flash, and disabled states behave exactly like measure mode.
- B accepted at any pitch; `H ≤ 0` → reject flash.
- Chip shows `H (0.1 m) · d (HUD dist format) · ±err` per spec quadrature; live rubber band while B unset.
- vitest covers: H formula (known reference case), error quadrature, pitch ≤ 0 but H > 0 (short tree below horizon), H ≤ 0 rejection.
- `npm test` and `npm run build` pass in `app/`.
- Ticket gets a `## Comments` entry: branch name, files changed, test/build evidence.

## Comments

**2026-09-21 — done on `feat/vertical-measure` (worktree `~/worktrees/dpv-vertical-measure`), commit `40de230`.**

Files: `app/src/lib/height.ts` + `height.test.ts` (new), `app/src/components/HeightOverlay.tsx` + `HeightOverlay.css` (new), `app/src/App.tsx`, `app/src/components/AnnotationPanel.tsx` (5th rail button + props), `app/src/components/MeasureOverlay.tsx` (export `makeRingTexture`, shared base ring), `app/src/lib/copy-record.ts` (export `PITCH_ERR_RAD` — σ source stays single), `SKILL.md` ("Height mode" section + measure Esc-chain line), `CONTEXT.md` (**height** glossary row).

Evidence:

- `npm test`: 272 passed (17 files) — 18 new in `height.test.ts`: H formula (WGS84 equator-arc reference d, slope-atan relation), spec chip examples, error quadrature (3-4-5 + default 0.1° σ), short-tree-below-horizon accepted (slope −0.5/−0.89), H ≤ 0 rejected (−0.91/−1.1). `npm run build`: passes (tsc + vite).
- Browser smoke (synthetic 2-pano fixture, relAlt 120 m): A capture → chip `H 0.0 m · d 420 m · ±2 m` (reticle-on-A degenerate = 0, correct); live rubber band tracked pitch (H 170.3 → 272.3 m at pitch 0.12 → 0.35); B fixed → chip frozen while camera moved (and `is-hidden` behind view); steep-down aim → live chip hidden + Space → `.reticle.reject` flash (auto-clears ~400 ms), B not set; horizon aim → A reject flash; Esc 1 clears A/B (mode stays), Esc 2 exits; measure↔height↔point clicks mutually exclusive (press-state asserts); third capture restarts A at new d (420 → 180 m); `]` pano switch cleared A/B, mode persisted; `nogps-*` pano → button disabled, tooltip "no position/altitude — height measurement unavailable". Screenshot verified the orange vertical dashed line + base ring + chip.
