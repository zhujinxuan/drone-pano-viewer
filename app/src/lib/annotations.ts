/**
 * Pure annotation model: GeoJSON types, ann-ULID ids, lenient parse,
 * 7-dp serialize with ring closure, and the store ops the viewer mutates
 * the collection with.
 *
 * Spec: `.scratch/annotations/spec.md` (schema version 1 — binding).
 * The file on disk is the durable outbox; this module is its only shape.
 */

export type AnnKind = "point" | "line" | "polygon";

/** Camera fix at capture — `src` mirrors the copy-record source string. */
export interface AnnCam {
  lat: number;
  lon: number;
  src: string;
  relAltM: number;
}

/** Spec-mandated properties; the index signature preserves foreign ones. */
export interface AnnProperties {
  id: string;
  kind: AnnKind;
  label: string;
  photo: string;
  photoTitle: string;
  /** ISO 8601 UTC; `updated` == `created` at birth, bumped only on relabel. */
  created: string;
  updated: string;
  cam: AnnCam;
  /** Per-vertex along-track error (same model as the copy record). */
  vertexErrM: number[];
  [key: string]: unknown;
}

/** 2D `[lon, lat]` only — flat-ground projection makes z fake precision. */
export type AnnPosition = [number, number];

/** Polygon rings are stored **unclosed** in memory; serialization closes them. */
export type AnnGeometry =
  | { type: "Point"; coordinates: AnnPosition }
  | { type: "LineString"; coordinates: AnnPosition[] }
  | { type: "Polygon"; coordinates: AnnPosition[][] };

export interface AnnFeature {
  type: "Feature";
  geometry: AnnGeometry;
  properties: AnnProperties;
  /** Foreign per-feature members survive a parse/serialize round trip. */
  [key: string]: unknown;
}

export interface AnnCollection {
  type: "FeatureCollection";
  version: number;
  features: AnnFeature[];
  /** Foreign top-level members survive a parse/serialize round trip. */
  [key: string]: unknown;
}

/** The empty collection — what a missing or garbage file loads as. */
export function emptyCollection(): AnnCollection {
  return { type: "FeatureCollection", version: 1, features: [] };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENTROPY_DIGITS = 16; // 80 random bits

// Monotonic ULID state: within one ms the entropy increments, so lexical
// order always matches creation order even for burst redraws.
let lastTime = -1;
let lastEntropy: number[] = [];

/**
 * Fresh ann-id: `ann-<26-char Crockford base32 ULID>` (48-bit ms timestamp
 * + 80-bit random). Unique across sessions/dirs with zero coordination;
 * never reused. `now` is injectable for tests.
 */
export function newAnnId(now: number = Date.now()): string {
  if (now < lastTime) now = lastTime; // clock skew must not rewind ids
  let entropy: number[];
  if (now === lastTime) {
    entropy = [...lastEntropy];
    for (let i = entropy.length - 1; i >= 0; i--) {
      if (entropy[i] < 31) {
        entropy[i]++;
        break;
      }
      entropy[i] = 0; // carry
    }
  } else {
    // One batched call; byte % 32 is unbiased (256 = 8 × 32).
    const bytes = new Uint8Array(ENTROPY_DIGITS);
    globalThis.crypto.getRandomValues(bytes);
    entropy = Array.from(bytes, (b) => b % 32);
  }
  lastTime = now;
  lastEntropy = entropy;

  let digits = entropy.map((d) => CROCKFORD[d]);
  // 48-bit timestamp as 10 base-32 digits.
  let t = now;
  for (let i = 9; i >= 0; i--) {
    digits.unshift(CROCKFORD[t % 32]);
    t = Math.floor(t / 32);
  }
  return `ann-${digits.join("")}`;
}

const KINDS: Record<string, AnnKind> = {
  point: "point",
  line: "line",
  polygon: "polygon",
};

/**
 * Lenient load: garbage yields the empty collection, structurally invalid
 * features are dropped, and everything that survives keeps its foreign
 * members verbatim. Polygon rings are stored unclosed in memory — the
 * duplicated closing vertex from disk is stripped here.
 */
export function parseAnnotations(json: unknown): AnnCollection {
  if (typeof json !== "object" || json === null) return emptyCollection();
  const { type, version, features, ...foreign } = json as Record<string, unknown>;
  if (type !== "FeatureCollection" || !Array.isArray(features)) {
    return emptyCollection();
  }
  const collection: AnnCollection = {
    type: "FeatureCollection",
    version: typeof version === "number" ? version : 1,
    features: features.filter(isAnnFeature).map(normalizeGeometry),
    ...foreign,
  };
  return collection;
}

function isAnnFeature(value: unknown): value is AnnFeature {
  if (typeof value !== "object" || value === null) return false;
  const { type, geometry, properties } = value as Record<string, unknown>;
  if (type !== "Feature" || typeof geometry !== "object" || geometry === null) return false;
  if (typeof properties !== "object" || properties === null) return false;
  const { id, kind } = properties as Record<string, unknown>;
  if (typeof id !== "string" || typeof kind !== "string" || !(kind in KINDS)) return false;
  return hasValidCoordinates(geometry as Record<string, unknown>);
}

function hasValidCoordinates(geometry: Record<string, unknown>): boolean {
  const { type, coordinates } = geometry;
  if (type === "Point") return isPosition(coordinates);
  if (type === "LineString") {
    return Array.isArray(coordinates) && coordinates.every(isPosition);
  }
  if (type === "Polygon") {
    return (
      Array.isArray(coordinates) &&
      coordinates.every((ring) => Array.isArray(ring) && ring.every(isPosition))
    );
  }
  return false; // wrong geometry type (MultiPoint, GeometryCollection, …)
}

function isPosition(value: unknown): value is AnnPosition {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

/** Takes only the first two numbers — foreign z/M coordinates are dropped —
 *  and uncloses polygon rings whose first == last vertex. */
function normalizeGeometry(feature: AnnFeature): AnnFeature {
  const g = feature.geometry;
  if (g.type === "Point") {
    g.coordinates = [g.coordinates[0], g.coordinates[1]];
  } else if (g.type === "LineString") {
    g.coordinates = g.coordinates.map(([lon, lat]) => [lon, lat] as AnnPosition);
  } else {
    g.coordinates = g.coordinates.map((ring) => {
      const flat = ring.map(([lon, lat]) => [lon, lat] as AnnPosition);
      const first = flat[0];
      const last = flat[flat.length - 1];
      if (flat.length > 1 && first[0] === last[0] && first[1] === last[1]) {
        flat.pop();
      }
      return flat;
    });
  }
  return feature;
}

/**
 * Lossless rewrite: version 1, every coordinate rounded to 7 decimals,
 * polygon rings written closed (the in-memory model stores them unclosed),
 * foreign members verbatim, pretty-printed 2-space JSON. Pure — the input
 * collection is not mutated.
 */
export function serializeAnnotations(collection: AnnCollection): string {
  const { type: _type, version: _ignored, features, ...foreign } = collection;
  const out = {
    type: "FeatureCollection" as const,
    version: 1,
    features: features.map(serializeFeature),
    ...foreign,
  };
  return JSON.stringify(out, null, 2);
}

function serializeFeature(feature: AnnFeature): Record<string, unknown> {
  const { geometry, ...rest } = feature;
  let coordinates: unknown;
  if (geometry.type === "Point") {
    coordinates = roundPosition(geometry.coordinates);
  } else if (geometry.type === "LineString") {
    coordinates = geometry.coordinates.map(roundPosition);
  } else {
    coordinates = geometry.coordinates.map((ring) => {
      const closed = ring.map(roundPosition);
      closed.push([...closed[0]]); // serialization adds the closing vertex
      return closed;
    });
  }
  // GeoJSON conventional order: type, geometry, properties, then foreign.
  const { type: _t, properties: _p, ...foreign } = rest;
  return {
    type: feature.type,
    geometry: { type: geometry.type, coordinates },
    properties: feature.properties,
    ...foreign,
  };
}

function roundPosition([lon, lat]: AnnPosition): [number, number] {
  return [round7(lon), round7(lat)];
}

function round7(n: number): number {
  // Number(x.toFixed(7)) avoids binary-float artifacts like 0.12345670000001.
  return Number(n.toFixed(7));
}

/** What capture hands the store on finish: the drawn shape plus its context. */
export interface AnnDraft {
  kind: AnnKind;
  photo: string;
  photoTitle: string;
  cam: AnnCam;
  vertices: AnnPosition[];
  vertexErrM: number[];
  /** Omit for the auto-name (`Point N` / `Line N` / `Polygon N`). */
  label?: string;
}

const MIN_VERTICES: Record<AnnKind, number> = { point: 1, line: 2, polygon: 3 };
const AUTO_NAME: Record<AnnKind, string> = { point: "Point", line: "Line", polygon: "Polygon" };

/**
 * Queue-semantics create: fresh `ann-<ULID>` (never reused), `created` ==
 * `updated`, auto-name numbered per kind per photo over the existing count.
 * Polygon rings are stored unclosed. `now` is injectable for tests.
 */
export function createEntity(
  collection: AnnCollection,
  draft: AnnDraft,
  now: number = Date.now(),
): { collection: AnnCollection; feature: AnnFeature } {
  if (draft.vertices.length < MIN_VERTICES[draft.kind]) {
    throw new RangeError(
      `${draft.kind} needs ≥ ${MIN_VERTICES[draft.kind]} vertices, got ${draft.vertices.length}`,
    );
  }
  const geometry: AnnGeometry =
    draft.kind === "point"
      ? { type: "Point", coordinates: [...draft.vertices[0]] }
 : draft.kind === "line"
        ? { type: "LineString", coordinates: draft.vertices.map(([lon, lat]) => [lon, lat]) }
        : { type: "Polygon", coordinates: [draft.vertices.map(([lon, lat]) => [lon, lat])] };
  const created = new Date(now).toISOString();
  const feature: AnnFeature = {
    type: "Feature",
    geometry,
    properties: {
      id: newAnnId(now),
      kind: draft.kind,
      label:
        draft.label ??
        `${AUTO_NAME[draft.kind]} ${countForPhoto(collection, draft.photo, draft.kind) + 1}`,
      photo: draft.photo,
      photoTitle: draft.photoTitle,
      created,
      updated: created,
      cam: draft.cam,
      vertexErrM: draft.vertexErrM,
    },
  };
  return { collection: { ...collection, features: [...collection.features, feature] }, feature };
}

function countForPhoto(collection: AnnCollection, photo: string, kind: AnnKind): number {
  return collection.features.filter(
    (f) => f.properties.photo === photo && f.properties.kind === kind,
  ).length;
}

/** Relabel: bumps `updated`, changes nothing else. Unknown id → same collection. */
export function relabelEntity(
  collection: AnnCollection,
  id: string,
  label: string,
  now: number = Date.now(),
): AnnCollection {
  if (!collection.features.some((f) => f.properties.id === id)) return collection;
  return {
    ...collection,
    features: collection.features.map((f) =>
      f.properties.id === id
        ? { ...f, properties: { ...f.properties, label, updated: new Date(now).toISOString() } }
        : f,
    ),
  };
}

/** Remove an entity. Unknown id → same collection. The id is never reused. */
export function deleteEntity(collection: AnnCollection, id: string): AnnCollection {
  if (!collection.features.some((f) => f.properties.id === id)) return collection;
  return {
    ...collection,
    features: collection.features.filter((f) => f.properties.id !== id),
  };
}

/** Current-photo subset ("layer"), file order preserved. */
export function forPhoto(collection: AnnCollection, photoId: string): AnnFeature[] {
  return collection.features.filter((f) => f.properties.photo === photoId);
}

/** Geometry → vertex list — the single unwrapping site for AnnGeometry.
 *  Polygon rings are unclosed in memory, so no closing-dup stripping here. */
export function featureVertices(f: AnnFeature): AnnPosition[] {
  switch (f.geometry.type) {
    case "Point":
      return [f.geometry.coordinates];
    case "LineString":
      return f.geometry.coordinates;
    case "Polygon":
      return f.geometry.coordinates[0];
  }
}

