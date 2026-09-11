# 02 — File-watch live reload for reference layers

**What to build:** Editing, replacing, or deleting a `--layer` file on disk while the viewer runs propagates without restart: the server watches each layer file (Vite's own watcher, no new deps), re-reads + re-filters on change (300 ms debounce), and pushes `reference-layers:changed` over the Vite ws so connected clients refetch. Malformed mid-write states never blank a layer: one retry after 300 ms, then last-good features with `status: "invalid"`. Deleting the file empties the layer with `status: "missing"`. A successful parse fully replaces features with `status: "ok"`.

**Blocked by:** 01 — CLI layer flags + endpoint.

**Status:** ready-for-agent

- [ ] `server.watcher.add` per layer path in configureServer; 300 ms debounce per file
- [ ] Re-read + re-filter on change; state change → `server.ws.send("reference-layers:changed")` (no payload)
- [ ] Parse failure → one retry after 300 ms → still bad: keep last-good features, `status: "invalid"`
- [ ] File deleted → empty FeatureCollection, `status: "missing"`
- [ ] Successful parse → full replace, `status: "ok"`
- [ ] Verified by scripted file edits against a running programmatic server (edit → endpoint reflects; corrupt → last good + invalid; delete → missing; restore → ok)

## Comments

Spec: `.scratch/reference-layers/spec.md` §Watch semantics.
