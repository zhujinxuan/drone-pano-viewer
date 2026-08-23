# 01 — Annotation lib: types, ULID, parse/serialize, store ops

Status: done
Blocked by: —

Read `.scratch/annotations/spec.md` first — the schema section is the binding contract.

## Target

New pure module `app/src/lib/annotations.ts` (+ `app/src/lib/annotations.test.ts`). No React, no DOM, no three.js. Reuse `app/src/lib/types.ts` conventions. Follow the TDD skill: red → green, one vertical slice at a time, tests at the module's public seam only.

## Change

1. **Types**: `AnnKind = 'point' | 'line' | 'polygon'`; `AnnFeature` (GeoJSON Feature narrowed to Point/LineString/Polygon geometry with the spec's `properties`: `id`, `kind`, `label`, `photo`, `photoTitle`, `created`, `updated`, `cam: { lat, lon, src, relAltM }`, `vertexErrM: number[]`); `AnnCollection` (FeatureCollection with `version` + index signature preserving foreign members).
2. **ULID**: `newAnnId()` → `ann-<26-char Crockford base32>` (48-bit ms time + 80-bit random, monotonic-friendly within the same ms via random increment not required — human click speed makes collisions a non-issue, but the random part must make cross-dir collisions statistically impossible). No dependency; ~30 lines. Test: format, sortability (later creation → larger id), uniqueness over 10k draws.
3. **Parse (lenient)**: `parseAnnotations(json: unknown) → AnnCollection` — accepts unknown input, returns empty collection (`{type:'FeatureCollection', version:1, features:[]}`) for garbage; keeps well-formed features, drops structurally invalid ones (wrong geometry type, non-array coordinates, missing id/kind) without throwing; **preserves unknown top-level members and unknown per-feature properties** (round-trip fidelity is the test).
4. **Serialize**: `serializeAnnotations(collection) → string` — writes `version: 1`, rounds all coordinates to **7 decimals**, closes polygon rings (first == last; the in-memory model stores rings **unclosed**), pretty-printed 2-space JSON. Test: 7dp rounding, ring closure on write, unclosed in memory, unknown-member round trip.
5. **Store ops** (pure functions on the collection):
   - `createEntity(collection, draft: { kind, photo, photoTitle, cam, vertices: [lon,lat][], vertexErrM, label? })` → new collection + created feature: assigns `ann-<ULID>`, ISO `created`==`updated`, auto-name `Point N`/`Line N`/`Polygon N` when label absent — N = per-kind per-photo count of existing entities + 1. Point drafts carry exactly 1 vertex; line ≥ 2; polygon ≥ 3 (ring stored unclosed).
   - `relabelEntity(collection, id, label)` → bumps `updated` (injectable clock for tests), changes nothing else.
   - `deleteEntity(collection, id)` → removes.
   - `forPhoto(collection, photoId)` → current-photo subset, file order preserved.
   - Test the queue-semantics invariants explicitly: relabel keeps `id`, bumps `updated`, preserves `created`; delete then re-add yields a **different** id; auto-naming per kind+photo.

## Acceptance

`npx vitest run src/lib/annotations.test.ts` green from `app/`; `npx tsc --noEmit` clean for the new files. Do NOT run the full suite, typecheck the whole repo, or touch any file outside the two listed. Do NOT run formatters/linters.

## Result

`app/src/lib/annotations.ts` + `annotations.test.ts` landed (TDD, 4 red→green slices): `AnnKind`/`AnnCam`/`AnnProperties`/`AnnPosition`/`AnnGeometry`/`AnnFeature`/`AnnCollection`/`AnnDraft` types, `emptyCollection()`, monotonic `newAnnId(now?)`, lenient `parseAnnotations` (garbage→empty, drops invalid, preserves foreign members, uncloses rings), `serializeAnnotations` (version 1, 7dp rounding, ring closure on write, pure, 2-space JSON), and `createEntity`/`relabelEntity`/`deleteEntity`/`forPhoto` with injectable clocks and queue-semantics invariants. 19/19 tests green; tsc clean with project flags. Exports for siblings: `AnnKind`, `AnnFeature`, `AnnProperties.cam: AnnCam`, `AnnDraft`, and the six functions above.
