# vertical-measure — spec

Ephemeral **tree-height / vertical measurement** on the current pano: A on the ground (tree base), B on the tree top. Fifth mode-rail button `height`, exclusive with `point`/`line`/`polygon`/measure. Reuses the measure-mode capture/rubber-band/chip seams (`lib/ground-capture.ts`, `lib/measure.ts`, `MeasureOverlay.tsx`).

## Math (decided)

- A: standard flat-ground capture — yields ground position, `d` = horizontal distance cam→A (Vincenty), and A's differential error σ_d (pitch-sensitivity model, camera σ common-mode-cancelled, as in measure mode).
- B: free capture anywhere; **only pitch is used, bearing is ignored** — the user aligns the tree visually. Trees shorter than the drone's altitude legitimately appear below the horizon, so B is accepted at any pitch.
- `H = relAlt + d · tan(pitch_B)`.
- Reject (red reticle flash, never silent) when `H ≤ 0` — that means B's ray hits ground nearer than A, i.e. the user clicked a closer ground point.
- Error: `σ_H = sqrt( (d·sec²(pitch_B)·σ_pitch)² + (tan(pitch_B)·σ_d)² )` — same σ sources as measure mode.

## Readout chip

`H 23.5 m · d 180 m · ±2 m` — H at 0.1 m, d with HUD dist formatting, ±err per above. Chip projected at the top of the rendered vertical line. Ephemeral, nothing persisted.

## Contract deltas vs measure mode

- Capture of A identical (Space at reticle / drag-guarded click, horizon reject flash).
- B: Space/click at any pitch; while B unset, a vertical rubber band at A's position tracks the live reticle pitch (height live-updates); second click fixes B; third click starts a new A.
- Render: vertical 3D line at A's ground position, ground → H.
- Esc chain: in-progress annotation → current measurement (stays in mode) → annotation mode → measure mode → **height mode** → inspect readout.
- Disabled on `nogps-*` / missing-RelativeAltitude (button greyed, same tooltip pattern).
- Switching panos clears A/B.

Sibling ticket: `.scratch/overlay-opacity/issues/01-alt-scroll-opacity.md` is being implemented concurrently in another worktree; both touch `App.tsx` — expected merge, no coordination required.

Issues: `issues/01-height-mode.md`
