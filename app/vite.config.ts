import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { LonLat } from "./src/lib/geohash.ts";
import { applyPlaylist, parsePlaylist } from "./src/lib/playlist.ts";
import {
  acceptLayerProbe,
  circlesFromPhotos,
  createLayerState,
  parseReferenceGeoJSON,
  type RefFileProbe,
  type RefLayerSpec,
  type RefLayerState,
  type RefLayerTransition,
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

/** Watch debounce and the parse-failure retry window (spec §Watch semantics). */
const WATCH_DEBOUNCE_MS = 300;
const RETRY_AFTER_MS = 300;

/** Served vertices past which an accepted load warns: producer-side
 * simplification is otherwise invisible to app users (ticket 09 item 4). */
const VERTEX_BUDGET = 200_000;

/**
 * Dev-server middleware + watcher exposing the read-only reference layers.
 * Layer specs arrive via `PANO_REFERENCE_LAYERS` (JSON array set by cli.ts:
 * [{ name, path, color, labelProp }]) — same flow as the other PANO_* vars.
 * The env and every layer file are read once at configureServer boot; from
 * then on the watcher — backed by a request-time mtime check — keeps that
 * cached state current.
 *
 *  - GET /api/reference-layers → { layers: [{ name, color, labelProp,
 *    status, dropped, vertices, features }] } served from a cached
 *    serialization: the body and its gzip bytes are computed once per
 *    accepted state change (boot load, watch reload, retry, mtime re-probe)
 *    and reused — never JSON.stringify + gzip per request. A client whose
 *    Accept-Encoding includes gzip gets the cached bytes with
 *    Content-Encoding: gzip, everyone else identity. But first each watched
 *    file is stat'd, and any mtime/presence change since its last probe
 *    reloads through the shared watch path (spec §Watch semantics): a lost
 *    watch event can't outlive one request. Files with a debounce/retry
 *    timer pending are left to the watcher. Each layer's features are
 *    whole-included by the union of 600 m circles around every positioned
 *    pano of the served dir — the full scan, not the playlist (a playlist is
 *    a review restriction, not a data extent). No clipping: features pass
 *    through verbatim. The union is recomputed on each watch reload, so
 *    newly pulled panos widen the prefilter on the next layer-file change.
 *    An accepted load over 200 000 served vertices warns once (layer name +
 *    simplify producer-side) — the cost is otherwise invisible to producers.
 *  - Watch (Vite's own watcher, no new deps): 300 ms debounce per file, then
 *    re-read + re-filter; any accepted state change pushes
 *    `reference-layers:changed` over ws (no payload — clients refetch). A
 *    parse failure retries once after 300 ms and otherwise keeps the
 *    last-good features with status "invalid" (mid-write protection). Delete
 *    → status "missing" + empty features. Any successful parse fully
 *    replaces, status "ok". Two layers may share one file; one file event
 *    reloads both.
 *  - status: "ok" | "missing" | "invalid". Never 500s — a broken layer
 *    degrades with a warning, like the annotations outbox.
 *  - No PANO_REFERENCE_LAYERS (plain `vite dev`) → { layers: [] }.
 */
export function panoReferenceLayers(): Plugin {
  return {
    name: "pano-reference-layers",
    configureServer(server) {
      const circles = (): LonLat[] => {
        const photosDir = process.env.PANO_PHOTOS_DIR;
        return photosDir ? circlesFromPhotos(scanPhotos(photosDir)) : [];
      };

      // Live state: one entry per layer (the endpoint's cache), plus which
      // layers read which file — the watcher folds its probes into these.
      const layers: RefLayerState[] = [];
      const byPath = new Map<string, number[]>();
      // Last-probed mtime per file, 0 = absent (spec §Watch semantics): the
      // request-time safety net compares a fresh stat against this stamp, so
      // a lost watch event cannot outlive one GET.
      const stamps = new Map<string, number>();

      // Response bytes cached with the state (ticket 13): the multi-MB
      // payload must not pay JSON.stringify + gzip on every request.
      // Undefined = stale; every accept() invalidates, the GET rebuilds.
      let response: { json: string; gzip: Buffer } | undefined;

      // Probe one layer file and fold the result into the live state. The
      // stamp is taken before the read: if the file changes in between, the
      // stamp is older than the cached content and the next check re-probes
      // once — never a stale cache hiding behind a fresh stamp.
      const accept = (index: number, file: string, union: readonly LonLat[]): RefLayerTransition => {
        const mtimeMs = statMtimeMs(file);
        const probe = probeFile(file);
        stamps.set(file, mtimeMs);
        const transition = acceptLayerProbe(layers[index]!, probe, union);
        layers[index] = transition.state;
        response = undefined; // state moved (or re-accepted) — the next GET re-serializes
        if (probe.read === "ok" && transition.state.payload.vertices > VERTEX_BUDGET) {
          console.warn(
            `pano: reference layer "${transition.state.payload.name}" serves ${transition.state.payload.vertices} vertices (> ${VERTEX_BUDGET}) — heavy on every client load; simplify producer-side (e.g. 2 m Douglas-Peucker)`,
          );
        }
        if (transition.invalid && probe.read === "error") {
          console.warn(
            `pano: reference layer "${transition.state.payload.name}" unreadable/corrupt — keeping last-known features (${probe.message})`,
          );
        }
        return transition;
      };

      // Boot: read the env once and load every layer synchronously, so the
      // endpoint serves a complete snapshot from the first request. The
      // machine's one retry runs eagerly here — no timers at boot.
      const raw = process.env.PANO_REFERENCE_LAYERS;
      if (raw) {
        let specs: unknown;
        try {
          specs = JSON.parse(raw);
        } catch (e) {
          console.warn(`pano: PANO_REFERENCE_LAYERS is not valid JSON — serving no layers (${(e as Error).message})`);
        }
        if (Array.isArray(specs)) {
          const union = specs.length > 0 ? circles() : [];
          for (const entry of specs) {
            const spec = entry as Partial<RefLayerSpec> | null;
            if (typeof spec?.name !== "string" || typeof spec?.path !== "string") {
              console.warn("pano: skipping malformed PANO_REFERENCE_LAYERS entry");
              continue;
            }
            layers.push(createLayerState(spec as RefLayerSpec));
            const index = layers.length - 1;
            const abs = path.resolve(spec.path);
            if (accept(index, abs, union).state.retryPending) accept(index, abs, union); // the eager boot retry
            const shared = byPath.get(abs);
            if (shared) shared.push(index);
            else byPath.set(abs, [index]);
          }
        }
      }

      // The one shared reload path (spec §Watch semantics) for debounced
      // watch events, their retries, and the endpoint's request-time check:
      // probe every layer reading the file, fold through acceptLayerProbe,
      // arm the single 300 ms retry on a first failure, push one ws event
      // per accepted change. The two timer maps also tell the endpoint's
      // request-time check that the watch path already owns a file.
      const retries = new Map<string, NodeJS.Timeout>();
      const debounces = new Map<string, NodeJS.Timeout>();
      const reload = (file: string) => {
        const indices = byPath.get(file);
        if (!indices) return;
        const union = circles();
        let changed = false;
        for (const index of indices) {
          const transition = accept(index, file, union);
          if (transition.state.retryPending && !retries.has(file)) {
            retries.set(
              file,
              setTimeout(() => {
                retries.delete(file);
                reload(file);
              }, RETRY_AFTER_MS),
            );
          }
          if (transition.changed) changed = true;
        }
        if (changed) server.ws.send("reference-layers:changed");
      };

      server.middlewares.use("/api/reference-layers", (req, res) => {
        // Request-time mtime safety net: stat every watched file and reload
        // any whose mtime/presence moved since its last probe — the bound on
        // a lost watch event (one request). One stat per file per request.
        // A pending debounce/retry timer means the watch path already owns
        // the file; the check yields, so request traffic can neither jump
        // the 300 ms debounce nor cut a retry window short into an early
        // terminal "invalid".
        for (const file of byPath.keys()) {
          if (debounces.has(file) || retries.has(file)) continue;
          if (statMtimeMs(file) !== (stamps.get(file) ?? 0)) reload(file);
        }
        if (!response) {
          const json = JSON.stringify({ layers: layers.map((layer) => layer.payload) });
          response = { json, gzip: zlib.gzipSync(json) };
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        // Accept-Encoding is a comma list ("gzip, deflate, br") — a plain
        // substring test matches every real browser and q-value-free client
        // while leaving plain curl identity.
        if (String(req.headers["accept-encoding"] ?? "").includes("gzip")) {
          res.setHeader("Content-Encoding", "gzip");
          res.end(response.gzip);
        } else {
          res.end(response.json);
        }
      });

      // Watch wiring: one debounce timer per file (in `debounces` above); a
      // debounced event goes through the shared reload. The machine defers a
      // first parse failure by flipping retryPending, which schedules its
      // single 300 ms retry there.
      if (byPath.size > 0) {
        for (const abs of byPath.keys()) server.watcher.add(abs);

        const onWatchEvent = (file: string) => {
          if (!byPath.has(file)) return; // Vite's watcher also emits project files
          clearTimeout(debounces.get(file));
          debounces.set(
            file,
            setTimeout(() => {
              debounces.delete(file);
              reload(file);
            }, WATCH_DEBOUNCE_MS),
          );
        };
        server.watcher.on("add", onWatchEvent);
        server.watcher.on("change", onWatchEvent);
        server.watcher.on("unlink", onWatchEvent);
      }
    },
  };
}

/** One read attempt of a layer file: parsed features, absent, or bad. */
function probeFile(file: string): RefFileProbe {
  try {
    const loaded = parseReferenceGeoJSON(JSON.parse(fs.readFileSync(file, "utf8")));
    return loaded.status === "ok"
      ? { read: "ok", features: loaded.features, dropped: loaded.dropped }
      : { read: "error", message: "not recognizable GeoJSON" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "ENOENT" ? { read: "missing" } : { read: "error", message: err.message };
  }
}

/** Layer-file mtime in ms, 0 when absent — a presence change is a change. */
function statMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export default defineConfig({
  plugins: [react(), panoPhotos(), panoAnnotations(), panoReferenceLayers()],
});
