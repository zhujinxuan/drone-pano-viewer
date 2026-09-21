import { describe, expect, it } from "vitest";
import { PITCH_ERR_RAD } from "./copy-record.ts";
import { formatHeightChip, heightBetween, sigmaHeightM } from "./height.ts";

// Independent sources of truth (mirrors measure.test.ts):
//  - WGS84 defining constant: the equator is a geodesic circle of radius
//    exactly a = 6378137 m, so cam (0°, 0°) → A 0.001° east is
//    d = a·π/180·0.001 = 111.319490793 m. Vincenty recovers it to its own
//    ~1e-8 relative convergence (4 decimals, like measure.test.ts); the H
//    assertions therefore check the exact relation H − slope·d = relAlt
//    against the SAME d the function returned, not the reference constant.
//  - Right-triangle slopes: pitch = atan(slope) gives tan(pitch_B) = slope
//    (Math.atan is the model's own inverse), so H = relAlt + slope·d.
//  - 3-4-5 worked example for the error quadrature.

/** 0.001° along the equator — the WGS84 defining-constant distance. */
const D_EQ = (6378137 * Math.PI) / 180 / 1000;
/** Degrees from a slope via the atan the math itself uses. */
const slopeDeg = (s: number): number => (Math.atan(s) * 180) / Math.PI;

const CAM = { lat: 0, lon: 0, relAltM: 100 };
const A = { lat: 0, lon: 0.001, errDiffM: 0 };
/** Degrees of longitude along the equator per meter (WGS84 defining constant). */
const DEG_PER_M_EQ = 180 / (6378137 * Math.PI);
describe("heightBetween — H formula (WGS84 equator-arc reference)", () => {
  it("recovers the equator arc as d; H = relAlt + d·tan(pitch_B)", () => {
    const r = heightBetween(CAM, A, slopeDeg(0.9));
    expect(r).not.toBeNull();
    expect(r!.distM).toBeCloseTo(D_EQ, 4);
    expect(r!.heightM - 0.9 * r!.distM).toBeCloseTo(100, 9);
  });

  it("spec example shape: slope 0.9, d 180 m → H 262 m", () => {
    const r = heightBetween(CAM, { lat: 0, lon: 180 * DEG_PER_M_EQ, errDiffM: 0 }, slopeDeg(0.9));
    expect(r!.distM).toBeCloseTo(180, 3);
    expect(r!.heightM - 0.9 * r!.distM).toBeCloseTo(100, 9);
  });

  it("pitch_B = 0 (tree top at the horizon): H = relAlt", () => {
    const r = heightBetween(CAM, A, 0);
    expect(r!.heightM).toBeCloseTo(100, 9);
  });

  it("pitch_B > 0 (tall tree above the horizon): H > relAlt", () => {
    const r = heightBetween(CAM, A, slopeDeg(0.5));
    expect(r!.heightM - 0.5 * r!.distM).toBeCloseTo(100, 9);
  });

  it("short tree below the horizon: pitch_B < 0 with H > 0 is accepted", () => {
    const r = heightBetween(CAM, A, slopeDeg(-0.5));
    expect(r).not.toBeNull();
    expect(r!.heightM + 0.5 * r!.distM).toBeCloseTo(100, 9);
  });

  it("near the boundary: slope −0.89 (relAlt/d = 0.898) still measures", () => {
    const r = heightBetween(CAM, A, slopeDeg(-0.89));
    expect(r).not.toBeNull();
    expect(r!.heightM + 0.89 * r!.distM).toBeCloseTo(100, 9);
  });
});

describe("heightBetween — H ≤ 0 rejection", () => {
  it("slope steeper down than relAlt/d (B's ray hits ground nearer than A) rejects", () => {
    expect(heightBetween(CAM, A, slopeDeg(-0.91))).toBeNull();
  });

  it("far past the boundary: the user clicked a closer ground point", () => {
    expect(heightBetween(CAM, A, slopeDeg(-1.1))).toBeNull();
  });
});

describe("sigmaHeightM — error quadrature", () => {
  it("3-4-5: pitch term 3, d term 4 → 5 (pitch 45°: sec² = 2, tan = 1)", () => {
    // 40·2·0.0375 = 3 and 1·4 = 4.
    expect(sigmaHeightM(40, 45, 4, 0.0375)).toBeCloseTo(5, 9);
  });

  it("level pitch kills the d term (tan 0 = 0), σ_d never enters", () => {
    expect(sigmaHeightM(180, 0, 4, PITCH_ERR_RAD)).toBeCloseTo(180 * PITCH_ERR_RAD, 12);
  });

  it("σ_d = 0 leaves only the pitch term", () => {
    expect(sigmaHeightM(180, 0, 0, PITCH_ERR_RAD)).toBeCloseTo(180 * PITCH_ERR_RAD, 12);
  });

  it("below-horizon pitch: |tan| in quadrature, error stays positive", () => {
    // tan = −0.75 → d term −2.25; hypot folds the sign away.
    expect(sigmaHeightM(100, slopeDeg(-0.75), 3, 0)).toBeCloseTo(2.25, 9);
  });

  it("through heightBetween: default σ_pitch is the copy-record 0.1°", () => {
    const r = heightBetween(CAM, A, 0);
    expect(r!.errM).toBeCloseTo(r!.distM * PITCH_ERR_RAD, 12);
  });
});

describe("formatHeightChip — chip text", () => {
  it("the spec's example: H at 0.1 m, d HUD rounding, err 2 sig figs", () => {
    expect(formatHeightChip({ heightM: 23.5, distM: 180, errM: 2 })).toBe(
      "H 23.5 m · d 180 m · ±2 m",
    );
  });

  it("d rounds to the nearer 10 m (178 → 180), H to 0.1 m", () => {
    expect(formatHeightChip({ heightM: 23.46, distM: 178, errM: 2.13 })).toBe(
      "H 23.5 m · d 180 m · ±2.1 m",
    );
  });

  it("H rounds up across the integer (99.96 → 100.0)", () => {
    expect(formatHeightChip({ heightM: 99.96, distM: 100, errM: 1 })).toBe(
      "H 100.0 m · d 100 m · ±1 m",
    );
  });

  it("d caps beyond the 5 km HUD limit", () => {
    expect(formatHeightChip({ heightM: 5.02, distM: 6000, errM: 30 })).toBe(
      "H 5.0 m · d > 5 km · ±30 m",
    );
  });

  it("err ≥ 1 km collapses unit-clean", () => {
    expect(formatHeightChip({ heightM: 5.02, distM: 900, errM: 2288 })).toBe(
      "H 5.0 m · d 900 m · ±>1 km",
    );
  });
});
