import { describe, expect, it } from "vitest";
import {
  createEntity,
  deleteEntity,
  emptyCollection,
  forPhoto,
  newAnnId,
  parseAnnotations,
  relabelEntity,
  serializeAnnotations,
} from "./annotations.ts";
import type { AnnCam, AnnDraft, AnnFeature, AnnProperties } from "./annotations.ts";

// Spec: .scratch/annotations/spec.md (schema version 1) and ticket
// .scratch/annotations/issues/01-annotation-lib.md. The in-memory model keeps
// polygon rings unclosed; only serializeAnnotations closes them.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const T0 = 1_755_947_000_000; // fixed clock for deterministic timestamps
const CAM: AnnCam = { lat: 44.9, lon: 125.1, src: "GNSS ±3 m", relAltM: 112.5 };

describe("newAnnId", () => {
  it("formats as ann- + 26 chars of Crockford base32", () => {
    expect(newAnnId()).toMatch(/^ann-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it("encodes the creation timestamp in the first 10 chars", () => {
    const before = Date.now();
    const id = newAnnId();
    const after = Date.now();
    let ms = 0;
    for (const ch of id.slice(4, 14)) ms = ms * 32 + CROCKFORD.indexOf(ch);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("sorts lexically by creation order, including within the same ms", () => {
    const t = Date.now();
    const ids = Array.from({ length: 50 }, () => newAnnId(t));
    expect([...ids].sort()).toEqual(ids); // creation order == lexical order
    expect(newAnnId(t - 1000) < newAnnId(t)).toBe(true);
  });

  it("is unique over 10 000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newAnnId());
    expect(seen.size).toBe(10_000);
  });
});

describe("parseAnnotations", () => {
  it("returns the empty collection for garbage input, never throwing", () => {
    const garbage: unknown[] = [
      null,
      42,
      "[]",
      {},
      { type: "FeatureCollection" },
      { type: "FeatureCollection", features: "x" },
    ];
    for (const input of garbage) {
      expect(parseAnnotations(input)).toEqual(emptyCollection());
    }
  });

  it("keeps well-formed features and drops structurally invalid ones", () => {
    const bad: unknown[] = [
      { type: "Feature", geometry: { type: "MultiPoint", coordinates: [[1, 1]] }, properties: props() },
      { type: "Feature", geometry: { type: "Point", coordinates: "1,2" }, properties: props() },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { ...props(), id: undefined } },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { ...props(), kind: "circle" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } },
    ];
    const parsed = parseAnnotations({
      type: "FeatureCollection",
      version: 1,
      features: [wellFormedPoint(), ...bad],
    });
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0]?.properties.id).toBe("ann-01J8KQ3M7V9W2X4Y5Z6A8B0C1D");
  });

  it("preserves unknown top-level members and unknown feature properties", () => {
    const parsed = parseAnnotations({
      type: "FeatureCollection",
      version: 1,
      generator: "pano 1.2.3",
      features: [{ ...wellFormedPoint(), bbox: [123.9, 44.5, 124.0, 44.6] }],
    });
    expect(parsed.generator).toBe("pano 1.2.3");
    expect(parsed.features[0]?.bbox).toEqual([123.9, 44.5, 124.0, 44.6]);
    expect(parsed.features[0]?.properties.custom).toBe("keep me");
  });

  it("uncloses polygon rings read from disk", () => {
    const parsed = parseAnnotations({
      type: "FeatureCollection",
      version: 1,
      features: [closedPolygon()],
    });
    const geometry = parsed.features[0]?.geometry;
    expect(geometry?.type).toBe("Polygon");
    if (geometry?.type === "Polygon") {
      expect(geometry.coordinates[0]).toEqual([
        [0, 0],
        [1, 0],
        [1, 1],
      ]);
    }
  });
});

describe("serializeAnnotations", () => {
  it("writes version 1, pretty-printed 2-space JSON", () => {
    const text = serializeAnnotations({ ...emptyCollection(), features: [wellFormedPoint()] });
    const rounded: AnnFeature = {
      ...wellFormedPoint(),
      geometry: { type: "Point", coordinates: [123.9304722, 44.5710866] },
    };
    expect(text).toBe(
      JSON.stringify({ type: "FeatureCollection", version: 1, features: [rounded] }, null, 2),
    );
  });

  it("rounds all coordinates to 7 decimals", () => {
    const text = serializeAnnotations({
      ...emptyCollection(),
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [123.93047222444, 44.57108656555] },
          properties: props(),
        },
      ],
    });
    expect(text).toContain("123.9304722");
    expect(text).toContain("44.5710866"); // 56555 → rounds up
    expect(text).not.toContain("123.93047222444");
  });

  it("closes polygon rings on write and keeps them unclosed in memory", () => {
    const feature = closedPolygon();
    // Simulate the in-memory unclosed state: strip the closing vertex first.
    feature.geometry.coordinates[0] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const written = JSON.parse(serializeAnnotations({ ...emptyCollection(), features: [feature] }));
    const ring = written.features[0].geometry.coordinates[0];
    expect(ring).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
    // In-memory feature stays unclosed — serialize must not mutate its input.
    expect(feature.geometry.coordinates[0]).toHaveLength(3);
  });

  it("round-trips unknown members through serialize → parse losslessly", () => {
    const collection = {
      ...emptyCollection(),
      generator: "pano 1.2.3",
      features: [{ ...closedPolygon(), bbox: [0, 0, 1, 1] }],
    };
    const round = parseAnnotations(JSON.parse(serializeAnnotations(collection)));
    expect(round).toEqual(collection);
  });
});

describe("store ops", () => {
  it("createEntity assigns an ann-ULID, birth timestamps, and the auto-name Point N", () => {
    const { collection, feature } = createEntity(
      emptyCollection(),
      {
        kind: "point",
        photo: "wzbjs1gm",
        photoTitle: "FS3 · 机位北側",
        cam: CAM,
        vertices: [[123.9304722, 44.5710866]],
        vertexErrM: [4],
      },
      T0,
    );
    expect(feature.properties.id).toMatch(/^ann-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(feature.properties.label).toBe("Point 1");
    expect(feature.properties.created).toBe(new Date(T0).toISOString());
    expect(feature.properties.updated).toBe(feature.properties.created);
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [123.9304722, 44.5710866] });
    expect(collection.features).toEqual([feature]);
  });

  it("auto-names per kind and per photo, keeping user labels untouched", () => {
    let { collection } = createEntity(emptyCollection(), pointDraft("wzbjs1gm"), T0);
    ({ collection } = createEntity(collection, pointDraft("wzbjs1gm"), T0));
    ({ collection } = createEntity(collection, lineDraft("wzbjs1gm"), T0));
    ({ collection } = createEntity(collection, pointDraft("other1ph"), T0));
    const { collection: withLabel } = createEntity(
      collection,
      { ...pointDraft("wzbjs1gm"), label: "北侧山脊线" },
      T0,
    );
    expect(withLabel.features.map((f) => f.properties.label)).toEqual([
      "Point 1",
      "Point 2",
      "Line 1",
      "Point 1",
      "北侧山脊线",
    ]);
  });

  it("stores polygon rings unclosed and enforces vertex-count minimums", () => {
    const { feature } = createEntity(emptyCollection(), polygonDraft(), T0);
    if (feature.geometry.type === "Polygon") {
      expect(feature.geometry.coordinates[0]).toEqual([
        [0, 0],
        [1, 0],
        [1, 1],
      ]);
    }
    expect(() => createEntity(emptyCollection(), { ...pointDraft("wzbjs1gm"), vertices: [] }, T0)).toThrow();
    expect(() => createEntity(emptyCollection(), { ...lineDraft("wzbjs1gm"), vertices: [[0, 0]] }, T0)).toThrow();
    expect(() =>
      createEntity(emptyCollection(), { ...polygonDraft(), vertices: [[0, 0], [1, 0]] }, T0),
    ).toThrow();
  });

  it("relabel keeps id and created, bumps updated, changes nothing else", () => {
    const { collection, feature } = createEntity(emptyCollection(), pointDraft("wzbjs1gm"), T0);
    const relabeled = relabelEntity(collection, feature.properties.id, "新名字", T0 + 5_000);
    const after = relabeled.features[0]?.properties;
    expect(after?.label).toBe("新名字");
    expect(after?.id).toBe(feature.properties.id);
    expect(after?.created).toBe(feature.properties.created);
    expect(after?.updated).toBe(new Date(T0 + 5_000).toISOString());
    expect(relabeled.features[0]?.geometry).toEqual(feature.geometry);
    // Original collection untouched (pure ops).
    expect(collection.features[0]?.properties.label).toBe("Point 1");
  });

  it("relabel and delete on an unknown id are no-ops", () => {
    const { collection } = createEntity(emptyCollection(), pointDraft("wzbjs1gm"), T0);
    expect(relabelEntity(collection, "ann-nope", "x", T0)).toBe(collection);
    expect(deleteEntity(collection, "ann-nope")).toBe(collection);
  });

  it("delete then re-add yields a different id", () => {
    const { collection, feature } = createEntity(emptyCollection(), pointDraft("wzbjs1gm"), T0);
    const afterDelete = deleteEntity(collection, feature.properties.id);
    expect(afterDelete.features).toHaveLength(0);
    const { collection: readded, feature: readdedFeature } = createEntity(
      afterDelete,
      pointDraft("wzbjs1gm"),
      T0 + 1,
    );
    expect(readded.features).toHaveLength(1);
    expect(readdedFeature.properties.id).not.toBe(feature.properties.id);
    // Counter follows the current count: after delete it is Point 1 again
    // (label reuse is fine — the id is what must never be reused).
    expect(readdedFeature.properties.label).toBe("Point 1");
  });

  it("forPhoto returns the current-photo subset in file order", () => {
    let { collection } = createEntity(emptyCollection(), pointDraft("wzbjs1gm"), T0);
    ({ collection } = createEntity(collection, pointDraft("other1ph"), T0));
    ({ collection } = createEntity(collection, lineDraft("wzbjs1gm"), T0));
    expect(forPhoto(collection, "wzbjs1gm").map((f) => f.properties.kind)).toEqual(["point", "line"]);
    expect(forPhoto(collection, "nobody")).toEqual([]);
  });
});

// ---- fixtures -------------------------------------------------------------

function props(): AnnProperties {
  return {
    id: "ann-01J8KQ3M7V9W2X4Y5Z6A8B0C1D",
    kind: "point",
    label: "北侧山脊线",
    photo: "wzbjs1gm",
    photoTitle: "FS3 · 机位北側",
    created: "2026-08-23T10:42:11.000Z",
    updated: "2026-08-23T10:42:11.000Z",
    cam: { lat: 44.9, lon: 125.1, src: "GNSS ±3 m", relAltM: 112.5 },
    vertexErrM: [4, 5, 6],
    custom: "keep me",
  };
}

function wellFormedPoint(): AnnFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [123.93047222, 44.57108656] },
    properties: props(),
  };
}

function closedPolygon(): AnnFeature {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    properties: { ...props(), kind: "polygon" },
  };
}

function pointDraft(photo: string): AnnDraft {
  return {
    kind: "point",
    photo,
    photoTitle: "FS3 · 机位北側",
    cam: CAM,
    vertices: [[123.9304722, 44.5710866]],
    vertexErrM: [4],
  };
}

function lineDraft(photo: string): AnnDraft {
  return {
    kind: "line",
    photo,
    photoTitle: "FS3 · 机位北側",
    cam: CAM,
    vertices: [
      [0, 0],
      [1, 1],
    ],
    vertexErrM: [4, 5],
  };
}

function polygonDraft(): AnnDraft {
  return {
    kind: "polygon",
    photo: "wzbjs1gm",
    photoTitle: "FS3 · 机位北側",
    cam: CAM,
    vertices: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    vertexErrM: [4, 5, 6],
  };
}
