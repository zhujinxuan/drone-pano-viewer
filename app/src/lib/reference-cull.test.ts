import { describe, expect, it } from "vitest";
import { vincentyDirect } from "./geodesy.ts";
import {
  CULL_RADIUS_M,
  cullEntry,
  entryIsCulled,
  featureIsCulled,
  geometryVertices,
  type CullCam,
  type CullEntry,
} from "./reference-cull.ts";

// Spec: .scratch/reference-layers/spec.md §Client behavior (per-pano cull),
// ticket 03. Vertex-based rule: a feature is culled only when EVERY vertex is
// more than 1100 m from the current camera (load-time prefilter already
// bounded the data extent; this is per-photo render hygiene, no clipping).
// Ground-truth positions come from vincentyDirect (GeodTest-verified oracle,
// same approach as reference-layers.test.ts) — threshold tests use ±5 m
// margins, far above the ≈1 cm error of the 7-dp toFixed round-trip.

const CAM: CullCam = { lat: 44.9, lon: 125.1 };

/** Vertex `distM` meters from the camera on `bearingDeg` (Vincenty truth, ~cm). */
function at(bearingDeg: number, distM: number): [number, number] {
  const ll = vincentyDirect(CAM.lat, CAM.lon, bearingDeg, distM);
  return [Number(ll.lon.toFixed(7)), Number(ll.lat.toFixed(7))];
}

describe("geometryVertices", () => {
  it("wraps a Point coordinate as a single vertex", () => {
    expect(geometryVertices({ type: "Point", coordinates: [125.1, 44.9] })).toEqual([
      [125.1, 44.9],
    ]);
  });

  it("passes LineString positions through", () => {
    const coords = [at(0, 100), at(90, 100)];
    expect(geometryVertices({ type: "LineString", coordinates: coords })).toEqual(coords);
  });

  it("flattens every Polygon ring (exterior + holes) into one vertex list", () => {
    const exterior = [at(0, 500), at(90, 500), at(180, 500)];
    const hole = [at(0, 300), at(90, 300), at(180, 300)];
    expect(geometryVertices({ type: "Polygon", coordinates: [exterior, hole] })).toEqual([
      ...exterior,
      ...hole,
    ]);
  });
});

describe("featureIsCulled", () => {
  it("keeps a feature with any vertex inside the radius (whole-feature, no clipping)", () => {
    expect(featureIsCulled(CAM, [at(0, 400), at(180, 2000)])).toBe(false);
    expect(featureIsCulled(CAM, [at(0, 400)])).toBe(false);
  });
  it("splits at the 1100 m threshold (inside keeps, just beyond culls)", () => {
    expect(featureIsCulled(CAM, [at(90, CULL_RADIUS_M - 5)])).toBe(false);
    expect(featureIsCulled(CAM, [at(90, CULL_RADIUS_M + 5)])).toBe(true);
  });

  it("culls when every vertex is beyond the radius", () => {
    expect(featureIsCulled(CAM, [at(0, 1200)])).toBe(true);
    expect(featureIsCulled(CAM, [at(0, 1200), at(90, 1300), at(180, 1500)])).toBe(true);
  });

  it("uses the 1100 m spec radius by default and honors an override", () => {
    expect(CULL_RADIUS_M).toBe(1100);
    expect(featureIsCulled(CAM, [at(0, 1200)], 1500)).toBe(false);
  });

  it("culls an empty vertex list (nothing drawable)", () => {
    expect(featureIsCulled(CAM, [])).toBe(true);
  });
});

// Ticket 10: two-tier cull — entryIsCulled must return the SAME verdict as
// the exact Vincenty path; the bbox planar tier only skips geodesic work.

describe("cullEntry", () => {
  it("caches the flattened vertices and the lon/lat bbox", () => {
    const exterior = [at(0, 100), at(90, 100), at(180, 100), at(270, 100)];
    const entry = cullEntry({ type: "Polygon", coordinates: [exterior] });
    expect(entry.vertices).toEqual(exterior);
    const lons = exterior.map((v) => v[0]);
    const lats = exterior.map((v) => v[1]);
    expect(entry.bbox).toEqual([
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats),
    ]);
  });

  it("produces an always-culled entry for an empty geometry", () => {
    const entry: CullEntry = { vertices: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] };
    expect(entryIsCulled(CAM, entry)).toBe(true);
  });
});

describe("entryIsCulled", () => {
  it("agrees with the exact path at the 1100 m threshold", () => {
    // Just inside / just outside / inside the 100 m safety band around the
    // threshold — the band cases must fall through to Vincenty, not guess.
    for (const dist of [CULL_RADIUS_M - 5, CULL_RADIUS_M + 5, CULL_RADIUS_M + 50]) {
      for (const bearing of [0, 45, 90, 180, 270, 315]) {
        const entry = cullEntry({ type: "Point", coordinates: at(bearing, dist) });
        expect(entryIsCulled(CAM, entry)).toBe(
          featureIsCulled(CAM, entry.vertices),
        );
      }
    }
  });

  it("culls far features (bbox reject) and keeps near ones", () => {
    expect(
      entryIsCulled(CAM, cullEntry({ type: "LineString", coordinates: [at(0, 5000), at(90, 6000)] })),
    ).toBe(true);
    expect(
      entryIsCulled(CAM, cullEntry({ type: "LineString", coordinates: [at(0, 5000), at(90, 400)] })),
    ).toBe(false);
  });

  it("matches the exact path over a randomized sweep (property)", () => {
    // Deterministic PRNG sweep: cameras and vertex clouds at distances
    // straddling the threshold band from many bearings.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 300; i++) {
      const camBearing = rand() * 360;
      const camDist = rand() * 3000;
      const camLl = vincentyDirect(CAM.lat, CAM.lon, camBearing, camDist);
      const cam: CullCam = { lat: camLl.lat, lon: camLl.lon };
      const nVerts = 1 + Math.floor(rand() * 6);
      const verts: [number, number][] = [];
      for (let j = 0; j < nVerts; j++) {
        // Bias distances into the 0–2500 m window so both verdicts occur.
        const d = rand() * 2500;
        const b = rand() * 360;
        const ll = vincentyDirect(CAM.lat, CAM.lon, b, d);
        verts.push([Number(ll.lon.toFixed(7)), Number(ll.lat.toFixed(7))]);
      }
      const geometry =
        verts.length === 1
          ? { type: "Point" as const, coordinates: verts[0]! }
          : { type: "LineString" as const, coordinates: verts };
      const entry = cullEntry(geometry);
      expect(entryIsCulled(cam, entry)).toBe(featureIsCulled(cam, entry.vertices));
    }
  });
});
