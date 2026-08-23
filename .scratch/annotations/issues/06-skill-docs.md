# 06 — Docs: SKILL.md annotation contract (UI + consumer)

Status: done
Blocked by: —

SKILL.md is the single source of truth for the CLI/UI contract (repo rule: every new UI must be synced into it). Read `.scratch/annotations/spec.md` (the settled design) and the current `SKILL.md` (match its structure and tone — terse, contract-style).

## Target

`SKILL.md` only.

## Change

Add an **Annotations** section covering, in this order:

1. **What it is**: in-pano capture of POI points, lines, polygons; persisted live to `<photos-dir>/annotations.geojson` (override `pano view --annotations <path>`).
2. **UI contract** (mirror the spec): top-left rail with 3 mode buttons; add vertex = Space at reticle or single click; Enter finish (line ≥2, polygon ≥3 auto-close); u/Backspace undo vertex; Esc cancel/exit; photo switch discards in-progress; above-horizon vertex rejected (red flash); list panel (`e`) with click-to-select + camera swing, inline label edit, instant delete with 5s undo toast; disabled on `nogps-*`/no-altitude panos.
3. **File contract**: single FeatureCollection, `version: 1`, the full properties schema from the spec (`id` = `ann-<ULID>`, `kind`, `label`, `photo`, `photoTitle`, `created`, `updated`, `cam`, `vertexErrM`), 2D 7-decimal coordinates, closed polygon rings, load-then-rewrite + atomic save, lenient load preserving unknown members, features never pruned.
4. **Consumer contract** (the agent-facing part — this is the section future agents read): file is a durable outbox; **read-only for consumers, viewer is the sole writer**; upsert downstream by `properties.id`, skip unchanged `updated`; deletion = feature vanishes → prune downstream rows by missing id; the consumption receipt (e.g. `ann_id` column in a GPKG) lives in the destination store; "layer" = filter by `properties.photo` (stable) or `properties.photoTitle`; atomic rename means no torn reads; typical batch flow = user labels a playlist of 10–20 photos, agent ingests that dir's file afterward.
5. One-line pointer to `docs/adr/0002-annotations-outbox.md`.

Also add `--annotations` to the CLI synopsis in the Workflow section.

## Acceptance

Section consistent with spec.md (same key names, same semantics, no invention). No code changes. Do NOT run tests/linters.

## Result

Added `## Annotations` to SKILL.md (what/UI/file/consumer contracts + ADR pointer, key-for-key with spec.md) and `[--annotations <path>]` to the Workflow CLI synopsis; no code touched.
