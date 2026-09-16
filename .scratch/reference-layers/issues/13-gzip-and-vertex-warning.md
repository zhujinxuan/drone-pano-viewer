# 13 — Serve reference-layers payload cached + gzipped; vertex-budget warning (ticket 09 items 1+4)

**Status:** done

**Filed by:** maintainer, 2026-09-16. Implements the accepted scope of ticket 09 (items 1+4); closes 09.

## What to build

1. **Cached serialization + gzip** of `GET /api/reference-layers` (vite.config.ts `panoReferenceLayers`):
   - Today the handler `JSON.stringify({ layers: … })`s the full payload on every request (measured 4.9 MB uncompressed on the reporter's 5-layer set, ticket 09).
   - Cache the serialized body `{ layers: [...] }` and its `zlib.gzipSync` bytes alongside the layer state; invalidate on every accepted payload change (watch reload, retry, and the request-time mtime re-probe from ticket 08). Boot builds lazily on first GET.
   - Serve with `Content-Encoding: gzip` when the client's `Accept-Encoding` includes `gzip`, identity otherwise. Never gzip per request.
2. **Vertex-budget warning**: on each accepted load, count the served features' vertices once; when a layer exceeds 200 000 vertices, `console.warn` naming the layer and suggesting producer-side simplification (e.g. 2 m Douglas-Peucker). Degrade-loudly convention: producers otherwise can't see the cost.
3. **`vertices` in the payload**: each layer object gains `vertices: number` — the served vertex count computed for item 2 (0 for empty/missing). Additive contract change; the client uses it for build scheduling (ticket 16) and default-visibility seeding (ticket 17). spec/SKILL server contract updated accordingly.

## Acceptance

- [x] Endpoint bytes identical to today's payload (modulo key order — build the cache from the same `{ layers: layer.payload }` mapping); gzip round-trip verified by fetching with `Accept-Encoding: gzip` and inflating
- [x] Compression happens once per accepted change, not per request (test: two GETs, spy/count gzip calls, or invalidate-and-observe)
- [x] Payload change (file rewrite under watch or mtime re-probe) invalidates the cache — next GET serves the new content
- [x] Vertex warning fires once per accepted load over budget, names the layer; under budget stays silent
- [x] Scoped vitest green (endpoint test after the annotations-endpoint.test.ts pattern); spec.md §Server endpoint + SKILL.md server contract updated
