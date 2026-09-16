import http from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { panoReferenceLayers } from "./vite.config.ts";

/**
 * Ticket 13 — cached gzip serving + the vertex-budget warning, over real
 * HTTP. The lib tests drive the middleware through mock req/res; gzip can
 * only be proven on the wire (fetch auto-decompresses and would hide the
 * encoding), so the captured Connect handler is mounted on a real
 * node:http server on an ephemeral port and driven with raw requests.
 * Real fs, real 300 ms debounces (the fake Vite watcher is driven by hand).
 */

const LON = 125.1;
const LAT = 44.9;

/** Captures what the plugin registers on Vite's watcher and ws push channel. */
class FakeWatcher {
  readonly added: string[] = [];
  private readonly listeners = new Map<string, Array<(file: string) => void>>();
  add(file: string) {
    this.added.push(file);
  }
  on(event: string, listener: (file: string) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: "add" | "change" | "unlink", file: string) {
    for (const listener of this.listeners.get(event) ?? []) listener(file);
  }
}

class FakeWs {
  readonly sent: string[] = [];
  send(event: string) {
    this.sent.push(event);
  }
}

/** Register the plugin's middleware against a fake dev server; return the /api/reference-layers handler. */
function captureHandler(): { handler: Handler; watcher: FakeWatcher; ws: FakeWs } {
  let registered: Handler | undefined;
  const fake = {
    middlewares: {
      use(route: string, handler: Handler) {
        if (route === "/api/reference-layers") registered = handler;
      },
    },
    watcher: new FakeWatcher(),
    ws: new FakeWs(),
  };
  const { configureServer } = panoReferenceLayers();
  // Plugin hooks are ObjectHook: a bare function or { handler, order? }.
  if (typeof configureServer === "function") configureServer(fake as unknown as ViteDevServer);
  else configureServer?.handler(fake as unknown as ViteDevServer);
  if (!registered) throw new Error("/api/reference-layers middleware not registered");
  return { handler: registered, watcher: fake.watcher, ws: fake.ws };
}

const GH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash encoder (test scaffolding, independent of scan.ts's decoder). */
function geohash8(lon: number, lat: number): string {
  let idx = 0;
  let bit = 0;
  let even = true;
  let hash = "";
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  while (hash.length < 8) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        idx = idx * 2 + 1;
        lonMin = mid;
      } else {
        idx = idx * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += GH_BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

const ENV_KEYS = ["PANO_REFERENCE_LAYERS", "PANO_PHOTOS_DIR"] as const;

let dir: string;
let savedEnv: Record<string, string | undefined>;
let servers: http.Server[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-ref-http-"));
  delete process.env.PANO_REFERENCE_LAYERS;
  delete process.env.PANO_PHOTOS_DIR;
  // installed before any boot(): the boot load may warn inside configureServer
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
  servers = [];
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const nearPt = { type: "Feature", geometry: { type: "Point", coordinates: [LON, LAT] }, properties: { tid: "T1" } };
const nearPtB = { type: "Feature", geometry: { type: "Point", coordinates: [LON + 0.0005, LAT] }, properties: { tid: "T3" } };

/** 30 near points (~40 m east at most) — enough payload for gzip to win visibly. */
const manyPts = Array.from({ length: 30 }, (_, i) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [LON + i * 1e-4, LAT] },
  properties: { tid: `T${i}` },
}));

function writeLayer(file: string, features: unknown[]) {
  fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));
}

// The mtime safety net keys on mtimeMs, and the OS may stamp two quick test
// writes identically (Windows timestamp ticks) — simulated producer
// rewrites set a strictly advancing mtime so no test depends on that
// granularity.
let mtimeTick = 0;
const bumpMtime = (file: string) => {
  const t = new Date(Date.now() + ++mtimeTick * 10);
  fs.utimesSync(file, t, t);
};

/**
 * Write each sheet's file (unless absent-at-boot), set the env, boot the
 * plugin, and mount the captured handler on a real http server. Returns the
 * endpoint URL plus the fake watcher and each layer's file path.
 */
async function boot(sheets: Array<{ name: string; features?: unknown[] }>) {
  const photos = path.join(dir, "photos");
  fs.mkdirSync(photos);
  fs.writeFileSync(path.join(photos, `${geohash8(LON, LAT)}.jpg`), "");
  process.env.PANO_PHOTOS_DIR = photos;
  const fileOf = (name: string) => path.join(dir, `${name}.geojson`);
  process.env.PANO_REFERENCE_LAYERS = JSON.stringify(
    sheets.map((s) => ({ name: s.name, path: fileOf(s.name), color: "#e69f00", labelProp: null })),
  );
  for (const s of sheets) if (s.features) writeLayer(fileOf(s.name), s.features);
  const { handler, watcher, ws } = captureHandler();
  const server = http.createServer((req, res) => handler(req, res));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reference-layers`,
    watcher,
    ws,
    fileOf,
  };
}

/** One raw HTTP GET — not fetch: fetch transparently decompresses and would hide the gzip framing. */
function rawGet(url: string, acceptEncoding?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const done = Promise.withResolvers<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>();
  const req = http.request(url, { headers: acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding } }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => done.resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on("error", done.reject);
  req.end();
  return done.promise;
}

describe("GET /api/reference-layers — cached gzip serving (ticket 13)", () => {
  it("serves identity without Accept-Encoding; a gzip request inflates to byte-identical JSON", async () => {
    const { url } = await boot([{ name: "a", features: manyPts }]);
    const identity = await rawGet(url);
    expect(identity.status).toBe(200);
    expect(identity.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(identity.headers["content-encoding"]).toBeUndefined();
    const body = JSON.parse(identity.body.toString("utf8"));
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0]).toMatchObject({ name: "a", status: "ok", dropped: 0, vertices: 30 });

    const gzipped = await rawGet(url, "gzip, deflate, br");
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(gzipped.body).equals(identity.body)).toBe(true); // both encodings, one cached body
    expect(gzipped.body.length).toBeLessThan(identity.body.length); // coordinate JSON compresses
  });

  it("compresses once per accepted change — repeat GETs, either encoding, reuse the cache", async () => {
    const gzipSync = vi.spyOn(zlib, "gzipSync");
    const { url } = await boot([{ name: "a", features: [nearPt] }]);
    expect(gzipSync).not.toHaveBeenCalled(); // lazy: boot alone serializes nothing
    await rawGet(url);
    await rawGet(url, "gzip");
    await rawGet(url, "gzip");
    await rawGet(url);
    expect(gzipSync).toHaveBeenCalledTimes(1); // one cold build, then cached
  });

  it("invalidates on a watched rewrite: past the 300 ms debounce the next GET serves the new bytes", async () => {
    const { url, watcher, fileOf } = await boot([{ name: "a", features: [nearPt] }]);
    const before = await rawGet(url, "gzip");
    writeLayer(fileOf("a"), [nearPt, nearPtB]);
    watcher.emit("change", fileOf("a"));
    // A real 300 ms debounce on the real event loop must run before the
    // reload lands — fake timers would stall the real socket I/O this test
    // rides on (they fake setImmediate, which net write-backs go through)
    // — so poll the endpoint until the reload is observable, bounded, with
    // the GETs during the window doubling as proof they serve stale cache
    // (the watch path owns the file while the debounce is pending).
    const deadline = Date.now() + 5000;
    let after = before;
    while (after.body.equals(before.body) && Date.now() < deadline) {
      await sleep(25);
      after = await rawGet(url, "gzip");
    }
    expect(after.body.equals(before.body)).toBe(false); // fresh gzip, not the stale cache
    expect(JSON.parse(zlib.gunzipSync(after.body).toString("utf8")).layers[0].vertices).toBe(2);
  });

  it("invalidates on the request-time mtime re-probe when the watch event was lost", async () => {
    const { url, fileOf } = await boot([{ name: "a", features: [nearPt] }]);
    const before = await rawGet(url, "gzip"); // warm the cache
    writeLayer(fileOf("a"), [nearPt, nearPtB]);
    bumpMtime(fileOf("a"));
    const after = await rawGet(url, "gzip");
    expect(after.body.equals(before.body)).toBe(false);
    expect(JSON.parse(zlib.gunzipSync(after.body).toString("utf8")).layers[0].vertices).toBe(2);
  });
});

describe("vertex-budget warning (ticket 09 item 4)", () => {
  /** 200 001-vertex LineString at the pano — one over budget, still prefilter-included. */
  const heavy = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: Array.from({ length: 200_001 }, () => [LON, LAT]) },
    properties: {},
  };

  it("warns once per accepted load over 200 000 vertices, naming the layer and suggesting simplification", async () => {
    const { url, fileOf } = await boot([{ name: "heavy", features: [heavy] }]);
    const warns = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(warns()).toHaveLength(1); // the boot load — once
    expect(warns()[0]).toContain("heavy");
    expect(warns()[0]).toMatch(/simplif/i);
    await rawGet(url);
    await rawGet(url, "gzip");
    expect(warns()).toHaveLength(1); // per accepted load, not per request
    writeLayer(fileOf("heavy"), [heavy]);
    bumpMtime(fileOf("heavy"));
    await rawGet(url); // the mtime re-probe accepts the rewrite — a new load
    expect(warns()).toHaveLength(2);
  });

  it("stays silent for a layer under the budget", async () => {
    const { url } = await boot([{ name: "small", features: [nearPt, nearPtB] }]);
    await rawGet(url);
    await rawGet(url, "gzip");
    expect(console.warn).not.toHaveBeenCalled();
  });
});
