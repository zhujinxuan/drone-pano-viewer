import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { panoAnnotations } from "./vite.config.ts";

/**
 * Exercises the /api/annotations middleware directly: the plugin's
 * configureServer registers a Connect handler, which we invoke with minimal
 * req/res mocks over a real temp dir (the atomic write is real fs).
 */

class MockReq extends EventEmitter {
  constructor(readonly method: string) {
    super();
  }
}

class MockRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  end(chunk?: string | Buffer) {
    if (chunk !== undefined) this.body += chunk.toString();
  }
  destroy() {
    // connection torn down — nothing observable past this point
  }
}

type Handler = (req: MockReq, res: MockRes) => void;

/** Register the plugin's middleware against a fake dev server; return the /api/annotations handler. */
function start(): Handler {
  let registered: Handler | undefined;
  const fake = {
    middlewares: {
      use(route: string, handler: Handler) {
        if (route === "/api/annotations") registered = handler;
      },
    },
  };
  const { configureServer } = panoAnnotations();
  // Plugin hooks are ObjectHook: a bare function or { handler, order? }.
  if (typeof configureServer === "function") configureServer(fake as unknown as ViteDevServer);
  else configureServer?.handler(fake as unknown as ViteDevServer);
  if (!registered) throw new Error("/api/annotations middleware not registered");
  return registered;
}
function get(handler: Handler): MockRes {
  const res = new MockRes();
  handler(new MockReq("GET"), res);
  return res;
}

function post(handler: Handler, body: string): MockRes {
  const req = new MockReq("POST");
  const res = new MockRes();
  handler(req, res);
  req.emit("data", Buffer.from(body, "utf8"));
  req.emit("end");
  return res;
}

const EMPTY = { type: "FeatureCollection", version: 1, features: [] };

const COLLECTION = {
  type: "FeatureCollection",
  version: 1,
  features: [
    {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[125.1, 44.9], [125.11, 44.91]] },
      properties: {
        id: "ann-01J8KQ3M7V9W2X4Y5Z6A8B0C1D",
        kind: "line",
        label: "北侧山脊线",
        photo: "wzbjs1gm",
        photoTitle: "FS3 · 机位北側",
        created: "2026-08-23T10:42:11.000Z",
        updated: "2026-08-23T10:42:11.000Z",
        vertexErrM: [4, 5],
      },
    },
  ],
  // foreign top-level member — must survive the round-trip verbatim
  producer: "pano-viewer",
};

const ENV_KEYS = ["PANO_ANNOTATIONS", "PANO_PHOTOS_DIR"] as const;

let dir: string;
let file: string;
let handler: Handler;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-ann-"));
  file = path.join(dir, "annotations.geojson");
  process.env.PANO_ANNOTATIONS = file;
  delete process.env.PANO_PHOTOS_DIR;
  handler = start();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/annotations", () => {
  it("returns the empty v1 collection when the file is missing", () => {
    const res = get(handler);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(EMPTY);
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  it("round-trips a POSTed collection verbatim, foreign members intact", () => {
    const body = JSON.stringify(COLLECTION);
    expect(post(handler, body).statusCode).toBe(204);
    const res = get(handler);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(body);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("serves an empty collection with a console.warn for a corrupt file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(file, "{oops");
    const res = get(handler);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/annotations\.geojson/));
  });

  it("falls back to <PANO_PHOTOS_DIR>/annotations.geojson when PANO_ANNOTATIONS is unset", () => {
    delete process.env.PANO_ANNOTATIONS;
    process.env.PANO_PHOTOS_DIR = dir;
    const res = post(handler, JSON.stringify(COLLECTION));
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(dir, "annotations.geojson"))).toBe(true);
  });
});

describe("POST /api/annotations", () => {
  it("rejects a non-FeatureCollection object with 400", () => {
    const res = post(handler, JSON.stringify({ foo: 1 }));
    expect(res.statusCode).toBe(400);
    expect(() => JSON.parse(res.body)).not.toThrow(); // error body is JSON
    expect(fs.existsSync(file)).toBe(false); // nothing written
  });

  it("rejects invalid JSON with 400", () => {
    expect(post(handler, "not json").statusCode).toBe(400);
  });

  it("rejects a non-array features with 400", () => {
    const res = post(handler, JSON.stringify({ type: "FeatureCollection", features: {} }));
    expect(res.statusCode).toBe(400);
  });

  it("replaces a pre-existing target and leaves no .tmp behind (rename-over-existing on Windows)", () => {
    expect(post(handler, JSON.stringify(COLLECTION)).statusCode).toBe(204);
    const second = { ...COLLECTION, features: [] };
    const res = post(handler, JSON.stringify(second));
    expect(res.statusCode).toBe(204);
    expect(fs.readdirSync(dir)).toEqual(["annotations.geojson"]); // no .tmp residue
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(second);
  });

  it("creates missing parent directories", () => {
    process.env.PANO_ANNOTATIONS = path.join(dir, "nested", "deep", "annotations.geojson");
    const res = post(handler, JSON.stringify(COLLECTION));
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(process.env.PANO_ANNOTATIONS)).toBe(true);
  });

  it("rejects other methods with 405 + Allow header", () => {
    const res = new MockRes();
    handler(new MockReq("PUT"), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("GET, POST");
  });
});
