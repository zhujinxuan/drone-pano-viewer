# 17 — Heavy layers default to hidden (vertex-budget visibility seeding)

**Status:** done (2026-09-16)

**Filed by:** maintainer, user request 2026-09-16: "we can detect what layers make the rendering slow — have a default feature that turns off the visibility of these complex slow layers by default."

## Design

- Server payload per layer already gains `vertices` (served vertex count, ticket 13) — the detection metric. It is exactly the number that drives build cost, cull cost, and draw size.
- Client seeds visibility for a newly-seen layer name as `vertices <= SLOW_LAYER_VERTEX_BUDGET` (50 000). Over-budget layers load but start **unchecked** in the toolbar — the user enables them deliberately. The reporter's set: avoid-soft (68 k) and the old avoid-hard (82 k) hide by default; turbines (187), pads, manual layers stay visible.
- The toolbar row of an over-budget layer carries a text tooltip on hover: "heavy layer — N vertices, hidden by default" (⚠ keeps its status/dropped meaning; house rule: no new emoji glyphs).
- Only the **seed** changes: a layer the user has already toggled this session keeps the user's choice (the re-seed-on-refetch logic already preserves existing keys); `localStorage` persistence is out of scope (session-only, matches today's visibility state).

## Acceptance

- [x] Seeding unit test: over-budget → hidden, under-budget → visible, user-toggled names preserved across refetch (`seedVisibility` in reference-build.ts)
- [x] Toolbar tooltip on over-budget rows ("heavy layer — N vertices, hidden by default")
- [x] Scoped vitest + typecheck green; SKILL.md toolbar bullet + spec.md §Client behavior updated

## Results (2026-09-16)

Real-data smoke on the reporter set: avoid-hard (67 760 vertices > 50 000 budget) seeds hidden with the tooltip; primary/backup/candidates/avoid-soft (≤ 13 172) seed visible. The user-enabled toggle survives refetch reseeds (unit test).
