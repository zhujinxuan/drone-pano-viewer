import { describe, expect, it } from "vitest";
import { vincentyDirect, vincentyInverse } from "./geodesy.ts";
import { centroidView, groundTarget, type GroundCam } from "./ground-capture.ts";

// Independent sources of truth:
//  - The worked example's target is the trusted, GeodTest-verified
//    vincentyDirect of the same inputs (100 m @ bearing 45°), corroborated
//    against textbook curvature radii (like geodesy.test.ts).
//  - Expected errM recomputed by hand from the documented model:
//    h·δp/sin²|p| + 1/tan|p| + σ, δp = 0.1°, σ = 20 m (geohash).

const CAM: GroundCam = {
  lat: 44.57108656,
  lon: 123.930472215,
  source: "geohash",
  relAltM: 100,
};

describe("groundTarget — worked example", () => {
  it("yaw 45°, pitch −45°, 100 m AGL → 100 m NE ground point + error", () => {
    const t = groundTarget(CAM, 45, -45);
    expect(t).not.toBeNull();
    // vincentyDirect(44.57108656, 123.930472215, 45, 100)
    expect(t!.lat).toBeCloseTo(44.5717228822416, 9);
    expect(t!.lon).toBeCloseTo(123.931362418914, 9);
    // 100·δp/sin²45° + 1/tan45° + 20
    expect(t!.errM).toBeCloseTo(21.3490658504, 6);
  });

  it("corroborates the target against textbook curvature radii", () => {
    const t = groundTarget(CAM, 45, -45)!;
    const a = 6378137;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const s = Math.sin((CAM.lat * Math.PI) / 180);
    const M = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
    const N = a / Math.sqrt(1 - e2 * s * s);
    const rad2deg = 180 / Math.PI;
    expect(t.lat - CAM.lat).toBeCloseTo((100 * Math.cos(Math.PI / 4) * rad2deg) / M, 6);
    expect(t.lon - CAM.lon).toBeCloseTo(
      (100 * Math.sin(Math.PI / 4) * rad2deg) / (N * Math.cos((CAM.lat * Math.PI) / 180)),
      6,
    );
  });

  it("takes view-true yaw: −10.7° ≡ 349.3°", () => {
    const a = groundTarget(CAM, -10.7, -30)!;
    const b = groundTarget(CAM, 349.3, -30)!;
    expect(a.lat).toBeCloseTo(b.lat, 12);
    expect(a.lon).toBeCloseTo(b.lon, 12);
  });

  it("round-trips: inverse of the target recovers yaw and horizontal distance", () => {
    const t = groundTarget(CAM, 137.5, -35)!;
    const r = vincentyInverse(CAM.lat, CAM.lon, t.lat, t.lon);
    expect(r.bearingDeg).toBeCloseTo(137.5, 8);
    expect(r.distanceM).toBeCloseTo(100 / Math.tan((35 * Math.PI) / 180), 4);
  });
});

describe("groundTarget — errM tracks the position source σ", () => {
  it("RTK uses rtkStd when the XMP carried it", () => {
    const t = groundTarget({ ...CAM, source: "rtk", rtkStd: 0.05 }, 45, -45)!;
    // 0.3490659 + 1 + 0.05
    expect(t.errM).toBeCloseTo(1.3990658504, 6);
  });

  it("RTK without rtkStd and plain GNSS fall back to σ = 3 m", () => {
    expect(groundTarget({ ...CAM, source: "rtk" }, 45, -45)!.errM).toBeCloseTo(4.3490658504, 6);
    expect(groundTarget({ ...CAM, source: "gnss" }, 45, -45)!.errM).toBeCloseTo(4.3490658504, 6);
  });

  it("errM grows monotonically as the pitch shallows", () => {
    const errs = [-60, -30, -15, -5].map((p) => groundTarget(CAM, 0, p)!.errM);
    expect(errs[0]).toBeLessThan(errs[1]);
    expect(errs[1]).toBeLessThan(errs[2]);
    expect(errs[2]).toBeLessThan(errs[3]);
  });
});

describe("groundTarget — no ground point → null", () => {
  it("pitch at/above the horizon", () => {
    expect(groundTarget(CAM, 45, 0)).toBeNull();
    expect(groundTarget(CAM, 45, 30)).toBeNull();
  });

  it("missing, zero, negative or NaN altitude", () => {
    expect(groundTarget({ ...CAM, relAltM: 0 }, 45, -45)).toBeNull();
    expect(groundTarget({ ...CAM, relAltM: -5 }, 45, -45)).toBeNull();
    expect(groundTarget({ ...CAM, relAltM: NaN }, 45, -45)).toBeNull();
  });

  it("missing or non-finite camera position", () => {
    expect(groundTarget(null, 45, -45)).toBeNull();
    expect(groundTarget({ ...CAM, lat: NaN }, 45, -45)).toBeNull();
    expect(groundTarget({ ...CAM, lon: NaN }, 45, -45)).toBeNull();
  });

  it("non-finite pitch", () => {
    expect(groundTarget(CAM, 45, NaN)).toBeNull();
  });
});

describe("centroidView — inverse direction for camera swings", () => {
  const CAM2: GroundCam = { ...CAM, relAltM: 50 };

  it("vertices ringing an anchor 200 m away recover its yaw and pitch", () => {
    const anchor = vincentyDirect(CAM2.lat, CAM2.lon, 30, 200);
    const vertices = [0, 120, 240].map((b) => {
      const v = vincentyDirect(anchor.lat, anchor.lon, b, 10);
      return [v.lon, v.lat] as [number, number];
    });
    const view = centroidView(CAM2, vertices);
    expect(view!.yawDeg).toBeCloseTo(30, 4);
    expect(view!.pitchDeg).toBeCloseTo(-14.036243467926479, 4); // −atan2(50, 200)
  });

  it.each([
    [0, 250],
    [90, 300],
    [180, 200],
    [270, 150],
  ])("single vertex at bearing %d°, %d m → yaw recovers the bearing", (bearing, dist) => {
    const v = vincentyDirect(CAM2.lat, CAM2.lon, bearing, dist);
    const view = centroidView(CAM2, [[v.lon, v.lat]]);
    expect(view!.yawDeg).toBeCloseTo(bearing, 8);
  });

  it("centroid directly below the camera → nadir", () => {
    const view = centroidView(CAM2, [
      [CAM2.lon, CAM2.lat],
      [CAM2.lon, CAM2.lat],
    ]);
    expect(view!.pitchDeg).toBeCloseTo(-90, 9);
  });

  it("returns null for missing position or no vertices", () => {
    expect(centroidView(null, [[123.93, 44.57]])).toBeNull();
    expect(centroidView(CAM2, [])).toBeNull();
    expect(centroidView({ ...CAM2, lat: NaN }, [[123.93, 44.57]])).toBeNull();
  });
});
