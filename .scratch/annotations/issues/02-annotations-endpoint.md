# 02 — Annotations endpoint: GET/POST middleware + CLI flag

Status: done
Blocked by: —

Read `.scratch/annotations/spec.md` first — the "Server endpoints" section is the binding contract. Precedent: the existing `panoPhotos()` plugin in `app/vite.config.ts` (Connect middlewares inside `configureServer`) and env-passing in `app/cli.ts`.

## Target

`app/vite.config.ts`, `app/cli.ts` (+ `app/tests/annotations-endpoint.test.ts` or wherever the repo's existing server-side tests live — check for existing vite.config/cli tests first and match their location and style; if none exist, put the test next to the config as `app/annotations-endpoint.test.ts` and make it run under the existing vitest setup).

## Change

1. **CLI**: `pano view … --annotations <path>` parsed alongside existing flags; passed to the dev server as env `PANO_ANNOTATIONS` (same pattern as `PANO_PHOTOS_DIR`). Absolute or photos-dir-relative path; default = `<photos-dir>/annotations.geojson`.
2. **Middleware** (same plugin or a sibling — match existing structure):
   - `GET /api/annotations` → 200 JSON file content; missing file → 200 `{ "type": "FeatureCollection", "version": 1, "features": [] }`; unreadable/corrupt file → 200 empty collection **with** a `console.warn` (never 500 the viewer for a bad outbox).
   - `POST /api/annotations` → read body (JSON), minimal validation (`type === 'FeatureCollection'` and `Array.isArray(features)`), then **atomic write**: write `<path>.tmp` then rename over the target (mkdir -p the parent first). 204 on success; 400 on invalid JSON or wrong shape.
   - The annotations path itself is local-trusted (single-user local tool, per ADR) — no traversal guard needed beyond what the flag supplies.
3. Keep the plugin read-side behavior unchanged for `/api/photos` and `/photos/*`.

## Acceptance

Tests green (scoped: only the new test file): GET-on-missing returns empty v1 collection; GET round-trips a POSTed collection; POST rejects `{foo: 1}` with 400; atomic write leaves no `.tmp` behind and survives a pre-existing target (rename-over-existing on Windows). `npx tsc --noEmit` clean for touched files. Do NOT run the full suite, do NOT touch React components, do NOT run formatters/linters.

## Result

`app/vite.config.ts`: new sibling `panoAnnotations()` plugin (panoPhotos untouched) — GET/POST `/api/annotations` per spec (missing→200 empty v1 collection, corrupt→200 empty + console.warn, POST validates `type==="FeatureCollection"` + `features` array then atomic `.tmp`+rename write with mkdir -p, 204/400/405; path from `PANO_ANNOTATIONS` with `<PANO_PHOTOS_DIR>/annotations.geojson` fallback). `app/cli.ts`: `--annotations <path>` (absolute or photos-dir-relative, default `<dir>/annotations.geojson`) → `PANO_ANNOTATIONS`. Tests: `app/annotations-endpoint.test.ts` (10 passing, incl. Windows rename-over-existing + no-.tmp-residue); `npx tsc --noEmit` clean (test added to tsconfig include).
