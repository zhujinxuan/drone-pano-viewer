# 01 — MetadataPanel: never hang on parse failure + loud degrade banner

**What to build:** Two halves. (1) **Never hang**: for some files `exifr.parse` throws **synchronously** (escaping the current `.catch`) or resolves `undefined` (breaking `k in exifrOut`) — the effect dies before `setLoading(false)` and the panel sticks on "Parsing metadata…" forever, silently disabling annotations/measure. Wrap the parse so sync throws are caught and treat `undefined` like `null`; the panel always settles (metadata, the existing XMP-regex fallback, or the error state). (2) **Loud degrade, not hard block**: when a photo's metadata ends in the error/empty state, show a visible warning banner on the viewer — "metadata parse failed — dist / annotations / measure unavailable" — so greyed-out mode buttons are never unexplained. The photo still displays; the design is degrade-with-explanation, matching the `nogps-*` precedent.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Sync throw from `exifr.parse` caught → panel settles to the error state (try/catch around the await, or equivalent)
- [x] `undefined` parse result treated as failure (loose `== null` guard before `DJI_KEYS.some(...)`)
- [x] Panel never sticks on "Parsing metadata…" for any input
- [x] Warning banner rendered while the current photo has no usable metadata (parse failure or empty): names the unavailable features (dist / annotations / measure); dismissable or per-photo automatic — implementer's call, but never a modal and never blocking the pano
- [x] Healthy DJI panos unchanged: no banner, annotations/measure enablement untouched
- [x] Pure logic (settle/guard decisions) unit-tested if extracted; UI verified by browser smoke with a malformed-JPEG fixture: banner shows, photo renders, mode buttons greyed, no console errors

## Comments

Found 2026-09-11 by the ticket-03 implementer via synthetic canvas-JPEG fixtures during browser smoke; pre-existing at HEAD. Design settled with the user 2026-09-11: degrade-loudly beats block-the-photo (pixels are primary, metadata auxiliary; `nogps-*` precedent; QA/strict-batch concerns belong to an audit command, not the interactive viewer). File: `app/src/components/MetadataPanel.tsx` + banner wiring in `App.tsx`.

Implemented 2026-09-11. Parse seam extracted to `app/src/lib/metadata.ts` (`parseImageMeta`: try/catch around the await catches sync throws, `?? null` normalizes undefined, XMP fallback preserved byte-for-byte incl. `{...xmp, ...m}` precedence); panel wires `onMetadataError` → App degrade banner (`meta-warn`, amber, non-blocking, resets on pano switch). 7 seam unit tests (vi.mock exifr: sync throw / undefined / rejection / fallback recovery / fetch-500 / healthy paths). Browser smoke: stripped-APP1 JPEG → banner "⚠ metadata unavailable — dist / annotations / measure disabled" + photo renders + all 4 mode buttons greyed with tooltip + panel settles "No EXIF/XMP metadata found in this file." + zero console errors; healthy XMP fixture → no banner, measure enabled. Code review (Standards+Spec): pass; hoisted the duplicated error literal. Banner wording softened from the ticket's "metadata parse failed" to "metadata unavailable" to cover the empty-metadata case. Full suite 201 green, build clean.
