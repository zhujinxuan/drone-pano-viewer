import { describe, expect, it } from "vitest";
import { formatMeasureChip, measureBetween } from "./measure.ts";

// Independent sources of truth (mirrors geodesy.test.ts):
//  - GeodTest-short.dat / GeodTest-long.dat rows (GeographicLib, WGS84,
//    100-digit Maxima bfloats): lat1 lon1 azi1 s12 lat2 lon2. The A→B pair
//    must recover s12 and the forward azimuth azi1.
//  - WGS84 defining constant: quarter equator = a·π/2 = 10018754.1715 m,
//    geodesic stays on the parallel, bearing due east.
//  - 3-4-5 worked example for independent-error quadrature.

describe("measureBetween — GeodTest reference vectors", () => {
  it.each([
    // short geodesics (76–397 m, the feature's working range)
    [19.707097385334, 0, 20.996796804557, 76.1478894, 19.707739582810257, 0.000260256428101053],
    [23.104245923137, 0, 108.788775202534, 249.4508219, 23.103520430280492, 0.002305237470119087],
    [78.10174623178, 0, 124.870465352256, 397.364659, 78.099711031638792, 0.014156770744057927],
  ])("short: (%f, %f) → (%f, %f)", (lat1, lon1, azi1, s12, lat2, lon2) => {
    const r = measureBetween({ lat: lat1, lon: lon1, errDiffM: 0 }, { lat: lat2, lon: lon2, errDiffM: 0 });
    expect(r.distanceM).toBeCloseTo(s12, 4);
    expect(r.bearingDeg).toBeCloseTo(azi1, 8);
  });

  it.each([
    [36.530042355041, 0, 176.125875162171, 9398502.0434687, -48.16427077909777, 5.76234469467651],
    [63.758775485865, 0, 63.327049113388, 8337896.7811702, 25.179740339437206, 107.50499193289191],
  ])("long: (%f, %f) → (%f, %f)", (lat1, lon1, azi1, s12, lat2, lon2) => {
    const r = measureBetween({ lat: lat1, lon: lon1, errDiffM: 0 }, { lat: lat2, lon: lon2, errDiffM: 0 });
    expect(r.distanceM).toBeCloseTo(s12, 3);
    expect(r.bearingDeg).toBeCloseTo(azi1, 8);
  });
});

describe("measureBetween — WGS84 defining constants", () => {
  it("quarter equator east along the parallel, due east", () => {
    const r = measureBetween({ lat: 0, lon: 0, errDiffM: 0 }, { lat: 0, lon: 90, errDiffM: 0 });
    expect(r.distanceM).toBeCloseTo(10018754.17, 1);
    expect(r.bearingDeg).toBeCloseTo(90, 9);
  });

  it("coincident endpoints give zero distance (bearing defined as 0)", () => {
    const r = measureBetween(
      { lat: 44.57108656, lon: 123.930472215, errDiffM: 1 },
      { lat: 44.57108656, lon: 123.930472215, errDiffM: 2 },
    );
    expect(r.distanceM).toBe(0);
    expect(r.bearingDeg).toBe(0);
  });
});

describe("measureBetween — endpoint error propagation", () => {
  it("independent endpoint errors combine in quadrature (3-4-5)", () => {
    const r = measureBetween({ lat: 0, lon: 0, errDiffM: 3 }, { lat: 0, lon: 0.001, errDiffM: 4 });
    expect(r.errM).toBeCloseTo(5, 9);
  });

  it("one errorless endpoint leaves the other's error intact", () => {
    const r = measureBetween({ lat: 0, lon: 0, errDiffM: 0 }, { lat: 0, lon: 0.001, errDiffM: 7.5 });
    expect(r.errM).toBeCloseTo(7.5, 9);
  });

  it("two errorless endpoints carry no error", () => {
    const r = measureBetween({ lat: 0, lon: 0, errDiffM: 0 }, { lat: 0, lon: 0.001, errDiffM: 0 });
    expect(r.errM).toBe(0);
  });
});

describe("formatMeasureChip — chip text", () => {
  it("10 m distance rounding, 1 dp bearing, 2 sig fig err", () => {
    expect(formatMeasureChip({ distanceM: 1234.6, bearingDeg: 137.5, errM: 12.34 })).toBe(
      "1230 m · 137.5° · ±12 m",
    );
  });

  it("rounds to the nearer 10 m (125 → 130)", () => {
    expect(formatMeasureChip({ distanceM: 125, bearingDeg: 0, errM: 1 })).toBe(
      "130 m · 0.0° · ±1 m",
    );
  });

  it("zero distance still renders 0 m", () => {
    expect(formatMeasureChip({ distanceM: 0, bearingDeg: 0, errM: 2.5 })).toBe(
      "0 m · 0.0° · ±2.5 m",
    );
  });

  it("caps beyond the 5 km HUD limit", () => {
    expect(formatMeasureChip({ distanceM: 6000, bearingDeg: 90, errM: 30 })).toBe(
      "> 5 km · 90.0° · ±30 m",
    );
  });

  it("bearing rounds to 360.0 at 1 dp (359.96)", () => {
    expect(formatMeasureChip({ distanceM: 100, bearingDeg: 359.96, errM: 3 })).toBe(
      "100 m · 360.0° · ±3 m",
    );
  });

  it("2 sig fig err keeps its m unit, ≥1 km collapses unit-clean", () => {
    expect(formatMeasureChip({ distanceM: 900, bearingDeg: 10, errM: 345.6 })).toBe(
      "900 m · 10.0° · ±350 m",
    );
    expect(formatMeasureChip({ distanceM: 4600, bearingDeg: 10, errM: 2288 })).toBe(
      "4600 m · 10.0° · ±>1 km",
    );
  });
});
