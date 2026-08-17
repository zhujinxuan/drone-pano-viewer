# 01 — Playlist: multi-pano load + keyboard navigation

Status: resolved
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

## Answer

Implemented 2026-08-17 (two parallel slices, TDD seam on `src/lib/playlist.ts`):

- CLI `--playlist <file.json>`: strict parse + fail-fast id validation against the
  scan (dies listing unknown ids); `--id`/`--near` restricted to playlist entries
  when active; passes raw JSON to the server via `PANO_PLAYLIST` env.
- `/api/photos` is now an envelope `{ photos, playlist }`; playlist mode returns
  the ordered titled subset, rescan per request (new pulls appear, vanished ids
  surface as HTTP 500). `PhotoEntry.title?` added.
- UI: `?pos=N` (0-based) + `?id` fallback; `[`/`]`/`p`/`n` wrap-around switching;
  zoom level carried across switches (yaw/pitch reset); next photo preloaded via
  `Image`; NavStrip `‹ N/M ›` + next-title ghost (clickable); switch flash
  (1.2s fade); title precedence `?title` > playlist > id+EXIF datetime.
- Verification: 12/12 vitest, tsc clean, browser-verified on real Songyuan data
  (3-entry playlist incl. one 4:3 frame): switching, zoom carry-over (60→57.6
  persisted), flash text, ghost text, wrap-around, `?pos` replaceState.

## Review outcome (code-review, two axes)

- Standards: no documented standards in repo (smell baseline only) — 4 P3
  judgement calls, none blocking (dead eslint-disable, flash duration duplicated
  TS/CSS, title-precedence written twice, nullable sentinel in vite.config).
- Spec: coverage complete. Two P3 deviations accepted deliberately: title flash
  also fires on initial load (reads as a welcome card, kept); unknown `?id` in
  playlist mode shows a blocking error overlay (sanctioned in the implementation
  contract — loud failure beats silently opening the wrong pano).
