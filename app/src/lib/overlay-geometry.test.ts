import { describe, expect, it } from "vitest";
import { vincentyDirect } from "./geodesy.ts";
import { verticesCentroid, vertexView } from "./overlay-geometry.ts";

// The camera fix mirrors the spec's example capture (44.9 N, 125.1 E,
// 112.5 m AGL). Ground distances span the feature's working range up to the
// 5 km cap; a full Vincenty-direct round trip bounds the linearization error
// (local M/N radii vs the ellipsoid geodesic) measured while writing this:
//   yaw < 8.3e-7 / 2.1e-5 / 4.2e-4 rad and pitch < 4e-8 / 2.6e-6 / 3.1e-6 rad
// at 10 / 250 / 5000 m — the tolerances below keep ~6x headroom at short
// range and ~1.2x at the cap, still far below anything screen-visible.
const CAM = { lat: 44.9, lon: 125.1, relAltM: 112.5 };
const RAD = Math.PI / 180;

/** Shortest signed difference between two angles. */
function angleDiff(a: number, b: number): number {
  const d = (a - b) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
}

describe("vertexView — cardinal directions (equator, hand-computed)", () => {
  const cam = { lat: 0, lon: 0, relAltM: 100 };
  // 0.01° on the equator = a·π/180·0.01 = 1113.19 m east or west.
  const d = 1113.194926644;

  it("due east is yaw +90°", () => {
    const v = vertexView(cam, [0.01, 0]);
    expect(v.yawRad).toBeCloseTo(Math.PI / 2, 9);
    expect(v.pitchRad).toBeCloseTo(-Math.atan2(100, d), 6);
  });

  it("due west is yaw −90°", () => {
    expect(vertexView(cam, [-0.01, 0]).yawRad).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("due north is yaw 0, due south is yaw 180°", () => {
    expect(vertexView(cam, [0, 0.01]).yawRad).toBeCloseTo(0, 9);
    expect(vertexView(cam, [0, -0.01]).yawRad).toBeCloseTo(Math.PI, 9);
  });

  it("vertex at the camera is nadir: pitch −90°, yaw 0", () => {
    const v = vertexView(cam, [0, 0]);
    expect(v.pitchRad).toBeCloseTo(-Math.PI / 2, 12);
    expect(v.yawRad).toBe(0);
  });

  it("zero altitude puts every vertex on the horizon (pitch 0)", () => {
    expect(vertexView({ ...cam, relAltM: 0 }, [0.01, 0]).pitchRad).toBeCloseTo(0, 12);
  });
});

describe("vertexView — round-trips Vincenty direct (the capture path)", () => {
  it.each([10, 250, 5000])("distance %i m across bearings", (dist) => {
    const yawDigits = dist <= 10 ? 5 : dist <= 250 ? 4 : 3;
    for (const bearing of [0, 17, 45, 90, 135, 180, 225, 270, 315, 359]) {
      const target = vincentyDirect(CAM.lat, CAM.lon, bearing, dist);
      const v = vertexView(CAM, [target.lon, target.lat]);
      expect(angleDiff(v.yawRad, bearing * RAD)).toBeCloseTo(0, yawDigits);
      expect(v.pitchRad).toBeCloseTo(-Math.atan2(CAM.relAltM, dist), 5);
    }
  });
});

describe("verticesCentroid", () => {
  it("averages lon/lat independently", () => {
    const c = verticesCentroid([
      [125.1, 44.9],
      [125.2, 44.94],
      [125.3, 44.86],
    ]);
    expect(c[0]).toBeCloseTo(125.2, 12);
    expect(c[1]).toBeCloseTo(44.9, 12);
  });

  it("single vertex is its own centroid", () => {
    expect(verticesCentroid([[125.05, 44.95]])).toEqual([125.05, 44.95]);
  });
});
