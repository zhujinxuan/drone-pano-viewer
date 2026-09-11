import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { vincentyDirect } from "./geodesy.ts";
import {
  OKABE_ITO,
  circlesFromPhotos,
  filterByCircleUnion,
  parseLayerSpecs,
  parseReferenceGeoJSON,
  type RefFeature,
  type RefLayerSpec,
} from "./reference-layers.ts";
import { panoReferenceLayers } from "../../vite.config.ts";
import type { PhotoEntry } from "./types.ts";

// Spec: .scratch/reference-layers/spec.md, ticket 01 (CLI flags + endpoint
// prefilter). Ground-truth positions come from vincentyDirect (GeodTest
// verified) — an independent oracle for the prefilter's equirectangular
// approximation, which is sub-meter at the 1 km ring (see reference-layers.ts).
// All in/out margins are ≥ 50 m, far above that error bound.

const LON = 125.1;
const LAT = 44.9;

/** Position `distM` meters from the base point on `bearingDeg` (Vincenty ground truth, ~cm). */
function at(bearingDeg: number, distM: number): [number, number] {
  const ll = vincentyDirect(LAT, LON, bearingDeg, distM);
  return [Number(ll.lon.toFixed(7)), Number(ll.lat.toFixed(7))];
}

/** Same geodesic offset from an arbitrary base — for multi-circle tests. */
function atFrom(base: { lon: number; lat: number }, bearingDeg: number, distM: number): [number, number] {
  const ll = vincentyDirect(base.lat, base.lon, bearingDeg, distM);
  return [Number(ll.lon.toFixed(7)), Number(ll.lat.toFixed(7))];
}

describe("parseLayerSpecs", () => {
  it("parses repeatable flags keeping order, assigning the Okabe-Ito palette by flag order", () => {
    const specs = parseLayerSpecs(["a=one.geojson", "b=two.geojson", "c=three.geojson"]);
    expect(specs).toEqual<RefLayerSpec[]>([
      { name: "a", path: "one.geojson", color: "#e69f00", labelProp: null },
      { name: "b", path: "two.geojson", color: "#56b4e9", labelProp: null },
      { name: "c", path: "three.geojson", color: "#009e73", labelProp: null },
    ]);
  });

  it("keeps an explicit #hex and labelProp (ticket smoke shape), in either segment order", () => {
    expect(parseLayerSpecs(["b=/abs/two.geojson,#e69f00,label=tid"])).toEqual<RefLayerSpec[]>([
      { name: "b", path: "/abs/two.geojson", color: "#e69f00", labelProp: "tid" },
    ]);
    expect(parseLayerSpecs(["b=/abs/two.geojson,label=tid,#e69f00"])).toEqual<RefLayerSpec[]>([
      { name: "b", path: "/abs/two.geojson", color: "#e69f00", labelProp: "tid" },
    ]);
  });

  it("normalizes explicit hex to lowercase and does not consume a palette slot", () => {
    const specs = parseLayerSpecs(["x=one.geojson,#FF8800", "y=two.geojson"]);
    expect(specs[0]?.color).toBe("#ff8800");
    // y is the first palette-less layer → first palette color, not the second
    expect(specs[1]?.color).toBe("#e69f00");
  });

  it("skips palette colors already taken by an explicit #hex", () => {
    const specs = parseLayerSpecs(["x=one.geojson,#E69F00", "y=two.geojson", "z=three.geojson"]);
    expect(specs[0]?.color).toBe("#e69f00");
    expect(specs[1]?.color).toBe("#56b4e9"); // orange taken → next palette color
    expect(specs[2]?.color).toBe("#009e73");
  });

  it("wraps the palette after eight palette-less layers", () => {
    const raws = Array.from({ length: 9 }, (_, i) => `l${i}=p.geojson`);
    const colors = parseLayerSpecs(raws).map((s) => s.color);
    expect(colors.slice(0, 8)).toEqual([...OKABE_ITO]);
    expect(colors[8]).toBe("#e69f00");
  });

  it("accepts an empty flag list (no layers configured)", () => {
    expect(parseLayerSpecs([])).toEqual([]);
  });

  it("fails fast with a usage message on malformed syntax", () => {
    const bad = [
      "",                               // empty value
      "one.geojson",                    // missing =
      "=one.geojson",                   // empty name
      "a=",                             // empty path
      "a=one.geojson,bad",              // unknown segment
      "a=one.geojson,#zzz",             // not a hex color
      "a=one.geojson,label=",           // empty label prop
      "a=one.geojson,#e69f00,#56b4e9",  // duplicate color
      "a=one.geojson,label=x,label=y",  // duplicate label
      "a=one.geojson,",                 // trailing comma
    ];
    for (const raw of bad) {
      expect(() => parseLayerSpecs([raw])).toThrow(/--layer expects <name>=<path\.geojson>/);
    }
    // one bad flag fails the whole run even after valid ones
    expect(() => parseLayerSpecs(["a=ok.geojson", "bad"])).toThrow(/--layer expects/);
  });
});

describe("parseReferenceGeoJSON", () => {
  const point = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [LON, LAT] },
    properties: { tid: "T7", zone: { level: 2, tags: ["a", "b"] }, note: null },
  };
  const line = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[125.1, 44.9], [125.11, 44.91]] },
    properties: {},
  };

  it("loads a FeatureCollection and passes surviving features through verbatim (same references)", () => {
    const { status, features } = parseReferenceGeoJSON({ type: "FeatureCollection", features: [point, line] });
    expect(status).toBe("ok");
    expect(features).toHaveLength(2);
    expect(features[0]).toBe(point); // never rewritten — unknown properties verbatim
    expect(features[1]).toBe(line);
  });

  it("drops structurally invalid features from a collection but keeps the rest", () => {
    const bad = [
      { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[1, 2]] }, properties: {} },
      { type: "Feature", geometry: null, properties: {} },
      { type: "Feature", properties: {} },
      { type: "Feature", geometry: { type: "Point", coordinates: "1,2" }, properties: {} },
      { type: "Feature", geometry: { type: "LineString", coordinates: [[1, 2]] }, properties: {} }, // 1-vertex line
      { type: "Point", coordinates: [1, 2] }, // bare geometry inside features[]
    ];
    const { status, features } = parseReferenceGeoJSON({ type: "FeatureCollection", features: [point, ...bad] });
    expect(status).toBe("ok");
    expect(features).toEqual([point]);
  });

  it("accepts a bare Feature by wrapping it into a one-element collection", () => {
    const { status, features } = parseReferenceGeoJSON(point);
    expect(status).toBe("ok");
    expect(features).toEqual([point]);
  });

  it("accepts a bare geometry, wrapping it as a Feature with empty properties", () => {
    const geometry = { type: "LineString", coordinates: [[125.1, 44.9], [125.11, 44.91]] };
    const { status, features } = parseReferenceGeoJSON(geometry);
    expect(status).toBe("ok");
    expect(features).toHaveLength(1);
    expect(features[0]?.geometry).toBe(geometry); // geometry object reused, not copied
    expect(features[0]?.properties).toEqual({});
  });

  it("accepts unclosed polygon rings (closure is a filter-time concern, not a load-time one)", () => {
    const triangle = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] },
      properties: {},
    };
    const { status, features } = parseReferenceGeoJSON({ type: "FeatureCollection", features: [triangle] });
    expect(status).toBe("ok");
    expect(features).toEqual([triangle]);
  });

  it("reports invalid for anything that is not recognizable GeoJSON, never throwing", () => {
    const garbage: unknown[] = [
      42,
      null,
      "FeatureCollection",
      [],
      {},
      { type: "FeatureCollection", features: "x" },
      { type: "Point", coordinates: "x" }, // bare geometry with bad coordinates
      { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[1, 2]] }, properties: {} },
      { hello: 1 },
    ];
    for (const input of garbage) {
      expect(parseReferenceGeoJSON(input)).toEqual({ status: "invalid", features: [] });
    }
  });
});

describe("circlesFromPhotos", () => {
  function photo(id: string, lon: number | null, lat: number | null): PhotoEntry {
    return { id, name: `${id}.jpg`, relPath: `${id}.jpg`, url: `/photos/${id}.jpg`, lon, lat };
  }

  it("yields one center per positioned pano and skips nogps entries", () => {
    const centers = circlesFromPhotos([
      photo("wzbjs1gm", LON, LAT),
      photo("nogps-1", null, null),
      photo("nogps-2", null, null),
    ]);
    expect(centers).toEqual([{ lon: LON, lat: LAT }]);
  });

  it("skips half-decoded entries (lat or lon alone is not a position)", () => {
    expect(circlesFromPhotos([photo("x", LON, null)])).toEqual([]);
  });

  it("returns [] for an empty photos list", () => {
    expect(circlesFromPhotos([])).toEqual([]);
  });
});

describe("filterByCircleUnion", () => {
  const CENTER = [{ lon: LON, lat: LAT }];

  function load(json: unknown): RefFeature[] {
    const { status, features } = parseReferenceGeoJSON(json);
    expect(status).toBe("ok");
    return features;
  }

  it("includes a point inside a circle and excludes one outside", () => {
    const inPt = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: at(90, 950) }, properties: {} },
    ] });
    const outPt = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: at(90, 1050) }, properties: {} },
    ] });
    const kept = filterByCircleUnion(inPt, CENTER);
    expect(kept).toEqual(inPt);
    expect(kept[0]).toBe(inPt[0]); // the feature itself passes through by reference
    expect(filterByCircleUnion(outPt, CENTER)).toEqual([]);
  });

  it("includes a line crossing the circle with both vertices outside (segment min-distance test)", () => {
    const crossing = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [at(0, 1500), at(180, 1500)] }, properties: {} },
    ] });
    expect(filterByCircleUnion(crossing, CENTER)).toEqual(crossing);

    // parallel chord whose closest approach is ~1200 m — vertices ~1697 m out, no crossing
    const chord = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [at(45, 1697), at(135, 1697)] }, properties: {} },
    ] });
    expect(filterByCircleUnion(chord, CENTER)).toEqual([]);
  });

  it("includes a polygon whose edge clips the circle while every vertex is outside", () => {
    const diamond = (d: number) =>
      load({ type: "FeatureCollection", features: [
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[at(0, d), at(90, d), at(180, d), at(270, d), at(0, d)]] }, properties: {} },
      ] });
    // vertices 1300 m out, edges pass at 1300·cos45° ≈ 919 m — edge-clip only
    expect(filterByCircleUnion(diamond(1300), CENTER)).toEqual(diamond(1300));
    // vertices 2000 m out, edges at ≈ 1414 m — fully outside
    expect(filterByCircleUnion(diamond(2000), CENTER)).toEqual([]);
  });

  it("tests the ring's closing edge — including when it is the only hit", () => {
    // v0 east 1500 m, v1 north 5000 m, v2 west 1500 m: edges v0→v1 and v1→v2
    // pass at ≈1437 m, only the closing edge v2→v0 crosses the center.
    const v0 = at(90, 1500);
    const v1 = at(0, 5000);
    const v2 = at(270, 1500);

    const closedRing = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[v0, v1, v2, v0]] }, properties: {} },
    ] });
    expect(filterByCircleUnion(closedRing, CENTER)).toEqual(closedRing);

    // same ring written unclosed (lenient): the wrap edge v2→v0 must still be tested
    const openRing = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[v0, v1, v2]] }, properties: {} },
    ] });
    expect(filterByCircleUnion(openRing, CENTER)).toEqual(openRing);

    // the same vertices as a LineString have no closing edge → excluded
    const asLine = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [v0, v1, v2] }, properties: {} },
    ] });
    expect(filterByCircleUnion(asLine, CENTER)).toEqual([]);
  });
  it("unions multiple circles: a point in neither circle's ring is excluded, one in any is kept", () => {
    const east3k = vincentyDirect(LAT, LON, 90, 3000);
    const centers = [{ lon: LON, lat: LAT }, { lon: east3k.lon, lat: east3k.lat }];

    const nearB = atFrom({ lon: east3k.lon, lat: east3k.lat }, 90, 800); // only in B's circle
    const midway = at(90, 1500); // 1500 m from both A and B — the union gap
    const nearA = at(270, 950);
    const features = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: nearB }, properties: { which: "nearB" } },
      { type: "Feature", geometry: { type: "Point", coordinates: midway }, properties: { which: "midway" } },
      { type: "Feature", geometry: { type: "Point", coordinates: nearA }, properties: { which: "nearA" } },
    ] });
    const kept = filterByCircleUnion(features, centers);
    expect(kept.map((f) => f.properties.which)).toEqual(["nearB", "nearA"]);
  });

  it("excludes everything when the photos list is empty (no circles)", () => {
    const features = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [LON, LAT] }, properties: {} },
    ] });
    expect(filterByCircleUnion(features, [])).toEqual([]);
  });

  it("includes features whole — never clipped — when only part is inside", () => {
    const straddling = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [at(90, 300), at(90, 5000)] }, properties: {} },
    ] });
    const kept = filterByCircleUnion(straddling, CENTER);
    expect(kept).toEqual(straddling);
    expect(kept[0]).toBe(straddling[0]); // same feature object — never copied, never clipped
    const geometry = kept[0]?.geometry;
    if (geometry?.type === "LineString") {
      expect(geometry.coordinates).toHaveLength(2);
    } else {
      throw new Error("expected a LineString");
    }
  });

  it("honors a custom radius", () => {
    const pt = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: at(90, 600) }, properties: {} },
    ] });
    expect(filterByCircleUnion(pt, CENTER, 500)).toEqual([]);
    expect(filterByCircleUnion(pt, CENTER, 700)).toEqual(pt);
  });
});

// ---------------------------------------------------------------------------
// GET /api/reference-layers — the vite middleware, exercised like
// annotations-endpoint.test.ts: configureServer registers a Connect handler
// invoked with minimal req/res mocks over real temp dirs (real fs, real scan).

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
}

type Handler = (req: MockReq, res: MockRes) => void;

function start(): Handler {
  let registered: Handler | undefined;
  const fake = {
    middlewares: {
      use(route: string, handler: Handler) {
        if (route === "/api/reference-layers") registered = handler;
      },
    },
  };
  const { configureServer } = panoReferenceLayers();
  // Plugin hooks are ObjectHook: a bare function or { handler, order? }.
  if (typeof configureServer === "function") configureServer(fake as unknown as ViteDevServer);
  else configureServer?.handler(fake as unknown as ViteDevServer);
  if (!registered) throw new Error("/api/reference-layers middleware not registered");
  return registered;
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
let handler: Handler;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-ref-"));
  delete process.env.PANO_REFERENCE_LAYERS;
  delete process.env.PANO_PHOTOS_DIR;
  handler = start();
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("GET /api/reference-layers", () => {
  it("answers { layers: [] } when PANO_REFERENCE_LAYERS is unset (plain `vite dev`)", () => {
    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(res.body)).toEqual({ layers: [] });
  });

  it("serves each layer whole-filtered by the 1 km union of the positioned panos", () => {
    const photos = path.join(dir, "photos");
    fs.mkdirSync(photos);
    // two positioned panos ~3 km apart; geohash cells are ~38×19 m, negligible vs 1 km
    fs.writeFileSync(path.join(photos, `${geohash8(LON, LAT)}.jpg`), "");
    const east = vincentyDirect(LAT, LON, 90, 3000);
    fs.writeFileSync(path.join(photos, `${geohash8(east.lon, east.lat)}.jpg`), "");
    fs.writeFileSync(path.join(photos, "nogps-1.jpg"), "");

    const nearA = { type: "Feature", geometry: { type: "Point", coordinates: [LON, LAT] }, properties: { tid: "T1" } };
    const farPt = { type: "Feature", geometry: { type: "Point", coordinates: at(0, 5000) }, properties: { tid: "T2" } };
    const crossing = { type: "Feature", geometry: { type: "LineString", coordinates: [at(0, 1500), at(180, 1500)] }, properties: { tid: "L1" } };
    const aFile = path.join(dir, "a.geojson");
    fs.writeFileSync(aFile, JSON.stringify({ type: "FeatureCollection", features: [nearA, farPt] }));
    const bFile = path.join(dir, "b.geojson");
    fs.writeFileSync(bFile, JSON.stringify({ type: "FeatureCollection", features: [crossing] }));

    process.env.PANO_PHOTOS_DIR = photos;
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "a", path: aFile, color: "#e69f00", labelProp: "tid" },
      { name: "b", path: bFile, color: "#0072b2", labelProp: null },
    ]);

    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    // expected body built independently from the inputs: only the near point
    // and the edge-crossing line survive the union prefilter, both whole.
    expect(JSON.parse(res.body)).toEqual({
      layers: [
        { name: "a", color: "#e69f00", labelProp: "tid", status: "ok", features: { type: "FeatureCollection", features: [nearA] } },
        { name: "b", color: "#0072b2", labelProp: null, status: "ok", features: { type: "FeatureCollection", features: [crossing] } },
      ],
    });
  });

  it("reports a missing file as status missing with empty features", () => {
    const photos = path.join(dir, "photos");
    fs.mkdirSync(photos);
    fs.writeFileSync(path.join(photos, `${geohash8(LON, LAT)}.jpg`), "");
    process.env.PANO_PHOTOS_DIR = photos;
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "gone", path: path.join(dir, "absent.geojson"), color: "#e69f00", labelProp: null },
    ]);
    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      layers: [{ name: "gone", color: "#e69f00", labelProp: null, status: "missing", features: { type: "FeatureCollection", features: [] } }],
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports a malformed file as status invalid with empty features and a warning", () => {
    const photos = path.join(dir, "photos");
    fs.mkdirSync(photos);
    fs.writeFileSync(path.join(photos, `${geohash8(LON, LAT)}.jpg`), "");
    const bad = path.join(dir, "bad.geojson");
    fs.writeFileSync(bad, "{ not json");
    process.env.PANO_PHOTOS_DIR = photos;
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "bad", path: bad, color: "#e69f00", labelProp: null },
    ]);
    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      layers: [{ name: "bad", color: "#e69f00", labelProp: null, status: "invalid", features: { type: "FeatureCollection", features: [] } }],
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it("builds no circles from a nogps-only photos dir, filtering every feature out", () => {
    const photos = path.join(dir, "photos");
    fs.mkdirSync(photos);
    fs.writeFileSync(path.join(photos, "nogps-1.jpg"), "");
    const lone = { type: "Feature", geometry: { type: "Point", coordinates: [LON, LAT] }, properties: {} };
    const f = path.join(dir, "a.geojson");
    fs.writeFileSync(f, JSON.stringify({ type: "FeatureCollection", features: [lone] }));
    process.env.PANO_PHOTOS_DIR = photos;
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([{ name: "a", path: f, color: "#e69f00", labelProp: null }]);
    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      layers: [{ name: "a", color: "#e69f00", labelProp: null, status: "ok", features: { type: "FeatureCollection", features: [] } }],
    });
  });

  it("degrades to { layers: [] } with a warning when the env JSON is corrupt", () => {
    process.env.PANO_REFERENCE_LAYERS = "{broken";
    const res = new MockRes();
    handler(new MockReq("GET"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ layers: [] });
    expect(console.warn).toHaveBeenCalled();
  });
});
