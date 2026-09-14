# 09 — Loading performance: 4.9 MB uncompressed layer JSON, dev-mode vite, no pano preload

**Status:** ready-for-agent (items 1+4 only — see triage comment)

**Note (2026-09-14):** tickets 07/08 are being fixed by another agent in parallel — this ticket is independent (payload size / transport / decode, not correctness).

## What I ran

Batch-review session (9 playlists × ≤20 panos, 5 reference layers) per tickets 07/08 command, photos dir `resources/2026-07-27-drone-panorama/step-01-panorama/outputs` (271 panos, 8.5–32.5 MB each). User report: "viewer loading is very slow".

## Measured (2026-09-14, localhost, viewer restarted)

| Stage | Cost | Notes |
|---|---|---|
| `GET /api/photos` | 0.06 s | fine |
| `GET /api/reference-layers` | 0.11 s server-side, **4.9 MB payload uncompressed** | after producer-side trims (see below); was 8.7 MB |
| pano JPEG fetch | 17.6 MB in 0.25 s (72 MB/s loopback) | network fine — the cost is client decode + 14400×7200 texture upload |
| layer geojson on disk | 5.7 MB total (was 23.5 MB) | parsed at startup + every watch reload |

Producer-side trims already applied (simplify polygons 2 m DP + drop polygons >5 km from turbines, exploded per ticket 07): served payload 8.7 → 4.9 MB. The near-farm residential-500 m union is intrinsically vertex-dense (~900 vertices/polygon average over 234 served polygons).

## Suggestions (app-side, in rough impact order)

1. **gzip the `/api/reference-layers` payload** — 4.9 MB of coordinate JSON compresses ~7–10×; one `compression` middleware (or manual `zlib.gzipSync` per layer state, invalidated with the watch) kills most of the client fetch+parse cost on every mount and every `reference-layers:changed` refetch.
2. **Preload the next pano during playlist review** — multi-pano-nav ticket 01 listed 预载下一张; unclear if it shipped. Without it, every `[`/`]` pays full fetch + decode + texture upload serially.
3. **Prod-build serving mode** (`vite build` + preview, or a bundled flag) — dev-mode module transform makes first page load do hundreds of on-demand requests.
4. Optional: vertex-budget warning — when a served layer exceeds e.g. 200 k vertices, log a hint that producers should simplify (producer-side discipline like the 2 m DP above is otherwise invisible to app users).

## Comments

**Triage (maintainer, 2026-09-14):** Measurements accepted, thanks — item-by-item verdict:

- **Item 1 (gzip) — accepted, this ticket's scope.** Per-layer `zlib.gzipSync` cached alongside the layer state, invalidated on every accepted payload change (watch, retry, and the new request-time mtime re-probe from ticket 08); serve with `Content-Encoding: gzip` when the client sends `Accept-Encoding`. Do NOT gzip per request — the payload is state, cache the compressed bytes with it.
- **Item 2 (preload next pano) — not this ticket.** It is already specified in `.scratch/multi-pano-nav/issues/01-playlist-keyboard-nav.md` (预载下一张, still open). Cross-reference added; implement there.
- **Item 3 (prod-build serving) — ready-for-human, split out of this ticket.** The dev middleware IS the server (photos scan, annotations outbox, reference layers); a prod mode means either a second static-server wiring or `vite preview` + middleware review — an architecture decision, not a perf tweak. Not blocking the review loop once items 1+2 land.
- **Item 4 (vertex-budget warning) — accepted, this ticket's scope.** Server-side `console.warn` when a layer's served feature set exceeds 200 k vertices (count once per accepted load), naming the layer and suggesting producer-side simplify. Matches the degrade-loudly convention; producers otherwise can't see the cost.

This ticket is done when items 1+4 land; it does not gate on 2 or 3.

## Impact

Batch pano review of 187 turbines × 5 layers — the current per-session overhead is felt on every page open and layer change; items 1+2 would make the review loop feel near-instant.
