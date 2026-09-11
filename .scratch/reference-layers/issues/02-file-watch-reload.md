# 02 — File-watch live reload for reference layers

**What to build:** Editing, replacing, or deleting a `--layer` file on disk while the viewer runs propagates without restart: the server watches each layer file (Vite's own watcher, no new deps), re-reads + re-filters on change (300 ms debounce), and pushes `reference-layers:changed` over the Vite ws so connected clients refetch. Malformed mid-write states never blank a layer: one retry after 300 ms, then last-good features with `status: "invalid"`. Deleting the file empties the layer with `status: "missing"`. A successful parse fully replaces features with `status: "ok"`.

**Blocked by:** 01 — CLI layer flags + endpoint.

**Status:** done

- [x] `server.watcher.add` per layer path in configureServer; 300 ms debounce per file
- [x] Re-read + re-filter on change; state change → `server.ws.send("reference-layers:changed")` (no payload)
- [x] Parse failure → one retry after 300 ms → still bad: keep last-good features, `status: "invalid"`
- [x] File deleted → empty FeatureCollection, `status: "missing"`
- [x] Successful parse → full replace, `status: "ok"`
- [x] Verified by scripted file edits against a running programmatic server (edit → endpoint reflects; corrupt → last good + invalid; delete → missing; restore → ok)

## Comments

Spec: `.scratch/reference-layers/spec.md` §Watch semantics.

Implemented 2026-09-11. 50 tests green + scripted e2e vs real createServer/chokidar (edit→346ms, corrupt→last-good+invalid 612ms, unlink→missing 422ms, restore→ok 337ms; one ws send per accepted transition). Code review (Standards+Spec): pass; accepted risks recorded — no watcher-teardown hook (300ms window, process exit reaps), chokidar path-normalization echo assumed (guarded by byPath), prefilter circles now boot/reload-cached (newly pulled panos widen the union on the next layer-file change, not on plain refresh).
