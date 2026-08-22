import { describe, expect, it } from "vitest";
import { vincentyDirect } from "./geodesy.ts";

// Independent sources of truth:
//  - GeodTest-short.dat (GeographicLib, WGS84, computed with 100-digit Maxima
//    bfloats): lat1 lon1 azi1 -> lat2 lon2 for s12. Downloaded 2026-08-22.
//  - WGS84 defining constants: quarter meridian = 10001965.729 m exactly;
//    quarter equator = a·π/2 = 10018754.1715 m (geodesic stays on the equator).
//  - Textbook curvature radii at 45°N (independent of Vincenty's series):
//    M = a(1-e²)/(1-e²sin²φ)^1.5, N = a/√(1-e²sin²φ).

describe("vincentyDirect — GeodTest reference vectors", () => {
  it.each([
    // short geodesics (76–397 m, the feature's working range)
    [19.707097385334, 0, 20.996796804557, 76.1478894, 19.707739582810257, 0.000260256428101053],
    [23.104245923137, 0, 108.788775202534, 249.4508219, 23.103520430280492, 0.002305237470119087],
    [78.10174623178, 0, 124.870465352256, 397.364659, 78.099711031638792, 0.014156770744057927],
  ])("short: (%f, %f) bearing %f, %f m", (lat1, lon1, azi1, s12, lat2, lon2) => {
    const r = vincentyDirect(lat1, lon1, azi1, s12);
    expect(r.lat).toBeCloseTo(lat2, 9);
    expect(r.lon).toBeCloseTo(lon2, 9);
  });

  it.each([
    [36.530042355041, 0, 176.125875162171, 9398502.0434687, -48.16427077909777, 5.76234469467651],
    [63.758775485865, 0, 63.327049113388, 8337896.7811702, 25.179740339437206, 107.50499193289191],
  ])("long: (%f, %f) bearing %f, %f m", (lat1, lon1, azi1, s12, lat2, lon2) => {
    const r = vincentyDirect(lat1, lon1, azi1, s12);
    expect(r.lat).toBeCloseTo(lat2, 7);
    expect(r.lon).toBeCloseTo(lon2, 7);
  });
});

describe("vincentyDirect — WGS84 defining constants", () => {
  it("quarter meridian from the equator reaches the pole", () => {
    const r = vincentyDirect(0, 0, 0, 10001965.729);
    expect(r.lat).toBeCloseTo(90, 5);
  });

  it("quarter equator reaches longitude 90°E staying on the equator", () => {
    const r = vincentyDirect(0, 0, 90, (6378137 * Math.PI) / 2);
    expect(r.lat).toBeCloseTo(0, 8);
    expect(r.lon).toBeCloseTo(90, 6);
  });
});

describe("vincentyDirect — curvature anchors at 45°N", () => {
  // The textbook radii give the *local* rates; over 1 km the meridional
  // radius change shifts the latitude ~0.8 mm and an east-bound geodesic
  // sags off the parallel (~8 cm), so these corroborate at 1e-7 °, not tighter.
  it("1000 m due north advances latitude by ~1000/M(45°)", () => {
    const r = vincentyDirect(45, 123, 0, 1000);
    expect(r.lat - 45).toBeCloseTo(0.00899832634074692, 7);
    expect(r.lon).toBeCloseTo(123, 12);
  });

  it("1000 m due east advances longitude by ~1000/(N(45°)·cos45°)", () => {
    const r = vincentyDirect(45, 123, 90, 1000);
    expect(Math.abs(r.lat - 45)).toBeLessThan(2e-6); // geodesic sag, sub-meter
    expect(r.lon - 123).toBeCloseTo(0.012682817246983885, 8);
  });
});

describe("vincentyDirect — input handling", () => {
  it("normalizes bearings outside [0, 360)", () => {
    const a = vincentyDirect(45, 123, 349.3, 990);
    const b = vincentyDirect(45, 123, -10.7, 990);
    expect(a.lat).toBeCloseTo(b.lat, 12);
    expect(a.lon).toBeCloseTo(b.lon, 12);
  });

  it("returns the start point for zero distance", () => {
    const r = vincentyDirect(44.57108656, 123.930472215, 200, 0);
    expect(r.lat).toBeCloseTo(44.57108656, 12);
    expect(r.lon).toBeCloseTo(123.930472215, 12);
  });
});
