# overlay-opacity — spec

Global overlay opacity multiplier, adjusted with **Alt+scroll** anywhere on the viewer. Motivation: layers are often too faint to see against the pano, but the current default is the right balance for reading the photo — so the multiplier must go **above** 100%, default stays 100%.

## Scope

Applies to **all drawn overlay layers**: reference layers (`ReferenceOverlay.tsx` — shared materials, stroke 0.8 / fill 0.15) and annotations (`AnnotationOverlay.tsx` — line 0.75/0.95, polygon fill 0.15). Effective alpha = base alpha × multiplier, clamped at 1.0.

Excluded: measure/height rubber bands and chips, HUD, reticle, annotation in-progress shapes' interactive affordances are not dimmed below usability — simplest correct rule: only the two overlay scene graphs above are scaled; everything else untouched.

## Contract

- **Gesture**: Alt+scroll up = more opaque, down = more transparent. Plain scroll stays PSV FOV zoom — install a **capture-phase** `wheel` listener on the viewer container (PSV owns the wheel; no app-level listener exists today), `preventDefault`/`stopPropagation` only when Alt is held. Alt and Shift are both free; Alt chosen.
- **Range**: 10%–300%, 10% per wheel notch, default 100%.
- **Persistence**: `localStorage` key `pano.overlayOpacity` (same pattern as `pano.refLayerToolbar`).
- **Feedback**: transient `Overlay 140%` chip near the HUD while adjusting, fades ~1 s after the last notch.
- **Application**: live, no pano reload — the overlays use a handful of shared materials, so update material opacity in place; falling back to a rebuild of the overlay scene graphs is acceptable if in-place update fights the existing build lifecycle.

Sibling ticket: `.scratch/vertical-measure/issues/01-height-mode.md` is being implemented concurrently in another worktree; both touch `App.tsx` — expected merge, no coordination required.

Issues: `issues/01-alt-scroll-opacity.md`
