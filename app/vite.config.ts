import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { LonLat } from "./src/lib/geohash.ts";
import { applyPlaylist, parsePlaylist } from "./src/lib/playlist.ts";
import {
  circlesFromPhotos,
  filterByCircleUnion,
  parseReferenceGeoJSON,
  type RefFeature,
  type RefLayerPayload,
  type RefLayerSpec,
} from "./src/lib/reference-layers.ts";
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

const EMPTY_ANNOTATIONS = JSON.stringify({
  type: "FeatureCollection",
  version: 1,
  features: [],
});

/**
 * Dev-server middleware exposing the annotations GeoJSON outbox.
 * The file path arrives via `PANO_ANNOTATIONS` (set by cli.ts) and falls back
 * to `<PANO_PHOTOS_DIR>/annotations.geojson`. The viewer is the file's single
 * writer; downstream consumers (QGIS/GPKG pipelines) read it directly.
 *
 *  - GET /api/annotations → 200 file JSON; missing file → 200 empty v1
 *    collection; unreadable/corrupt file → 200 empty collection + console.warn
 *    (never 500 the viewer for a bad outbox)
 *  - POST /api/annotations → body = full FeatureCollection; minimal shape
 *    validation; atomic write (`.tmp` + rename, mkdir -p parent); 204 on
 *    success, 400 on invalid JSON / wrong shape
 */
export function panoAnnotations(): Plugin {
  return {
    name: "pano-annotations",
    configureServer(server) {
      server.middlewares.use("/api/annotations", (req, res) => {
        const file =
          process.env.PANO_ANNOTATIONS ??
          (process.env.PANO_PHOTOS_DIR && path.join(process.env.PANO_PHOTOS_DIR, "annotations.geojson"));
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (!file) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              error: "PANO_ANNOTATIONS not set — start the viewer via `npm run pano -- view <dir>`",
            }),
          );
          return;
        }
        if (req.method === "GET") {
          try {
            const raw = fs.readFileSync(file, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("not a JSON object");
            }
            res.end(raw); // verbatim — foreign members survive the round-trip
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn(
                `pano: annotations file ${file} unreadable/corrupt — serving an empty collection (${(e as Error).message})`,
              );
            }
            res.end(EMPTY_ANNOTATIONS);
          }
          return;
        }
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("error", () => res.destroy());
          req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid JSON body" }));
              return;
            }
            const shape = parsed as { type?: unknown; features?: unknown };
            if (shape?.type !== "FeatureCollection" || !Array.isArray(shape.features)) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({ error: 'body must be { "type": "FeatureCollection", "features": [...] }' }),
              );
              return;
            }
            const tmp = `${file}.tmp`;
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(tmp, body); // validated verbatim — no re-serialization drift
              fs.renameSync(tmp, file); // rename-over-existing works on Windows too
            } catch (e) {
              try {
                fs.unlinkSync(tmp);
              } catch {
                // best-effort cleanup; the rename/write already failed
              }
              res.statusCode = 500;
              res.end(JSON.stringify({ error: `cannot write ${file} — ${(e as Error).message}` }));
              return;
            }
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.end(JSON.stringify({ error: "method not allowed" }));
      });
    },
  };
}

/**
 * Dev-server middleware exposing the read-only reference layers.
 * Layer specs arrive via `PANO_REFERENCE_LAYERS` (JSON array set by cli.ts:
 * [{ name, path, color, labelProp }]) — same flow as the other PANO_* vars.
 *
 *  - GET /api/reference-layers → { layers: [{ name, color, labelProp,
 *    status, features }] }. Each file is read per request (file watching and
 *    its status transitions land in ticket 02) and its features are
 *    whole-included by the union of 1 km circles around every positioned pano
 *    of the served dir — the full scan, not the playlist (a playlist is a
 *    review restriction, not a data extent). No clipping: features pass
 *    through verbatim.
 *  - status: "ok" (parsed) | "missing" (file absent) | "invalid" (unreadable
 *    or not recognizable GeoJSON). Never 500s — a broken layer degrades to an
 *    empty FeatureCollection with a warning, like the annotations outbox.
 *  - No PANO_REFERENCE_LAYERS (plain `vite dev`) → { layers: [] }.
 */
export function panoReferenceLayers(): Plugin {
  return {
    name: "pano-reference-layers",
    configureServer(server) {
      server.middlewares.use("/api/reference-layers", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const raw = process.env.PANO_REFERENCE_LAYERS;
        if (!raw) {
          res.end(JSON.stringify({ layers: [] }));
          return;
        }
        let specs: unknown;
        try {
          specs = JSON.parse(raw);
        } catch (e) {
          console.warn(`pano: PANO_REFERENCE_LAYERS is not valid JSON — serving no layers (${(e as Error).message})`);
          res.end(JSON.stringify({ layers: [] }));
          return;
        }
        if (!Array.isArray(specs)) {
          console.warn("pano: PANO_REFERENCE_LAYERS is not a JSON array — serving no layers");
          res.end(JSON.stringify({ layers: [] }));
          return;
        }
        // Circle union over the full dir scan, rescanned per request so newly
        // pulled DVC panos widen the prefilter on refresh (like /api/photos).
        const photosDir = process.env.PANO_PHOTOS_DIR;
        const circles: LonLat[] = photosDir ? circlesFromPhotos(scanPhotos(photosDir)) : [];
        const layers: RefLayerPayload[] = [];
        for (const entry of specs) {
          const spec = entry as Partial<RefLayerSpec> | null;
          if (typeof spec?.name !== "string" || typeof spec?.path !== "string") {
            console.warn("pano: skipping malformed PANO_REFERENCE_LAYERS entry");
            continue;
          }
          layers.push(loadLayer(spec as RefLayerSpec, circles));
        }
        res.end(JSON.stringify({ layers }));
      });
    },
  };
}

function loadLayer(spec: RefLayerSpec, circles: readonly LonLat[]): RefLayerPayload {
  let status: RefLayerPayload["status"];
  let features: RefFeature[] = [];
  try {
    const loaded = parseReferenceGeoJSON(JSON.parse(fs.readFileSync(spec.path, "utf8")));
    status = loaded.status;
    features = loaded.features;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    status = err.code === "ENOENT" ? "missing" : "invalid";
    if (status === "invalid") {
      console.warn(`pano: reference layer "${spec.name}" unreadable/corrupt — serving empty (${err.message})`);
    }
  }
  return {
    name: spec.name,
    color: spec.color,
    labelProp: spec.labelProp ?? null,
    status,
    features: { type: "FeatureCollection", features: filterByCircleUnion(features, circles) },
  };
}

export default defineConfig({
  plugins: [react(), panoPhotos(), panoAnnotations(), panoReferenceLayers()],
});
