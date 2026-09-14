# 08 — File watch intermittently misses a layer rewrite (stale `ok` payload until restart)

**Status:** done

## What I ran

```bash
cd C:/Users/zhu_j/.agents/skills/drone-pano-viewer/app && npm run pano -- view \
  C:/Users/zhu_j/workspace/sensitive/jilb-吉林/吉林油田松原1.2GW/resources/2026-07-27-drone-panorama/step-01-panorama/outputs \
  --playlist …/decisions/2026-09-14-pano-reference-review/step-01-review-playlists/outputs/playlists/batch-01.json \
  --title "批次01 机位核查" \
  --layer primary=…/step-00-reference-layers/outputs/turbines-primary.geojson,#0072b2,label=id \
  --layer backup=…/step-00-reference-layers/outputs/turbines-backup.geojson,#56b4e9,label=id \
  --layer avoid-hard=…/step-00-reference-layers/outputs/avoid-hard.geojson,#d55e00 \
  --layer avoid-soft=…/step-00-reference-layers/outputs/avoid-soft.geojson,#e69f00 \
  --layer manual=…/step-00-reference-layers/outputs/manual-labels.geojson,#cc79a7,label=label
```

Photos dir as above. While the server was running, the producer script rewrote all five layer files (geopandas `to_file`, non-atomic truncate+write) twice within a few minutes (5 files per run, ~1 s apart within a run).

## Expected

After each rewrite, every changed layer re-reads and `/api/reference-layers` reflects the new content (e.g. backup 45 → 90 features).

## Actual

- `turbines-primary.geojson` (45 KB → 90 KB class) reloaded correctly: 142 → 284 features.
- `turbines-backup.geojson`, rewritten in the same script run seconds apart, **never reloaded**: API kept serving the old 45 Point features with `status: "ok"` for minutes (checked repeatedly, well past the 300 ms debounce). Only a full server restart picked up the 90-feature file.
- No `invalid`/`missing` state appeared at any point — the layer looked healthy but was silently stale.

## Impact

Medium-high: a producer iterating on layer files (the normal "tweak → rerun → look" loop) can end up reviewing stale data with no ⚠ signal — same false-confidence class as ticket 07.

## Notes for triage

- Both files live in the same directory and were written by the same process ~1 s apart, so a per-file debounce collision is unlikely; more like a chokidar `change` event lost on Windows, or a parse-during-partial-write that failed twice and latched last-good without surfacing.
- Consider: on parse-retry failure, set `status: "invalid"` (visible ⚠) rather than silently keeping last-good with `ok`; and/or an endpoint-level `mtime` check as a cheap safety net.

## Comments

**Triage (maintainer, 2026-09-14):** Confirmed plausible, accepted. Notes on the diagnosis: the parse-retry-failure path already latches `status: "invalid"` (second failed probe is terminal in `acceptLayerProbe`), and you never saw `invalid` — so the retry path was never entered; the watch event itself was lost (chokidar/fs.watch on Windows can drop events under rapid multi-file writes; root cause not proven and not worth chasing). Accepted fix: the endpoint-level **mtime safety net** — `GET /api/reference-layers` stats every watched file before answering and re-probes any file whose mtime/presence changed since the last probe, folding through the same `acceptLayerProbe` machine (retry semantics preserved). This makes stale-forever impossible regardless of watcher flakiness, at the cost of one `stat` per file per request. Spec §Watch semantics + SKILL.md live-update paragraph must be updated.

**Resolution (2026-09-14):** Fixed as triaged. `GET /api/reference-layers` now stats every watched file per request and re-probes on mtime/presence change through the same reload fold (one shared code path for boot, watch debounce, retry, and request-time check). The request path yields to in-flight debounce/retry timers, so watch semantics are unchanged — the two ticket-02 mid-debounce tests pass unmodified and now double as regression tests. 5 new tests cover lost-rewrite, lost unlink/re-add, stat-only no-reread, and retry-window behavior. 64/64 vitest green. ADR-0003 amendment recorded.
