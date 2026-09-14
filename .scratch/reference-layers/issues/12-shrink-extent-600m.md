# 12 — Shrink the reference-layer extent: prefilter 1 km → 600 m, cull 1100 m → 700 m

**Status:** done

**Filed by:** maintainer, user request 2026-09-14 ("change 1km radius to 600m, which makes the computation less burdenful").

## What to build

- `filterByCircleUnion` default radius 1000 → 600 (server prefilter, data extent).
- `CULL_RADIUS_M` 1100 → 700 (client per-pano cull), preserving the server+100 m margin pattern: the cull must never keep a feature the prefilter could have dropped, so the pair moves together.
- Docs: spec §endpoint + §Client behavior + non-goals, SKILL.md server contract + cull bullet, ADR-0003 amendment, stale module/test comments.

## Rationale and caveats

- The review loop reads near-field conflicts; 600 m still covers what a ~100 m-altitude pano shows with ground detail, and the smaller union shrinks the served payload (fewer far features) and the per-pano kept set.
- **Caveat (recorded, accepted):** whole-feature inclusion is unchanged — a dissolved super-region polygon is still served whole the moment any vertex/segment of it comes within 600 m of any pano. The radius change does NOT shrink the 68 k-vertex monster class; ticket 11's render decimation owns that cost.
- Cull margin: the client keeps features with any vertex within 700 m while the server serves whole features intersecting 600 m — the 100 m delta keeps the client strictly inside the served set (segment-clip cases the vertex-only cull can't see).

## Acceptance

- [x] Default radius 600 in `filterByCircleUnion`; `CULL_RADIUS_M` 700
- [x] Tests re-anchored around 600/700 (in/out, edge-clip, union-gap cases); full suite green
- [x] Live check: reporter's 5 layers serve smaller feature counts; avoid layers still present near panos
- [x] spec/SKILL/ADR-0003 updated
