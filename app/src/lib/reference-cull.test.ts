import { describe, expect, it } from "vitest";
import { vincentyDirect } from "./geodesy.ts";
import {
  CULL_RADIUS_M,
  featureIsCulled,
  geometryVertices,
  type CullCam,
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
