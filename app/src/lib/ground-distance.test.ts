import { describe, expect, it } from "vitest";
import { formatDistance, formatDistanceHud, groundDistance } from "./ground-distance.ts";

// Worked examples from .scratch/ground-distance/issues/01 acceptance criteria.
// h = RelativeAltitude (m, above takeoff), pitch negative = looking down.

describe("groundDistance", () => {
  it("returns horizontal and slant range for a downward pitch", () => {
    // h=100, 45° down: horizontal = 100/tan(45°) = 100, slant = 100/sin(45°) ≈ 141.42
    const g = groundDistance(100, -Math.PI / 4);
    expect(g).not.toBeNull();
    expect(g!.horizontal).toBeCloseTo(100, 6);
    expect(g!.slant).toBeCloseTo(141.4213562, 6);
  });

  it("gives horizontal 0 and slant = h at nadir", () => {
    const g = groundDistance(120, -Math.PI / 2);
    expect(g).not.toBeNull();
    expect(g!.horizontal).toBeCloseTo(0, 6);
    expect(g!.slant).toBeCloseTo(120, 6);
  });

  it("returns null at or above the horizon (ray never meets flat ground)", () => {
    expect(groundDistance(100, 0)).toBeNull();
    expect(groundDistance(100, 0.3)).toBeNull();
  });

  it("returns null for missing or negative altitude (plane above camera)", () => {
    expect(groundDistance(null, -0.5)).toBeNull();
    expect(groundDistance(undefined, -0.5)).toBeNull();
    expect(groundDistance(NaN, -0.5)).toBeNull();
    expect(groundDistance(-50, -0.5)).toBeNull();
  });

  it("computes 0 m when the camera sits on the ground plane", () => {
    expect(groundDistance(0, -0.5)).toEqual({ horizontal: 0, slant: 0 });
  });
});

describe("formatDistance", () => {
  it("rounds to 10 m under the cap", () => {
    expect(formatDistance(847)).toBe("850 m");
    expect(formatDistance(312)).toBe("310 m");
    expect(formatDistance(0)).toBe("0 m");
  });

  it("caps anything over 5000 m as '> 5 km'", () => {
    expect(formatDistance(5000)).toBe("5000 m");
    expect(formatDistance(5000.1)).toBe("> 5 km");
  });
});

describe("formatDistanceHud", () => {
  it("renders a dash when there is no intersection", () => {
    expect(formatDistanceHud(null)).toBe("—");
  });

  it("renders horizontal primary with slant secondary", () => {
    expect(formatDistanceHud({ horizontal: 847, slant: 940.2 })).toBe("850 m (slant 940 m)");
  });

  it("caps each number independently — slant can cap while horizontal doesn't", () => {
    expect(formatDistanceHud({ horizontal: 4800, slant: 5100 })).toBe("4800 m (slant > 5 km)");
    expect(formatDistanceHud({ horizontal: 6000, slant: 6100 })).toBe("> 5 km (slant > 5 km)");
  });
});
