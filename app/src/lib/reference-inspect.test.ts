import { describe, expect, it } from "vitest";
import {
  nearestInspectFeature,
  type InspectCandidate,
  type ScreenPoint,
} from "./reference-inspect.ts";

// Spec: .scratch/reference-layers/spec.md §Client behavior (click-inspect),
// ticket 04. Pure screen-space math: the overlay projects every candidate
// feature's vertices to viewer pixels (frustum-filtered) and asks this lib
// which feature — if any — a drag-guarded click landed on. Nearest stroke
// within the pixel threshold wins; ties keep the earlier layer order
// (stable, so the toolbar's topmost row wins visual ties).

/** Candidate whose paths are hand-projected constants (px). */
function cand(
  layerName: string,
  paths: ReadonlyArray<readonly ScreenPoint[]>,
  closed = false,
  properties: Record<string, unknown> = { name: layerName },
): InspectCandidate {
  return {
    layerName,
    color: "#123456",
    properties,
    paths: paths.map((points) => ({ points, closed })),
  };
}

describe("nearestInspectFeature", () => {
  it("hits a single-point path (a Point feature) within the threshold", () => {
    const hit = nearestInspectFeature(
      { x: 103, y: 52 },
      [cand("turbines", [[{ x: 100, y: 50 }]])],
      12,
    );
    expect(hit).not.toBeNull();
    expect(hit?.layerName).toBe("turbines");
    expect(hit?.properties).toEqual({ name: "turbines" });
  });

  it("returns null when the only candidate is beyond the threshold", () => {
    expect(
      nearestInspectFeature({ x: 200, y: 200 }, [cand("t", [[{ x: 100, y: 50 }]])], 12),
    ).toBeNull();
  });

  it("hits a line mid-segment, where no vertex is anywhere near the click", () => {
    // A 300 px horizontal stroke: the click sits between the two vertices.
    const line = cand("route", [
      [
        { x: 100, y: 300 },
        { x: 400, y: 300 },
      ],
    ]);
    expect(nearestInspectFeature({ x: 250, y: 306 }, [line], 12)).not.toBeNull();
    expect(nearestInspectFeature({ x: 250, y: 316 }, [line], 12)).toBeNull();
  });

  it("tests the wrap segment only on closed paths (polygon rings)", () => {
    const ring = [
      { x: 100, y: 100 },
      { x: 160, y: 100 },
      { x: 160, y: 160 },
    ];
    // The closing edge runs from (160,160) back to (100,100): the click at
    // (130,130) is 0 px from it but ≥ 42 px from every vertex.
    const closed = cand("zone", [ring], true);
    expect(nearestInspectFeature({ x: 130, y: 130 }, [closed], 12)).not.toBeNull();
    // Open polyline: that same click must NOT hit — no wrap edge exists.
    const open = cand("route", [ring], false);
    expect(nearestInspectFeature({ x: 130, y: 130 }, [open], 12)).toBeNull();
  });

  it("picks the nearest candidate across layers", () => {
    const near = cand("near", [[{ x: 100, y: 100 }]]);
    const far = cand("far", [[{ x: 100, y: 110 }]]);
    expect(nearestInspectFeature({ x: 101, y: 100 }, [far, near], 12)?.layerName).toBe("near");
  });

  it("keeps the first candidate on an exact tie (stable layer order)", () => {
    const a = cand("a", [[{ x: 90, y: 100 }]]);
    const b = cand("b", [[{ x: 110, y: 100 }]]);
    expect(nearestInspectFeature({ x: 100, y: 100 }, [a, b], 10)?.layerName).toBe("a");
  });

  it("accepts a hit exactly at the threshold (inclusive boundary)", () => {
    expect(
      nearestInspectFeature({ x: 112, y: 0 }, [cand("t", [[{ x: 100, y: 0 }]])], 12),
    ).not.toBeNull();
  });

  it("survives degenerate input: empty list, empty paths, zero-length segments", () => {
    expect(nearestInspectFeature({ x: 0, y: 0 }, [], 12)).toBeNull();
    expect(nearestInspectFeature({ x: 0, y: 0 }, [cand("e", [[]])], 12)).toBeNull();
    // Duplicate consecutive vertices make a zero-length segment: the click
    // 5 px away must still measure 5, not NaN.
    const dup = cand("d", [
      [
        { x: 100, y: 100 },
        { x: 100, y: 100 },
      ],
    ]);
    expect(nearestInspectFeature({ x: 105, y: 100 }, [dup], 12)).not.toBeNull();
  });

  it("checks every path of a multi-path candidate (polygon with a hole)", () => {
    const poly = cand("zone", [
      [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 },
      ],
      [
        { x: 40, y: 45 },
        { x: 60, y: 45 },
      ],
    ], true);
    // On the hole's edge — second path, not the exterior ring.
    expect(nearestInspectFeature({ x: 50, y: 47 }, [poly], 5)).not.toBeNull();
  });
});
