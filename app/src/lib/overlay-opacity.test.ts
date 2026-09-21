import { describe, expect, it } from "vitest";
import {
  OPACITY_DEFAULT,
  OPACITY_MAX,
  OPACITY_MIN,
  clampMultiplier,
  effectiveAlpha,
  parseStoredMultiplier,
  stepMultiplier,
} from "./overlay-opacity.ts";

// Independent anchors: the 10% grid (0.1..3.0), the three.js opacity
// ceiling at 1, and the spec's own worked numbers (stroke 0.8, fill 0.15,
// chip "Overlay 140%").

describe("clampMultiplier — quantize + clamp onto the 10% grid", () => {
  it.each([
    [1, 1], // already on grid
    [1.04, 1], // below half-step rounds down
    [1.05, 1.1], // half-step rounds up
    [1.7000000000000002, 1.7], // float dust from repeated stepping
    [0.7999999999999999, 0.8],
    [0.05, OPACITY_MIN], // clamps up to the floor
    [-3, OPACITY_MIN],
    [3.0001, OPACITY_MAX], // clamps down to the ceiling
    [50, OPACITY_MAX],
  ])("%p → %f", (input, expected) => {
    expect(clampMultiplier(input)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])("non-finite %p → default 100%%", (input) => {
    expect(clampMultiplier(input)).toBe(OPACITY_DEFAULT);
  });

  it("output never carries float dust (chip prints exact percents)", () => {
    // Walk the whole range; every value must sit exactly on the grid.
    let m = OPACITY_MIN;
    while (m < OPACITY_MAX) {
      const stepped = stepMultiplier(m, 1);
      expect(stepped * 10).toBe(Math.round(stepped * 10));
      m = stepped;
    }
  });
});

describe("stepMultiplier — one notch, ±10%, clamped at the ends", () => {
  it.each([
    [1, 1, 1.1], // up
    [1.1, -1, 1], // down
    [0.7, 1, 0.8], // 0.7+0.1 === 0.799999… must quantize back to 0.8
    [2.9, 1, 3],
    [OPACITY_MIN, -1, OPACITY_MIN], // pinned at the floor
    [OPACITY_MAX, 1, OPACITY_MAX], // pinned at the ceiling
  ])("%f %+d → %f", (current, dir, expected) => {
    expect(stepMultiplier(current, dir as 1 | -1)).toBe(expected);
  });
});

describe("effectiveAlpha — base × multiplier, capped at 1", () => {
  it.each([
    [0.8, 1, 0.8], // 100% = today's rendering
    [0.15, 1, 0.15],
    [0.8, 3, 1], // 2.4 caps at the ceiling
    [0.95, 3, 1],
    [0.15, 3, 0.45], // under the ceiling it scales freely
    [0.75, 2, 1], // 1.5 caps
    [0.8, 0.1, 0.8 * 0.1], // floor multiplier: near-transparent, not zero
    [0.15, 0.1, 0.015],
  ])("base %f × %f → %f", (base, multiplier, expected) => {
    expect(effectiveAlpha(base, multiplier)).toBeCloseTo(expected, 15);
  });
});

describe("parseStoredMultiplier — reload restores, garbage degrades to 100%", () => {
  it.each([
    [null, OPACITY_DEFAULT], // fresh profile
    ["1.4", 1.4],
    ["0.1", OPACITY_MIN],
    ["3", OPACITY_MAX],
    ["1.23", 1.2], // off-grid quantizes
    ["0.05", OPACITY_MIN], // out of range clamps
    ["9", OPACITY_MAX],
    ["abc", OPACITY_DEFAULT],
    ["", OPACITY_DEFAULT],
  ])("%j → %f", (raw, expected) => {
    expect(parseStoredMultiplier(raw)).toBe(expected);
  });
});
