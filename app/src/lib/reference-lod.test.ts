/**
 * reference-lod tests (ticket 14): ground-space DP correctness + the far
 * geometry contract, and the band verdict from reference-cull.
 */
import { describe, expect, it } from "vitest";
import { entryIsFar, cullEntry } from "./reference-cull.ts";
import {
  FAR_LOD_EPS_M,
  NEAR_BAND_M,
  SLOW_LAYER_VERTEX_BUDGET,
  lodGeometry,
  simplifyGroundM,
} from "./reference-lod.ts";
import { mPerDegLat, mPerDegLon } from "./reference-layers.ts";
import type { RefPosition } from "./reference-layers.ts";

/** ~45°N site (松原): plain numbers keep the geometry readable. */
const LAT = 45.0;
const LON = 124.0;

/** Offset a base point by east/north meters into [lon, lat]. */
function at(eastM: number, northM: number): RefPosition {
  const latRad = (LAT * Math.PI) / 180;
  return [LON + eastM / mPerDegLon(latRad), LAT + northM / mPerDegLat(latRad)];
}

/** Perpendicular distance of p to segment ab in planar meters at LAT. */
function distToSegmentM(p: RefPosition, a: RefPosition, b: RefPosition): number {
  const latRad = (LAT * Math.PI) / 180;
  const sx = mPerDegLon(latRad);
  const sy = mPerDegLat(latRad);
  const px = (p[0] - LON) * sx;
  const py = (p[1] - LAT) * sy;
  const ax = (a[0] - LON) * sx;
  const ay = (a[1] - LAT) * sy;
  const bx = (b[0] - LON) * sx;
  const by = (b[1] - LAT) * sy;
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * abx, py - ay - t * aby);
}

describe("simplifyGroundM", () => {
  it("keeps endpoints and collapses a collinear run to them", () => {
    const line: RefPosition[] = [];
    for (let i = 0; i <= 100; i++) line.push(at(i * 10, 0)); // 1 km straight east
    const kept = simplifyGroundM(line, false, FAR_LOD_EPS_M);
    expect(kept).toEqual([0, 100]);
  });

  it("bounds the deviation of every dropped vertex by ε", () => {
    // A zigzag with random-ish offsets; verify the DP contract directly.
    const line: RefPosition[] = [];
    let y = 0;
    for (let i = 0; i < 500; i++) {
      y += ((i * 37) % 11) - 5; // deterministic pseudo-noise, ±~25 m wander
      line.push(at(i * 4, y));
    }
    const kept = simplifyGroundM(line, false, FAR_LOD_EPS_M);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(line.length - 1);
    for (let s = 0; s < kept.length - 1; s++) {
      const a = line[kept[s]!]!;
      const b = line[kept[s + 1]!]!;
      for (let i = kept[s]! + 1; i < kept[s + 1]!; i++) {
        expect(distToSegmentM(line[i]!, a, b)).toBeLessThanOrEqual(FAR_LOD_EPS_M + 1e-9);
      }
    }
  });

  it("closed rings keep ≥ 3 vertices even when fully sub-ε", () => {
    // A 2 m-wide square — every vertex within 3 m of any chord.
    const ring = [at(0, 0), at(2, 0), at(2, 2), at(0, 2)];
    const kept = simplifyGroundM(ring, true, FAR_LOD_EPS_M);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(ring.length - 1);
  });

  it("open lines keep ≥ 2 vertices; tiny inputs pass through", () => {
    expect(simplifyGroundM([at(0, 0)], false, 3)).toEqual([0]);
    expect(simplifyGroundM([at(0, 0), at(100, 0)], false, 3)).toEqual([0, 1]);
    expect(simplifyGroundM([], true, 3)).toEqual([]);
  });

  it("keeps vertices that stick out beyond ε", () => {
    // Straight 1 km line with one 10 m spike in the middle.
    const line: RefPosition[] = [];
    for (let i = 0; i <= 100; i++) line.push(at(i * 10, i === 50 ? 10 : 0));
    const kept = simplifyGroundM(line, false, FAR_LOD_EPS_M);
    expect(kept).toContain(50);
  });
});

describe("lodGeometry", () => {
  it("returns the same object when nothing drops (identity = no copy)", () => {
    const small = {
      type: "Polygon" as const,
      coordinates: [[at(0, 0), at(50, 0), at(50, 50), at(0, 50), at(0, 0)]],
    };
    expect(lodGeometry(small)).toBe(small);
  });

  it("passes points through by identity", () => {
    const p = { type: "Point" as const, coordinates: at(10, 10) };
    expect(lodGeometry(p)).toBe(p);
  });

  it("collapses a dense collinear ring to its corners, unclosed", () => {
    // 10 km square with a vertex every meter on each edge (40 k vertices).
    const ring: RefPosition[] = [];
    for (let i = 0; i < 10000; i++) ring.push(at(i, 0));
    for (let i = 0; i < 10000; i++) ring.push(at(10000, i));
    for (let i = 0; i < 10000; i++) ring.push(at(10000 - i, 10000));
    for (let i = 0; i < 10000; i++) ring.push(at(0, 10000 - i));
    ring.push(ring[0]!); // written closed
    const geom = { type: "Polygon" as const, coordinates: [ring] };
    const lod = lodGeometry(geom);
    expect(lod).not.toBe(geom);
    if (lod.type !== "Polygon") throw new Error("unreachable");
    expect(lod.coordinates[0]!.length).toBeLessThanOrEqual(8); // 4 corners, maybe edge midpoints
    // Unclosed on output: first ≠ last unless the ring genuinely revisits.
    const out = lod.coordinates[0]!;
    expect(out[0]).not.toEqual(out[out.length - 1]);
  });

  it("simplifies LineStrings and keeps ≥ 2 vertices", () => {
    const line: RefPosition[] = [];
    for (let i = 0; i <= 1000; i++) line.push(at(i, 0));
    const lod = lodGeometry({ type: "LineString", coordinates: line });
    if (lod.type !== "LineString") throw new Error("unreachable");
    expect(lod.coordinates.length).toBe(2);
  });
});

describe("entryIsFar band verdict", () => {
  const cam = { lat: LAT, lon: LON };

  it("a feature with a vertex inside the band is near", () => {
    const entry = cullEntry({
      type: "Polygon",
      coordinates: [[at(50, 0), at(500, 0), at(500, 500), at(50, 500)]],
    });
    expect(entryIsFar(cam, entry)).toBe(false);
  });

  it("a feature with every vertex beyond the band is far", () => {
    const entry = cullEntry({
      type: "Polygon",
      coordinates: [[at(300, 300), at(400, 300), at(400, 400), at(300, 400)]],
    });
    expect(entryIsFar(cam, entry)).toBe(true);
  });

  it("bbox fast path: a feature wholly beyond the band never scans vertices", () => {
    // 68 k-vertex ring 5 km away — far regardless of vertex count.
    const ring: RefPosition[] = [];
    for (let i = 0; i < 17000; i++) ring.push(at(5000 + i * 0.5, 5000));
    for (let i = 0; i < 17000; i++) ring.push(at(5000 + 8500, 5000 + i * 0.5));
    for (let i = 0; i < 17000; i++) ring.push(at(5000 + 8500 - i * 0.5, 5000 + 8500));
    for (let i = 0; i < 17000; i++) ring.push(at(5000, 5000 + 8500 - i * 0.5));
    const entry = cullEntry({ type: "Polygon", coordinates: [ring] });
    expect(entryIsFar(cam, entry)).toBe(true);
  });

  it("a camera inside the feature's bbox scans and finds the near vertex", () => {
    // Ring whose bbox spans the camera but whose nearest vertex is 300 m out.
    const entry = cullEntry({
      type: "LineString",
      coordinates: [at(-1000, 300), at(1000, 300)],
    });
    expect(entryIsFar(cam, entry)).toBe(true); // all vertices 300 m north
    const near = cullEntry({
      type: "LineString",
      coordinates: [at(0, 150), at(1000, 300)],
    });
    expect(entryIsFar(cam, near)).toBe(false); // one vertex at 150 m
  });

  it("default band is the ticket-14 constant and budgets stay ordered", () => {
    expect(NEAR_BAND_M).toBe(200);
    expect(FAR_LOD_EPS_M).toBe(3);
    expect(SLOW_LAYER_VERTEX_BUDGET).toBeLessThan(200_000);
  });
});
