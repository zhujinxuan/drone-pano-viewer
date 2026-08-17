# ADR 0001: Single-process Vite viewer with middleware backend

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

Panos are inspected during wind-farm 踏勘 (site survey) workflows: an agent locates the relevant stitched photos, pulls them from DVC, and needs to show them to the user in a PTGui/720yun-style equirectangular viewer. The photos are 10–30 MB local JPGs that must not be uploaded anywhere (720yun is out), and PTGui is a commercial per-machine license. The tool runs on the developer's Windows machine (no WSL), launched by an agent, one user at a time.

## Decision

1. **App**: Vite + React + TypeScript SPA living in `app/` of this skill repo.
2. **Backend = Vite middleware, no separate server.** The CLI starts the dev server programmatically (`vite.createServer`) with a custom plugin contributing middlewares: `GET /api/photos` returns the manifest (recursive scan of the photos-dir, `lon`/`lat` decoded from geohash8 stems), and photo bytes are served under `/photos/<relPath>`. No Express, no second process.
3. **Renderer**: `photo-sphere-viewer` (+ compass plugin) for equirectangular display, with a live yaw/pitch/FOV overlay and a title banner.
4. **Metadata**: EXIF/XMP (DJI fields) parsed client-side with `exifr` — the server never parses images.
5. **CLI**: `pano view <file-or-dir> [--id] [--near] [--title]` and `pano list <dir> [--json]`; the opened pano's URL is printed to stdout.
6. **State**: none. Every invocation rescans the photos-dir; no database, no config file, no cache.
7. **v1 scope: viewer only — no map sidebar.** Finding the right pano is the invoking agent's job: it resolves place names to coordinates, decodes geohashes, and passes `--id`/`--near`. An in-app map would duplicate that work and drag in tile dependencies for a single-user local tool. A map is deferred to v2.

## Consequences

- One process and one `node_modules`; first use requires `npm install` in `app/`.
- The dev server doubles as the backend — fine for a local single-user tool, not a deployment shape.
- Positions come from filenames (geohash8 stems), so a photo renamed away from the convention loses its position; `nogps-*` files have none to begin with.
- The server never touches DVC (pre-pull rule), so it needs no project credentials and works unchanged on rclone mounts.
