/**
 * reference-build tests: ticket 17 visibility seeding + ticket 16 build
 * queue ordering.
 */
import { describe, expect, it } from "vitest";
import { buildQueue, seedVisibility } from "./reference-build.ts";
import { SLOW_LAYER_VERTEX_BUDGET } from "./reference-lod.ts";
import type { RefFeature, RefLayerPayload } from "./reference-layers.ts";

function pointFeature(): RefFeature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [124, 45] }, properties: {} };
}

function layer(name: string, vertices: number, featureCount = 1): RefLayerPayload {
  return {
    name,
    color: "#e69f00",
    labelProp: null,
    status: "ok",
    dropped: 0,
    vertices,
    features: {
      type: "FeatureCollection",
      features: Array.from({ length: featureCount }, pointFeature),
    },
  };
}

describe("seedVisibility (ticket 17)", () => {
  it("under-budget layers start visible, over-budget hidden", () => {
    const seeded = seedVisibility(
      [layer("light", SLOW_LAYER_VERTEX_BUDGET), layer("heavy", SLOW_LAYER_VERTEX_BUDGET + 1)],
      {},
    );
    expect(seeded).toEqual({ light: true, heavy: false });
  });

  it("a user's toggle survives a refetch reseed, in both directions", () => {
    const layers = [layer("heavy", 999_999), layer("light", 10)];
    const once = seedVisibility(layers, {});
    expect(once.heavy).toBe(false);
    const userEnabled = seedVisibility(layers, { ...once, heavy: true });
    expect(userEnabled.heavy).toBe(true);
    const userDisabled = seedVisibility(layers, { ...once, light: false });
    expect(userDisabled.light).toBe(false);
  });

  it("dropped layers disappear from the map", () => {
    const seeded = seedVisibility([layer("a", 1)], { a: true, gone: false });
    expect(seeded).toEqual({ a: true });
  });
});

describe("buildQueue (ticket 16)", () => {
  it("orders cheapest-first regardless of flag order", () => {
    const queue = buildQueue(
      [layer("monster", 999_999), layer("mid", 5_000), layer("tiny", 10)],
      {},
    );
    expect(queue.map((l) => l.name)).toEqual(["tiny", "mid", "monster"]);
  });

  it("skips hidden and empty layers", () => {
    const queue = buildQueue(
      [layer("hidden", 5), layer("empty", 3, 0), layer("shown", 7)],
      { hidden: false },
    );
    expect(queue.map((l) => l.name)).toEqual(["shown"]);
  });
});
