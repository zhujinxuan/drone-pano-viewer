# 18 — Feature layer-name banners (hidable per-feature title on polygons/lines)

**Status:** wontfix (2026-09-16) — user withdrew: click-inspect on a feature's boundary already surfaces the layer name in the readout, making banners unnecessary.

**Filed by:** maintainer, user request 2026-09-16: "for reference layers on the viewer map, we can have a hidable title (small banner) on the projected polygon that I know what reference layer this polygon belongs to."

## Context

Point features already get a DOM label next to their sprite (spec §Client behavior); polygons and lines render as geometry only — the layer name is recoverable solely via click-inspect. When several polygon/line layers overlap (松原核查: primary/backup/candidates pads + avoid-soft/avoid-hard unions + manual-* lines), color alone does not tell you which layer a given polygon belongs to.

## Design (grilling 2026-09-16, user-confirmed)

- **Banner text = layer name only** (the `--layer <name>=...` flag value). Feature properties stay in the click-inspect readout; label-prop precedence does NOT apply here (that is point-marker behavior).
- **Scope: polygons + lines.** Points are already labeled. Lines (powerline/pipeline manual layers) have the same which-layer ambiguity.
- **Density: every visible feature gets its own banner.** "Visible" = passes the existing per-pano 700 m cull and belongs to a checked layer. Dissolved-union layers flattened into many parts (ticket 07) will show many banners — accepted trade-off, the user picked this over one-banner-per-layer.
- **Hide: one global toggle, default ON.** UI surface: a "banners" toggle in the LayerToolbar header area (plus hotkey `t`). Per-layer visibility checkboxes already kill a layer wholesale including its banners; per-layer banner toggles rejected as excess UI. Session-only state, matching ticket 17's visibility precedent (no localStorage).

## Placement (maintainer judgment call, veto welcome)

- Banner anchor is a ground position projected per frame through the existing point-label DOM projection path — same attach/update/dispose discipline, no new render seam.
- Polygon anchor: vertex-average of the exterior ring (cheap, deterministic). Known artifact: for concave rings or ring-with-holes the anchor may sit in a hole/outside the fill — accepted, the banner is an identification aid, not a geometry claim.
- Line anchor: the polyline's midpoint vertex (`vertices[floor(n/2)]`).
- Anchors computed once per feature and cached by feature identity (same WeakMap pattern as ticket 14's LOD cache); recomputed only on layer reload.

## Acceptance

- [ ] Every rendered polygon/line feature shows a small banner with its layer name at the anchor, styled consistently with existing point labels (DOM overlay, screen-facing, layer-colored accent)
- [ ] Banners track the projection while dragging/zooming; hidden when the feature is culled or its layer is unchecked
- [ ] Global toggle (toolbar + `t` hotkey) hides/shows all banners; default on; session-only
- [ ] Pure seam for anchor computation under unit test (convex ring, ring with hole, 2-vertex line, degenerate single-vertex ring)
- [ ] Scoped vitest + typecheck green; SKILL.md (UI contract) + spec.md §Client behavior updated; ADR-0003 amendment if any decision deviates from the above

## Comments
