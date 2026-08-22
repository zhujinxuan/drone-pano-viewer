import { describe, expect, it } from "vitest";
import {
  estimateErrorM,
  formatCopyRecord,
  formatError,
  positionSigmaM,
  type CameraFix,
} from "./copy-record.ts";

// Spec: .scratch/target-coordinates/issues/01 (payload format, error model).
// Worked example from the ticket: yaw 349.3°, pitch -3.0°, dist 990 m,
// h ≈ 52 m → honest error ±40–60 m.

const gnss: CameraFix = { lat: 44.57108656, lon: 123.93047222, source: "gnss" };

describe("positionSigmaM", () => {
  it("uses the RTK σ when present, 3 m for plain GNSS, 20 m for geohash", () => {
    expect(positionSigmaM({ lat: 0, lon: 0, source: "rtk", rtkStd: 0.023 })).toBe(0.023);
    expect(positionSigmaM(gnss)).toBe(3);
    expect(positionSigmaM({ lat: 0, lon: 0, source: "geohash" })).toBe(20);
  });
});

describe("estimateErrorM", () => {
  it("matches the ticket's worked example at shallow pitch (±~55 m)", () => {
    // h = 990·tan(3°) = 51.884 m, δp = 0.1°, Δz = 1 m, σ = 3 m
    // → 33.09 (pitch) + 19.08 (terrain) + 3 (position) ≈ 55.2 m
    const err = estimateErrorM(51.884, (-3 * Math.PI) / 180, 3);
    expect(err).toBeGreaterThan(50);
    expect(err).toBeLessThan(60);
  });

  it("collapses to ~h·δp at nadir", () => {
    // h=120, straight down: pitch term 120·0.1° ≈ 0.21 m, terrain term → 0
    const err = estimateErrorM(120, -Math.PI / 2, 0.02);
    expect(err).toBeGreaterThan(0.15);
    expect(err).toBeLessThan(0.3);
  });

  it("explodes near the horizon", () => {
    const err = estimateErrorM(120, (-0.5 * Math.PI) / 180, 3);
    expect(err).toBeGreaterThan(1000);
  });
});

describe("formatError", () => {
  it("rounds to 2 significant figures", () => {
    expect(formatError(55.17)).toBe("55");
    expect(formatError(8.2)).toBe("8.2");
    expect(formatError(165)).toBe("170");
    expect(formatError(949)).toBe("950");
  });

  it("caps past the rounded 1000 m as '>1 km'", () => {
    expect(formatError(999)).toBe(">1 km");
    expect(formatError(2865)).toBe(">1 km");
  });
});

describe("formatCopyRecord", () => {
  it("renders the full record line from the ticket example", () => {
    const line = formatCopyRecord({
      id: "wzbjs1gm",
      fix: gnss,
      yawDeg: 349.3,
      pitchDeg: -3,
      fovDeg: 30,
      distText: "990 m (slant 990 m)",
      target: { lat: 44.57994321, lon: 123.92975432 },
      errorM: 55.17,
      northOffsetDeg: 0,
    });
    expect(line).toBe(
      "wzbjs1gm · cam 44.57109,123.93047 (GNSS ±3 m) · yaw 349.3° · pitch -3.0° · fov 30.0° · " +
        "dist 990 m (slant 990 m) · tgt 44.57994,123.92975 ±55 m",
    );
  });

  it("tags the camera source: RTK σ and geohash fallback", () => {
    const base = {
      id: "x",
      yawDeg: 0,
      pitchDeg: -45,
      fovDeg: 60,
      distText: "—",
      target: null,
      errorM: null,
      northOffsetDeg: 0,
    };
    expect(
      formatCopyRecord({ ...base, fix: { lat: 1, lon: 2, source: "rtk", rtkStd: 0.023 } }),
    ).toContain("cam 1.00000,2.00000 (RTK σ0.02 m)");
    expect(
      formatCopyRecord({ ...base, fix: { lat: 1, lon: 2, source: "geohash" } }),
    ).toContain("(geohash ±20 m)");
  });

  it("renders n/a when camera or target is unavailable", () => {
    const line = formatCopyRecord({
      id: "nogps-ab12",
      fix: null,
      yawDeg: 10,
      pitchDeg: 5,
      fovDeg: 90,
      distText: "—",
      target: null,
      errorM: null,
      northOffsetDeg: 0,
    });
    expect(line).toContain("cam n/a");
    expect(line).toContain("tgt n/a");
  });

  it("normalizes yaw into [0, 360) for the payload", () => {
    const line = formatCopyRecord({
      id: "x",
      fix: gnss,
      yawDeg: -10.7,
      pitchDeg: -3,
      fovDeg: 30,
      distText: "—",
      target: null,
      errorM: null,
      northOffsetDeg: 0,
    });
    expect(line).toContain("yaw 349.3°");
  });

  it("appends the signed north offset only when non-zero", () => {
    const base = {
      id: "x",
      fix: gnss,
      yawDeg: 0,
      pitchDeg: -45,
      fovDeg: 60,
      distText: "—",
      target: null,
      errorM: null,
    };
    expect(formatCopyRecord({ ...base, northOffsetDeg: 15 })).toContain(" · north+15.0°");
    expect(formatCopyRecord({ ...base, northOffsetDeg: -2.5 })).toContain(" · north-2.5°");
    expect(formatCopyRecord({ ...base, northOffsetDeg: 0 })).not.toContain("north");
  });
});
