# 01 — Playlist: multi-pano load + keyboard navigation

Status: ready-for-agent
Type: task

## Requirement (user, 2026-08-17)

Load 10–20 photos with per-photo titles in one `pano view` call, so reviewing a
survey area doesn't need one agent call + wait per photo. Keyboard navigation
between panos; arrows/scroll are owned by the sphere view and must not be stolen.

## Settled design (grilled, user-confirmed)

- **CLI**: `pano view <photos-dir> --playlist playlist.json` where the playlist is
  JSON `[{ "id": "<geohash8>", "title": "<text>" }]` — ids resolve against the
  existing recursive dir scan. No `--playlist` = navigate the whole dir in sorted
  order. Playlist defines subset + order + titles.
- **Keys**: `[` = previous, `]` = next (aliases `p` / `n`). PSV owns arrows, +/-.
- **UI**: persistent bottom-center nav strip `‹ 3/20 ›` + next photo's title as
  ghost text; on switch, the new title flashes large center-screen, then settles
  into the top banner.
- **Transition**: reset yaw to default heading, keep FOV; background-preload the
  next photo so `]` is instant even at 10–30 MB per JPEG.

## Open implementation notes

- Playlist path is read by the CLI at startup; titles flow into the manifest
  (`/api/photos` gains an optional `title` per entry) — no second endpoint.
- URL gains playlist position (`?pos=N`) so refresh keeps place.
- Preload = fetch next photo's `/photos/<relPath>` into an `Image`/blob cache.
- Keep the no-playlist path identical to current behavior otherwise.

## Comments

- 2026-08-17 — Requirement raised mid-build; grilled R1 (CLI shape), R3 (keys),
  R4 (nav UI), R5 (transition). All four settled as above. Not yet implemented.
