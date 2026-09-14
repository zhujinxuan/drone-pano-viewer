import { describe, expect, it } from "vitest";
import { vincentyDirect } from "./geodesy.ts";
import { makeProjector, simplifyViewRays, verticesCentroid, vertexView } from "./overlay-geometry.ts";

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

// Ticket 11: makeProjector hoists cam-only terms — identical math to
// vertexView; simplifyViewRays is the sub-pixel Douglas-Peucker render cut.

describe("makeProjector", () => {
  it("matches vertexView across the working range", () => {
    const project = makeProjector(CAM);
    for (const dist of [1, 10, 250, 1000, 5000]) {
      for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const t = vincentyDirect(CAM.lat, CAM.lon, bearing, dist);
        const v: [number, number] = [t.lon, t.lat];
        const a = project(v);
        const b = vertexView(CAM, v);
        expect(a.yawRad).toBeCloseTo(b.yawRad, 12);
        expect(a.pitchRad).toBeCloseTo(b.pitchRad, 12);
      }
    }
  });
});

describe("simplifyViewRays", () => {
  const ray = (yaw: number, pitch = 0): { yawRad: number; pitchRad: number } => ({
    yawRad: yaw,
    pitchRad: pitch,
  });

  it("returns short inputs whole", () => {
    expect(simplifyViewRays([ray(0), ray(1)], false)).toEqual([0, 1]);
    expect(simplifyViewRays([ray(0), ray(0.5), ray(1)], true)).toEqual([0, 1, 2]);
    expect(simplifyViewRays([], false)).toEqual([]);
  });

  it("collapses a dense collinear run to its endpoints", () => {
    const rays = Array.from({ length: 10000 }, (_, i) => ray(i * 1e-6, i * 2e-6));
    expect(simplifyViewRays(rays, false)).toEqual([0, 9999]);
  });

  it("keeps a vertex whose deviation exceeds ε and drops one below it", () => {
    const eps = 1e-3;
    // mid at 2ε off the chord → kept; another at ε/10 → dropped
    const rays = [ray(0), ray(0.5, 2 * eps), ray(1), ray(1.5, eps / 10), ray(2)];
    expect(simplifyViewRays(rays, false, eps)).toEqual([0, 1, 2, 4]);
  });

  it("closed rings keep at least 3 vertices even when fully flat", () => {
    const rays = Array.from({ length: 100 }, (_, i) => ray(i * 1e-6));
    const kept = simplifyViewRays(rays, true);
    expect(kept.length).toBe(3);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(99);
  });

  it("bounded deviation: every dropped vertex is within ε of the simplified polyline", () => {
    // Random-ish polyline (deterministic LCG), verify the DP contract directly.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const eps = 5e-4;
    const rays = Array.from({ length: 2000 }, (_, i) => ray(i * 1e-4, (rand() - 0.5) * 4e-4));
    const kept = simplifyViewRays(rays, false, eps);
    for (let s = 0; s < kept.length - 1; s++) {
      const a = rays[kept[s]!]!;
      const b = rays[kept[s + 1]!]!;
      for (let i = kept[s]! + 1; i < kept[s + 1]!; i++) {
        const p = rays[i]!;
        const abx = b.yawRad - a.yawRad;
        const aby = b.pitchRad - a.pitchRad;
        const t = Math.max(
          0,
          Math.min(1, ((p.yawRad - a.yawRad) * abx + (p.pitchRad - a.pitchRad) * aby) / (abx * abx + aby * aby)),
        );
        const d = Math.hypot(p.yawRad - a.yawRad - t * abx, p.pitchRad - a.pitchRad - t * aby);
        expect(d).toBeLessThanOrEqual(eps * 1.0001);
      }
    }
  });
});
