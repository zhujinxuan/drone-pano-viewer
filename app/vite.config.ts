import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { applyPlaylist, parsePlaylist } from "./src/lib/playlist.ts";
import { scanPhotos } from "./src/lib/scan.ts";
import type { PhotosManifest } from "./src/lib/types.ts";

/**
 * Dev-server middlewares exposing the pano photos dir.
 * The dir arrives via `PANO_PHOTOS_DIR` and, optionally, the playlist JSON via
 * `PANO_PLAYLIST` (both set by cli.ts before createServer).
 *
 *  - GET /api/photos    → JSON envelope { photos, playlist }
 *                         photos = [{ id, name, relPath, url, lon, lat, title? }]
 *                         (rescanned per request, so newly pulled DVC files appear
 *                         on refresh; the playlist is re-applied on top each time)
 *  - GET /photos/<rel>  → photo bytes, 404 for missing/unpulled files
 */
function panoPhotos(): Plugin {
  return {
    name: "pano-photos",
    configureServer(server) {
      server.middlewares.use("/api/photos", (_req, res) => {
        const dir = process.env.PANO_PHOTOS_DIR;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (!dir) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              error: "PANO_PHOTOS_DIR not set — start the viewer via `npm run pano -- view <dir>`",
            }),
          );
          return;
        }
        // Per-request: newly pulled files appear on refresh, and a playlist id
        // that went missing (file removed) surfaces as a 500 instead of a silent gap.
        let manifest: PhotosManifest | null;
        try {
          const photos = scanPhotos(dir);
          const raw = process.env.PANO_PLAYLIST;
          manifest = raw
            ? { photos: applyPlaylist(photos, parsePlaylist(raw)), playlist: true }
            : { photos, playlist: false };
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (e as Error).message }));
          manifest = null;
        }
        if (manifest) res.end(JSON.stringify(manifest));
      });

      server.middlewares.use("/photos", (req, res) => {
        const dir = process.env.PANO_PHOTOS_DIR;
        if (!dir || !req.url) {
          res.statusCode = 500;
          res.end("PANO_PHOTOS_DIR not set");
          return;
        }
        const root = path.resolve(dir);
        // req.url is the path after the /photos mount point, percent-encoded per segment.
        const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
        const abs = path.resolve(root, rel);
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        let size: number;
        try {
          const st = fs.statSync(abs); // throws for broken symlinks / missing files
          if (!st.isFile()) throw new Error("not a file");
          size = st.size;
        } catch {
          res.statusCode = 404;
          res.end("not found (DVC object not pulled?)");
          return;
        }
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Content-Length", size);
        res.setHeader("Cache-Control", "public, max-age=3600");
        const stream = fs.createReadStream(abs);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), panoPhotos()],
});
