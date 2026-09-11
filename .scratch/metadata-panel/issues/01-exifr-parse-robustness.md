# 01 — MetadataPanel: exifr sync throw / undefined hangs the panel

**What to build:** For some image files `exifr.parse` throws **synchronously** or resolves `undefined`; the current `.catch(() => null)` misses the sync throw and a following `DJI_KEYS.some(k => k in exifrOut)` then throws on `undefined` — the metadata panel hangs on "Parsing metadata…" forever and `relAlt` never arrives (silently disabling annotations/measure). Real DJI panos don't trigger it; malformed/synthetic JPEGs do. Wrap the parse in try/catch (sync + async) and guard the undefined case so the panel always settles (empty metadata state, like missing EXIF).

**Blocked by:** None — can start immediately.

**Status:** needs-triage

- [ ] Sync throw from exifr.parse caught → panel settles to empty/failed state
- [ ] `undefined` parse result guarded (no `in` on undefined)
- [ ] Panel never sticks on "Parsing metadata…"
- [ ] Annotations/measure enablement unchanged for healthy DJI panos

## Comments

Found 2026-09-11 by the ticket-03 implementer (RainyWorm) via synthetic canvas-JPEG fixtures during browser smoke; pre-existing at HEAD, untouched there. File: `app/src/components/MetadataPanel.tsx`.
