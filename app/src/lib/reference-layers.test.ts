import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { vincentyDirect } from "./geodesy.ts";
import {
  OKABE_ITO,
  acceptLayerProbe,
  circlesFromPhotos,
  createLayerState,
  filterByCircleUnion,
  parseLayerSpecs,
  parseReferenceGeoJSON,
  type RefFeature,
  type RefLayerPayload,
  type RefLayerSpec,
  type RefLayerState,
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
      { type: "Feature", geometry: null, properties: {} },
      { type: "Feature", properties: {} },
      { type: "Feature", geometry: { type: "Point", coordinates: "1,2" }, properties: {} },
      { type: "Feature", geometry: { type: "LineString", coordinates: [[1, 2]] }, properties: {} }, // 1-vertex line
      { type: "Point", coordinates: [1, 2] }, // bare geometry inside features[]
    ];
    const { status, features, dropped } = parseReferenceGeoJSON({ type: "FeatureCollection", features: [point, ...bad] });
    expect(status).toBe("ok");
    expect(features).toEqual([point]);
    expect(dropped).toBe(bad.length); // one count per member that produced zero valid features
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

  it("flattens a MultiPolygon into one Polygon feature per polygon, sharing the parent's properties", () => {
    const polyA = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
    const polyB = [
      [[2, 2], [3, 2], [3, 3], [2, 2]],
      [[2.4, 2.4], [2.6, 2.4], [2.6, 2.6], [2.4, 2.4]], // hole rides along — rings kept whole
    ];
    const feature = {
      type: "Feature",
      id: "avoid-1",
      geometry: { type: "MultiPolygon", coordinates: [polyA, polyB] },
      properties: { kind: "hard" },
    };
    const { status, features, dropped } = parseReferenceGeoJSON({ type: "FeatureCollection", features: [feature] });
    expect(status).toBe("ok");
    expect(dropped).toBe(0);
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.geometry)).toEqual([
      { type: "Polygon", coordinates: polyA },
      { type: "Polygon", coordinates: polyB },
    ]);
    expect(features[0]?.properties).toBe(feature.properties); // properties shared by reference
    expect(features[1]?.properties).toBe(feature.properties);
    expect(features.map((f) => f.id)).toEqual(["avoid-1", "avoid-1"]); // foreign members preserved
    expect(features[0]?.geometry.coordinates).toBe(polyA); // coordinate arrays by reference, never copied
  });

  it("flattens MultiLineString and MultiPoint into one feature per part", () => {
    const lines = [[[0, 0], [0, 1]], [[1, 1], [2, 2], [3, 2]]];
    const positions = [[5, 5], [6, 6]];
    const { status, features, dropped } = parseReferenceGeoJSON({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "MultiLineString", coordinates: lines }, properties: { a: 1 } },
        { type: "Feature", geometry: { type: "MultiPoint", coordinates: positions }, properties: { b: 2 } },
      ],
    });
    expect(status).toBe("ok");
    expect(dropped).toBe(0);
    expect(features.map((f) => [f.geometry.type, f.properties])).toEqual([
      ["LineString", { a: 1 }],
      ["LineString", { a: 1 }],
      ["Point", { b: 2 }],
      ["Point", { b: 2 }],
    ]);
    expect(features[0]?.geometry.coordinates).toBe(lines[0]); // part arrays by reference (foreign z/M ride along)
    expect(features[3]?.geometry.coordinates).toBe(positions[1]);
  });

  it("recurses into GeometryCollection, including Multi* nested inside", () => {
    const { status, features, dropped } = parseReferenceGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "GeometryCollection",
            geometries: [
              { type: "Point", coordinates: [0, 0] },
              { type: "GeometryCollection", geometries: [{ type: "MultiPoint", coordinates: [[1, 1], [2, 2]] }] },
              { type: "LineString", coordinates: [[3, 3], [4, 4]] },
            ],
          },
          properties: { src: "gc" },
        },
      ],
    });
    expect(status).toBe("ok");
    expect(dropped).toBe(0);
    expect(features.map((f) => f.geometry.type)).toEqual(["Point", "Point", "Point", "LineString"]);
    for (const f of features) expect(f.properties).toEqual({ src: "gc" });
  });

  it("counts an invalid part inside a Multi as dropped while its valid siblings load", () => {
    const good = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
    const { status, features, dropped } = parseReferenceGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: [good, [[[2, 2], [3, "x"]]], "not-a-polygon"], // bad position; not an array at all
          },
          properties: {},
        },
      ],
    });
    expect(status).toBe("ok");
    expect(dropped).toBe(2);
    expect(features).toHaveLength(1);
    expect(features[0]?.geometry).toEqual({ type: "Polygon", coordinates: good });
  });

  it("loads a dissolved-MultiPolygon-only collection (ticket 07 scenario) instead of silently serving 0 features", () => {
    const { status, features, dropped } = parseReferenceGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [[[113.26, 23.3], [120, 25], [118, 30], [113.26, 23.3]]],
              [[[123.93, 44.56], [124, 44.6], [123.8, 44.6], [123.93, 44.56]]],
            ],
          },
          properties: { zone: "avoid" },
        },
      ],
    });
    expect(status).toBe("ok");
    expect(dropped).toBe(0);
    expect(features).toHaveLength(2);
    expect(features.every((f) => f.geometry.type === "Polygon")).toBe(true);
  });

  it("flattens a bare Feature and a bare multipart geometry the same way", () => {
    const feature = {
      type: "Feature",
      geometry: { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] },
      properties: { p: 1 },
    };
    expect(parseReferenceGeoJSON(feature)).toEqual({
      status: "ok",
      dropped: 0,
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { p: 1 } },
        { type: "Feature", geometry: { type: "Point", coordinates: [3, 4] }, properties: { p: 1 } },
      ],
    });
    const bare = { type: "MultiLineString", coordinates: [[[0, 0], [0, 1]]] };
    const wrapped = parseReferenceGeoJSON(bare);
    expect(wrapped.status).toBe("ok");
    expect(wrapped.dropped).toBe(0);
    expect(wrapped.features).toHaveLength(1);
    expect(wrapped.features[0]?.properties).toEqual({}); // bare geometry wraps with {}
    expect(wrapped.features[0]?.geometry.coordinates).toBe(bare.coordinates[0]);
  });

  it("keeps a bare input whose parts all fail validation invalid, as before", () => {
    expect(
      parseReferenceGeoJSON({ type: "Feature", geometry: { type: "MultiPoint", coordinates: [["x"]] }, properties: {} }),
    ).toEqual({ status: "invalid", features: [], dropped: 0 });
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
      { hello: 1 },
    ];
    for (const input of garbage) {
      expect(parseReferenceGeoJSON(input)).toEqual({ status: "invalid", features: [], dropped: 0 });
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
      { type: "Feature", geometry: { type: "Point", coordinates: at(90, 550) }, properties: {} },
    ] });
    const outPt = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: at(90, 650) }, properties: {} },
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

    // parallel chord whose closest approach is ~700 m — vertices ~990 m out, no
    // crossing (inside the old 1 km radius, outside the current 600 m — ticket 12)
    const chord = load({ type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [at(45, 990), at(135, 990)] }, properties: {} },
    ] });
    expect(filterByCircleUnion(chord, CENTER)).toEqual([]);
  });

  it("includes a polygon whose edge clips the circle while every vertex is outside", () => {
    const diamond = (d: number) =>
      load({ type: "FeatureCollection", features: [
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[at(0, d), at(90, d), at(180, d), at(270, d), at(0, d)]] }, properties: {} },
      ] });
    // vertices 700 m out, edges pass at 700·cos45° ≈ 495 m — edge-clip only
    expect(filterByCircleUnion(diamond(700), CENTER)).toEqual(diamond(700));
    // vertices 1300 m out, edges at ≈ 919 m — fully outside
    expect(filterByCircleUnion(diamond(1300), CENTER)).toEqual([]);
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

    const nearB = atFrom({ lon: east3k.lon, lat: east3k.lat }, 90, 500); // only in B's circle
    const midway = at(90, 1500); // 1500 m from both A and B — the union gap
    const nearA = at(270, 550);
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
// Watch state machine (ticket 02) — createLayerState/acceptLayerProbe are the
// pure core the vite wiring drives: probes come from fs reads, the machine
// decides payload + retry + changed. Spec §Watch semantics.

const WATCH_SPEC: RefLayerSpec = { name: "a", path: "a.geojson", color: "#e69f00", labelProp: null };

const nearPt: RefFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [LON, LAT] },
  properties: { tid: "T1" },
};
const nearPtB: RefFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: at(90, 50) },
  properties: { tid: "T3" },
};
const farPt: RefFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: at(0, 5000) },
  properties: { tid: "T2" },
};

/** A watch-state literal built independently of createLayerState (no tautology). */
function watchState(
  status: "ok" | "invalid" | "missing",
  features: RefFeature[],
  retryPending = false,
  dropped = 0,
): RefLayerState {
  return {
    payload: { name: "a", color: "#e69f00", labelProp: null, status, dropped, features: { type: "FeatureCollection", features } },
    retryPending,
  };
}

describe("createLayerState", () => {
  it("seeds a neutral placeholder (missing + empty) with no retry pending", () => {
    expect(createLayerState(WATCH_SPEC)).toEqual({
      payload: {
        name: "a",
        color: "#e69f00",
        labelProp: null,
        status: "missing",
        dropped: 0,
        features: { type: "FeatureCollection", features: [] },
      },
      retryPending: false,
    });
  });
});

describe("acceptLayerProbe", () => {
  const C = [{ lon: LON, lat: LAT }];
  it("replaces the payload whole, re-filtered by the circle union, on a successful parse", () => {
    const t = acceptLayerProbe(watchState("ok", [nearPt]), { read: "ok", features: [nearPt, nearPtB, farPt], dropped: 0 }, C);
    expect(t.state).toEqual(watchState("ok", [nearPt, nearPtB])); // farPt excluded by the union
    expect(t.changed).toBe(true);
    expect(t.invalid).toBe(false);
  });

  it("defers the first parse failure: payload untouched, no emit, not terminal", () => {
    const t = acceptLayerProbe(watchState("ok", [nearPt]), { read: "error", message: "Unexpected token" }, C);
    expect(t.state).toEqual(watchState("ok", [nearPt], true));
    expect(t.changed).toBe(false);
    expect(t.invalid).toBe(false);
  });

  it("keeps last-good features with status invalid when the retry also fails", () => {
    const t = acceptLayerProbe(watchState("ok", [nearPt, nearPtB], true), { read: "error", message: "still bad" }, C);
    expect(t.state).toEqual(watchState("invalid", [nearPt, nearPtB]));
    expect(t.changed).toBe(true); // status ok → invalid
    expect(t.invalid).toBe(true);
  });

  it("re-arms one retry per failure episode and emits nothing when already invalid", () => {
    const first = acceptLayerProbe(watchState("invalid", [nearPt]), { read: "error", message: "x" }, C);
    expect(first.state).toEqual(watchState("invalid", [nearPt], true)); // deferred again
    const second = acceptLayerProbe(first.state, { read: "error", message: "y" }, C);
    expect(second.state).toEqual(watchState("invalid", [nearPt]));
    expect(second.changed).toBe(false); // same status, same last-good features
    expect(second.invalid).toBe(true); // ...but the wiring still warns
  });

  it("recovers transparently when the retry reads a fixed file (mid-write protection)", () => {
    const deferred = acceptLayerProbe(watchState("ok", [nearPt]), { read: "error", message: "half-written" }, C);
    expect(deferred.changed).toBe(false);
    const t = acceptLayerProbe(deferred.state, { read: "ok", features: [nearPt, nearPtB], dropped: 0 }, C);
    expect(t.state).toEqual(watchState("ok", [nearPt, nearPtB]));
    expect(t.changed).toBe(true);
    expect(t.invalid).toBe(false);
  });

  it("recovers invalid → ok with a full replace", () => {
    const t = acceptLayerProbe(watchState("invalid", [nearPt]), { read: "ok", features: [nearPtB], dropped: 0 }, C);
    expect(t.state).toEqual(watchState("ok", [nearPtB]));
    expect(t.changed).toBe(true);
  });

  it("empties the layer with status missing when the file is gone; stays quiet once missing", () => {
    const t = acceptLayerProbe(watchState("ok", [nearPt]), { read: "missing" }, C);
    expect(t.state).toEqual(watchState("missing", []));
    expect(t.changed).toBe(true);
    const again = acceptLayerProbe(t.state, { read: "missing" }, C);
    expect(again.state).toEqual(watchState("missing", []));
    expect(again.changed).toBe(false);
  });

  it("re-adds as ok after missing (an absent file appearing under watch)", () => {
    const t = acceptLayerProbe(watchState("missing", []), { read: "ok", features: [nearPt], dropped: 0 }, C);
    expect(t.state).toEqual(watchState("ok", [nearPt]));
    expect(t.changed).toBe(true);
  });

  it("emits nothing for a rewrite that changes nothing", () => {
    const t = acceptLayerProbe(watchState("ok", [nearPt]), { read: "ok", features: [nearPt], dropped: 0 }, C);
    expect(t.state).toEqual(watchState("ok", [nearPt]));
    expect(t.changed).toBe(false);
  });

  it("carries the probe's dropped count; a dropped-only change still emits, missing resets to 0", () => {
    const bumped = acceptLayerProbe(watchState("ok", [nearPt]), { read: "ok", features: [nearPt], dropped: 2 }, C);
    expect(bumped.state.payload.dropped).toBe(2);
    expect(bumped.changed).toBe(true); // identical filtered features — dropped alone forces the push
    const again = acceptLayerProbe(bumped.state, { read: "ok", features: [nearPt], dropped: 2 }, C);
    expect(again.changed).toBe(false); // nothing moved — no spurious refetch pushes
    const gone = acceptLayerProbe(bumped.state, { read: "missing" }, C);
    expect(gone.state.payload.status).toBe("missing");
    expect(gone.state.payload.dropped).toBe(0);
  });

  it("keeps the last-good dropped count across a deferral and a terminal error", () => {
    const loaded = acceptLayerProbe(watchState("ok", [nearPt]), { read: "ok", features: [nearPt], dropped: 2 }, C).state;
    const deferred = acceptLayerProbe(loaded, { read: "error", message: "half-written" }, C);
    expect(deferred.state.payload.dropped).toBe(2); // deferral leaves the payload untouched
    const terminal = acceptLayerProbe(deferred.state, { read: "error", message: "still bad" }, C);
    expect(terminal.state.payload.status).toBe("invalid");
    expect(terminal.state.payload.dropped).toBe(2); // last-good count survives the terminal flip
    expect(terminal.changed).toBe(true); // status ok → invalid
  });
});

// ---------------------------------------------------------------------------
// GET /api/reference-layers + its watch wiring — exercised like
// annotations-endpoint.test.ts: configureServer registers a Connect handler
// (and, since ticket 02, watcher listeners) invoked against minimal mocks
// over real temp dirs (real fs, real scan). The env is read once at boot,
// like cli.ts sets it before createServer: configure the env, then start().

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

function start() {
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

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pano-ref-"));
  delete process.env.PANO_REFERENCE_LAYERS;
  delete process.env.PANO_PHOTOS_DIR;
  // installed before any start(): the boot load may warn inside configureServer
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

/** Photos dir with one positioned pano at (LON, LAT). */
function panoDir(): string {
  const photos = path.join(dir, "photos");
  fs.mkdirSync(photos);
  fs.writeFileSync(path.join(photos, `${geohash8(LON, LAT)}.jpg`), "");
  return photos;
}

/** GET the endpoint through the mock req/res. */
function get(handler: Handler): { layers: RefLayerPayload[] } {
  const res = new MockRes();
  handler(new MockReq("GET"), res);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe("GET /api/reference-layers (boot state)", () => {
  it("answers { layers: [] } when PANO_REFERENCE_LAYERS is unset (plain `vite dev`)", () => {
    const { handler } = start();
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
    const farA = { type: "Feature", geometry: { type: "Point", coordinates: at(0, 5000) }, properties: { tid: "T2" } };
    const crossing = { type: "Feature", geometry: { type: "LineString", coordinates: [at(0, 1500), at(180, 1500)] }, properties: { tid: "L1" } };
    const aFile = path.join(dir, "a.geojson");
    fs.writeFileSync(aFile, JSON.stringify({ type: "FeatureCollection", features: [nearA, farA] }));
    const bFile = path.join(dir, "b.geojson");
    fs.writeFileSync(bFile, JSON.stringify({ type: "FeatureCollection", features: [crossing] }));

    process.env.PANO_PHOTOS_DIR = photos;
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "a", path: aFile, color: "#e69f00", labelProp: "tid" },
      { name: "b", path: bFile, color: "#0072b2", labelProp: null },
    ]);
    const { handler } = start();
    // expected body built independently from the inputs: only the near point
    // and the edge-crossing line survive the union prefilter, both whole.
    expect(get(handler)).toEqual({
      layers: [
        { name: "a", color: "#e69f00", labelProp: "tid", status: "ok", dropped: 0, features: { type: "FeatureCollection", features: [nearA] } },
        { name: "b", color: "#0072b2", labelProp: null, status: "ok", dropped: 0, features: { type: "FeatureCollection", features: [crossing] } },
      ],
    });
  });

  it("reports a missing file as status missing with empty features", () => {
    process.env.PANO_PHOTOS_DIR = panoDir();
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "gone", path: path.join(dir, "absent.geojson"), color: "#e69f00", labelProp: null },
    ]);
    const { handler } = start();
    expect(get(handler)).toEqual({
      layers: [{ name: "gone", color: "#e69f00", labelProp: null, status: "missing", dropped: 0, features: { type: "FeatureCollection", features: [] } }],
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("reports a malformed file as status invalid with empty features and a warning", () => {
    process.env.PANO_PHOTOS_DIR = panoDir();
    const bad = path.join(dir, "bad.geojson");
    fs.writeFileSync(bad, "{ not json");
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify([
      { name: "bad", path: bad, color: "#e69f00", labelProp: null },
    ]);
    const { handler } = start();
    expect(get(handler)).toEqual({
      layers: [{ name: "bad", color: "#e69f00", labelProp: null, status: "invalid", dropped: 0, features: { type: "FeatureCollection", features: [] } }],
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
    const { handler } = start();
    expect(get(handler)).toEqual({
      layers: [{ name: "a", color: "#e69f00", labelProp: null, status: "ok", dropped: 0, features: { type: "FeatureCollection", features: [] } }],
    });
  });

  it("degrades to { layers: [] } with a warning when the env JSON is corrupt", () => {
    process.env.PANO_REFERENCE_LAYERS = "{broken";
    const { handler } = start();
    expect(get(handler)).toEqual({ layers: [] });
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("reference layer watch (ticket 02)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const write = (file: string, features: RefFeature[]) =>
    fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));

  /** Write each sheet's file (unless absent-at-boot), set the env, boot the plugin. */
  function bootLayers(sheets: Array<{ name: string; file: string; features?: RefFeature[] }>) {
    process.env.PANO_PHOTOS_DIR = panoDir();
    for (const s of sheets) if (s.features) write(s.file, s.features);
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify(
      sheets.map((s) => ({ name: s.name, path: s.file, color: "#e69f00", labelProp: null })),
    );
    return start();
  }

  it("registers each layer file with Vite's watcher — files absent at boot too", () => {
    const a = path.join(dir, "a.geojson");
    const b = path.join(dir, "later.geojson");
    const ctx = bootLayers([
      { name: "a", file: a, features: [nearPt] },
      { name: "b", file: b }, // absent at boot — may appear later under watch
    ]);
    expect(ctx.watcher.added).toEqual([a, b]);
    expect(get(ctx.handler).layers.map((l) => l.status)).toEqual(["ok", "missing"]);
  });

  it("re-reads and re-filters on change after the 300 ms debounce, pushing one ws event", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    write(file, [nearPt, nearPtB]);
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(299);
    expect(get(ctx.handler).layers[0]?.features.features).toEqual([nearPt]); // debounce pending
    vi.advanceTimersByTime(1);
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPt, nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
  });

  it("debounces per file: bursts collapse, files stay independent", () => {
    const a = path.join(dir, "a.geojson");
    const b = path.join(dir, "b.geojson");
    const ctx = bootLayers([
      { name: "a", file: a, features: [nearPt] },
      { name: "b", file: b, features: [nearPt] },
    ]);
    write(a, [nearPt, nearPtB]);
    ctx.watcher.emit("change", a);
    vi.advanceTimersByTime(100); // a second burst 100 ms into a's window
    write(b, [nearPt, nearPtB]);
    ctx.watcher.emit("change", b);
    vi.advanceTimersByTime(199);
    expect(get(ctx.handler).layers.map((l) => l.features.features.length)).toEqual([1, 1]); // neither elapsed
    vi.advanceTimersByTime(1); // t=300: a's window closes
    expect(get(ctx.handler).layers[0]?.features.features).toEqual([nearPt, nearPtB]);
    expect(get(ctx.handler).layers[1]?.features.features).toEqual([nearPt]);
    vi.advanceTimersByTime(99); // t=399: b's window (opened at t=100) still open
    expect(get(ctx.handler).layers[1]?.features.features).toEqual([nearPt]);
    vi.advanceTimersByTime(1); // t=400
    expect(get(ctx.handler).layers[1]?.features.features).toEqual([nearPt, nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed", "reference-layers:changed"]);
  });

  it("keeps last good + status invalid after a corruption outlives its one retry", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt, nearPtB] }]);
    fs.writeFileSync(file, "{broken mid-write");
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(300); // debounce → probe fails → deferred, retry armed
    let layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok"); // a deferred failure keeps serving the last good
    expect(layer?.features.features).toEqual([nearPt, nearPtB]);
    expect(ctx.ws.sent).toEqual([]);
    vi.advanceTimersByTime(300); // retry → still bad → terminal
    layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("invalid");
    expect(layer?.features.features).toEqual([nearPt, nearPtB]); // last good kept, never blanked
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("recovers transparently when the file is fixed inside the retry window (mid-write)", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    fs.writeFileSync(file, "{partial");
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(300); // deferred — retry armed
    write(file, [nearPtB]);
    vi.advanceTimersByTime(300); // the retry reads the now-fixed file
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok"); // status never left ok
    expect(layer?.features.features).toEqual([nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
  });

  it("recovers invalid → ok once the producer writes valid JSON again", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    fs.writeFileSync(file, "{broken");
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(600); // debounce + the one retry
    expect(get(ctx.handler).layers[0]?.status).toBe("invalid");
    write(file, [nearPtB]);
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(300);
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed", "reference-layers:changed"]);
  });

  it("unlink → status missing with empty features; re-add → ok again", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    fs.rmSync(file);
    ctx.watcher.emit("unlink", file);
    vi.advanceTimersByTime(300);
    let layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("missing");
    expect(layer?.features.features).toEqual([]);
    write(file, [nearPtB]);
    ctx.watcher.emit("add", file);
    vi.advanceTimersByTime(300);
    layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed", "reference-layers:changed"]);
  });

  it("serves a file absent at boot as missing and picks it up when it appears", () => {
    const file = path.join(dir, "later.geojson");
    const ctx = bootLayers([{ name: "later", file }]);
    expect(get(ctx.handler).layers[0]?.status).toBe("missing");
    write(file, [nearPt]);
    ctx.watcher.emit("add", file);
    vi.advanceTimersByTime(300);
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPt]);
  });

  it("pushes nothing when a rewrite changes nothing", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    ctx.watcher.emit("change", file); // same bytes on disk
    vi.advanceTimersByTime(600);
    expect(ctx.ws.sent).toEqual([]);
    expect(get(ctx.handler).layers[0]?.status).toBe("ok");
  });

  it("reloads every layer sharing a file together, with one ws event per change", () => {
    const file = path.join(dir, "shared.geojson");
    const ctx = bootLayers([
      { name: "a", file, features: [nearPt] },
      { name: "b", file, features: [nearPt] },
    ]);
    write(file, [nearPtB]);
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(300);
    const layers = get(ctx.handler).layers;
    expect(layers.map((l) => l.status)).toEqual(["ok", "ok"]);
    expect(layers.map((l) => l.features.features)).toEqual([[nearPtB], [nearPtB]]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
  });
});

describe("request-time mtime safety net (ticket 08)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const write = (file: string, features: RefFeature[]) =>
    fs.writeFileSync(file, JSON.stringify({ type: "FeatureCollection", features }));

  /** Write each sheet's file (unless absent-at-boot), set the env, boot the plugin. */
  function bootLayers(sheets: Array<{ name: string; file: string; features?: RefFeature[] }>) {
    process.env.PANO_PHOTOS_DIR = panoDir();
    for (const s of sheets) if (s.features) write(s.file, s.features);
    process.env.PANO_REFERENCE_LAYERS = JSON.stringify(
      sheets.map((s) => ({ name: s.name, path: s.file, color: "#e69f00", labelProp: null })),
    );
    return start();
  }

  // The safety net keys on mtimeMs, and the OS may stamp two quick test
  // writes identically (Windows timestamp ticks) — every simulated producer
  // rewrite below sets a strictly advancing mtime so the tests never depend
  // on that granularity.
  let mtimeTick = 0;
  const bumpMtime = (file: string) => {
    const t = new Date(Date.now() + ++mtimeTick * 10);
    fs.utimesSync(file, t, t);
  };
  const rewrite = (file: string, features: RefFeature[]) => {
    write(file, features);
    bumpMtime(file);
  };

  it("serves a rewritten file on the very next GET when the watch event was lost", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    rewrite(file, [nearPt, nearPtB]); // producer rewrite — the watcher never fires
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPt, nearPtB]);
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]); // idle clients refetch too
  });

  it("picks up a lost unlink via presence change, and the re-add likewise", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    fs.rmSync(file); // unlink event lost
    expect(get(ctx.handler).layers[0]?.status).toBe("missing");
    rewrite(file, [nearPtB]); // add event lost too
    const layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok");
    expect(layer?.features.features).toEqual([nearPtB]);
  });

  it("stats only: GETs without an mtime change never re-read layer contents", () => {
    const file = path.join(dir, "a.geojson");
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt] }]);
    const readsOf = () => readFileSync.mock.calls.filter((call) => call[0] === file).length;
    expect(readsOf()).toBe(1); // the boot probe
    get(ctx.handler);
    get(ctx.handler);
    get(ctx.handler);
    expect(readsOf()).toBe(1); // mtime unchanged — stat only, no content read
    rewrite(file, [nearPtB]);
    get(ctx.handler);
    expect(readsOf()).toBe(2); // exactly one re-probe on the change
  });

  it("a request-path parse failure defers once, then retries on the same 300 ms timer", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt, nearPtB] }]);
    fs.writeFileSync(file, "{broken mid-write"); // lost watch event
    bumpMtime(file);
    let layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("ok"); // first failure defers, keeps serving last good
    expect(layer?.features.features).toEqual([nearPt, nearPtB]);
    expect(ctx.ws.sent).toEqual([]);
    vi.advanceTimersByTime(300); // the armed retry — still bad → terminal
    layer = get(ctx.handler).layers[0];
    expect(layer?.status).toBe("invalid");
    expect(layer?.features.features).toEqual([nearPt, nearPtB]); // last good kept
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("a GET inside an armed retry window serves last-good and does not force terminal invalid", () => {
    const file = path.join(dir, "a.geojson");
    const ctx = bootLayers([{ name: "a", file, features: [nearPt, nearPtB] }]);
    fs.writeFileSync(file, "{broken mid-write");
    bumpMtime(file);
    ctx.watcher.emit("change", file);
    vi.advanceTimersByTime(300); // debounce → probe fails → deferred, retry armed
    const layer = get(ctx.handler).layers[0]; // GET lands inside the retry window
    expect(layer?.status).toBe("ok"); // the watch path owns the file — no early terminal
    expect(layer?.features.features).toEqual([nearPt, nearPtB]);
    vi.advanceTimersByTime(300); // the armed retry — still bad → terminal
    expect(get(ctx.handler).layers[0]?.status).toBe("invalid");
    expect(ctx.ws.sent).toEqual(["reference-layers:changed"]);
  });
});
