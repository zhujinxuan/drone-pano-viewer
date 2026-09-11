/**
 * Pure reference-layer model: repeatable `--layer` CLI flag parsing, lenient
 * GeoJSON load, and the 1 km circle-union prefilter.
 *
 * Spec: .scratch/reference-layers/spec.md, ticket 01. Reference layers are
 * externally-owned, read-only overlays (turbine foundations, avoidance areas)
 * produced by outside tools; the viewer never writes them. Everything here is
 * pure — the fs-reading endpoints live in vite.config.ts / cli.ts, exactly
 * like annotations.ts delegates its fs to the middleware.
 *
 * Distance approximation (documented choice + error bound): the prefilter
 * measures planar distances in a local equirectangular frame whose axes are
 * meters-per-degree scales from the WGS84 series (mPerDegLat/mPerDegLon),
 * evaluated at the segment / point-pair midpoint latitude. Against Vincenty
 * ground truth the error is < 1 m at the 1 km ring for features within a few
 * km of a pano, growing to ≈ 0.5% of distance for very long far segments
 * (≲ 5 m at 1 km, ≲ 100 m for a 50 km edge) — immaterial to whole-feature
 * inclusion (no clipping, geometry untouched) and covered downstream by the
 * 1100 m per-pano render cull. Antimeridian-spanning sites are out of scope.
 */
import type { LonLat } from "./geohash.ts";
import type { PhotoEntry } from "./types.ts";

// ---- CLI flag parsing ------------------------------------------------------

/** Okabe-Ito colorblind-safe palette, ordered for visibility over imagery (black last). */
export const OKABE_ITO = [
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#009e73", // bluish green
  "#f0e442", // yellow
  "#0072b2", // blue
  "#d55e00", // vermillion
  "#cc79a7", // reddish purple
  "#000000", // black
] as const;

/** One parsed `--layer <name>=<path.geojson>[,#hex][,label=<prop>]` flag. */
export interface RefLayerSpec {
  name: string;
  /** Path as written in the flag — cli.ts resolves it (absolute or CWD-relative). */
  path: string;
  /** Explicit `#hex`, or the Okabe-Ito color assigned by flag order. */
  color: string;
  /** `label=<prop>` or null (the client falls back label > name > id > turbine). */
  labelProp: string | null;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const LABEL_SEGMENT = /^label=(.+)$/;

/**
 * Parse the repeatable `--layer` values in flag order. Layers without an
 * explicit `#hex` take Okabe-Ito colors by flag order; explicit colors do not
 * consume palette slots, and palette colors already taken by an explicit `#hex`
 * are skipped, so two layers never share a color out of the box. Throws a
 * usage-shaped Error on malformed syntax — cli.ts turns it into a fail-fast
 * die().
 */
export function parseLayerSpecs(raws: readonly string[]): RefLayerSpec[] {
  const specs = raws.map(parseLayerSpec);
  const taken = new Set(specs.map((s) => s.color).filter((c): c is string => c !== null));
  const free = OKABE_ITO.filter((c) => !taken.has(c));
  const pool = free.length > 0 ? free : OKABE_ITO;
  let paletteIndex = 0;
  return specs.map((spec) => ({
    ...spec,
    color: spec.color ?? pool[paletteIndex++ % pool.length]!,
  }));
}

/** Grammar: `<name>=<path>[,#hex][,label=<prop>]` — the two optional segments in any order, once each. */
function parseLayerSpec(raw: string): Omit<RefLayerSpec, "color"> & { color: string | null } {
  const usage = `--layer expects <name>=<path.geojson>[,#hex][,label=<prop>], got "${raw}"`;
  const segments = raw.split(",");
  const eq = segments[0]!.indexOf("=");
  if (eq <= 0) throw new Error(usage); // covers missing "=", empty value, empty name
  const name = segments[0]!.slice(0, eq);
  const path = segments[0]!.slice(eq + 1);
  if (!path) throw new Error(usage);
  let color: string | null = null;
  let labelProp: string | null = null;
  for (const segment of segments.slice(1)) {
    if (HEX_COLOR.test(segment)) {
      if (color !== null) throw new Error(usage);
      color = segment.toLowerCase();
      continue;
    }
    const label = LABEL_SEGMENT.exec(segment);
    if (label === null || labelProp !== null) throw new Error(usage);
    labelProp = label[1]!;
  }
  return { name, path, color, labelProp };
}

// ---- Lenient GeoJSON load ---------------------------------------------------

/**
 * `[lon, lat]`. Runtime arrays may carry foreign z/M members — only [0]/[1]
 * are ever read and the array is never rewritten (lossless pass-through).
 */
export type RefPosition = [number, number];

/** v1 renders Point / LineString / Polygon; other geometry types are dropped at load. */
export type RefGeometry =
  | { type: "Point"; coordinates: RefPosition }
  | { type: "LineString"; coordinates: RefPosition[] }
  | { type: "Polygon"; coordinates: RefPosition[][] };

/** GeoJSON Feature; the index signature keeps foreign members verbatim. */
export interface RefFeature {
  type: "Feature";
  geometry: RefGeometry;
  properties: Record<string, unknown>;
  [member: string]: unknown;
}

/** Outcome of loading one layer file: `"invalid"` is the whole file being unrecognizable. */
export interface RefLoadResult {
  status: "ok" | "invalid";
  features: RefFeature[];
}

/**
 * Lenient load of a layer file's parsed JSON: a FeatureCollection, a bare
 * Feature, or a bare geometry (wrapped into a Feature) are all accepted.
 * Structurally invalid features inside a collection are dropped silently;
 * everything that survives — coordinates, unknown properties, foreign
 * members — is passed through by reference, never rewritten or rounded.
 * Rings may be written closed or unclosed; closure is a filter-time concern.
 */
export function parseReferenceGeoJSON(json: unknown): RefLoadResult {
  if (typeof json !== "object" || json === null) return { status: "invalid", features: [] };
  const obj = json as Record<string, unknown>;
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    return { status: "ok", features: obj.features.filter(isRefFeature) };
  }
  if (isRefFeature(json)) return { status: "ok", features: [json] };
  if (isRefGeometry(obj)) {
    return { status: "ok", features: [{ type: "Feature", geometry: obj, properties: {} }] };
  }
  return { status: "invalid", features: [] };
}

function isRefFeature(value: unknown): value is RefFeature {
  if (typeof value !== "object" || value === null) return false;
  const { type, geometry, properties } = value as Record<string, unknown>;
  if (type !== "Feature") return false;
  if (!isRefGeometry(geometry)) return false; // includes geometry: null / missing
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    // missing / null / nonsensical properties → the feature is kept with {}
    (value as { properties: Record<string, unknown> }).properties = {};
  }
  return true;
}

function isRefGeometry(value: unknown): value is RefGeometry {
  if (typeof value !== "object" || value === null) return false;
  const { type, coordinates } = value as Record<string, unknown>;
  if (type === "Point") return isPosition(coordinates);
  if (type === "LineString") {
    return Array.isArray(coordinates) && coordinates.length >= 2 && coordinates.every(isPosition);
  }
  if (type === "Polygon") {
    return (
      Array.isArray(coordinates) &&
      coordinates.every((ring) => Array.isArray(ring) && ring.every(isPosition))
    );
  }
  return false; // Multi* / GeometryCollection / anything else
}

function isPosition(value: unknown): value is RefPosition {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

// ---- Circle-union prefilter -------------------------------------------------

const RAD = Math.PI / 180;

/** Meters per degree of latitude at `latRad` (WGS84 series, < 1 m per degree). */
function mPerDegLat(latRad: number): number {
  return 111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
}

/** Meters per degree of longitude at `latRad` (WGS84 series, < 1 m per degree). */
function mPerDegLon(latRad: number): number {
  return 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
}

/**
 * Circle centers for the prefilter: one per positioned pano. `nogps-*` and
 * half-decoded entries (null lon or lat) are skipped — missing GPS is missing
 * extent. This runs over the full dir scan, not the playlist: a playlist is a
 * review restriction, not a data extent (spec §prefilter).
 */
export function circlesFromPhotos(photos: readonly PhotoEntry[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of photos) {
    if (p.lon !== null && p.lat !== null) out.push({ lon: p.lon, lat: p.lat });
  }
  return out;
}

/** Planar distance from a circle center to a position, linearized at the pair's midpoint latitude. */
function pointCenterDistanceM(lon: number, lat: number, c: LonLat): number {
  const latRef = ((lat + c.lat) / 2) * RAD;
  const x = (lon - c.lon) * mPerDegLon(latRef);
  const y = (lat - c.lat) * mPerDegLat(latRef);
  return Math.hypot(x, y);
}

/**
 * Min distance from circle center `c` to segment `ab`, in a local
 * equirectangular frame whose scales are evaluated at the segment's midpoint
 * latitude (the documented approximation — see the module doc).
 */
function segmentCenterDistanceM(a: readonly number[], b: readonly number[], c: LonLat): number {
  const latRef = ((a[1]! + b[1]!) / 2) * RAD;
  const sx = mPerDegLon(latRef);
  const sy = mPerDegLat(latRef);
  const ax = (a[0]! - c.lon) * sx;
  const ay = (a[1]! - c.lat) * sy;
  const abx = (b[0]! - a[0]!) * sx;
  const aby = (b[1]! - a[1]!) * sy;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(ax, ay); // degenerate segment → vertex test
  // clamp the projection parameter: the closest point may be an endpoint
  let t = -(ax * abx + ay * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(ax + t * abx, ay + t * aby);
}

/** Vertices inside the circle, or any segment (plus the ring wrap edge) near it. */
function hitNearCircle(
  coords: readonly (readonly number[])[],
  closeRing: boolean,
  c: LonLat,
  radiusM: number,
): boolean {
  for (const v of coords) {
    if (pointCenterDistanceM(v[0]!, v[1]!, c) <= radiusM) return true;
  }
  // Rings: a duplicated closing vertex is stripped so the wrap edge (last →
  // first) is tested exactly once, whether the ring was written closed or not.
  // Lines have no wrap edge.
  const ring =
    closeRing &&
    coords.length > 1 &&
    coords[0]![0] === coords[coords.length - 1]![0] &&
    coords[0]![1] === coords[coords.length - 1]![1]
      ? coords.slice(0, -1)
      : coords;
  const segments = closeRing ? ring.length : ring.length - 1;
  for (let i = 0; i < segments; i++) {
    if (segmentCenterDistanceM(ring[i]!, ring[(i + 1) % ring.length]!, c) <= radiusM) return true;
  }
  return false;
}

function intersectsUnion(f: RefFeature, centers: readonly LonLat[], radiusM: number): boolean {
  const g = f.geometry;
  if (g.type === "Point") {
    return centers.some((c) => pointCenterDistanceM(g.coordinates[0], g.coordinates[1], c) <= radiusM);
  }
  if (g.type === "LineString") {
    return centers.some((c) => hitNearCircle(g.coordinates, false, c, radiusM));
  }
  // Polygon: every ring is a boundary for the proximity test (holes included —
  // this is a near test, not point-in-polygon).
  return g.coordinates.some((ring) => centers.some((c) => hitNearCircle(ring, true, c, radiusM)));
}

/**
 * Whole-feature inclusion against the union of `radiusM` circles around the
 * pano positions: a feature is kept iff any vertex is inside any circle or
 * any segment's min distance to a circle center ≤ radiusM (vertices alone
 * miss edge-clips). Kept features pass through by reference — no clipping,
 * no coordinate rewriting, ever.
 */
export function filterByCircleUnion(
  features: readonly RefFeature[],
  centers: readonly LonLat[],
  radiusM = 1000,
): RefFeature[] {
  return features.filter((f) => intersectsUnion(f, centers, radiusM));
}

// ---- Endpoint payload -------------------------------------------------------

/** One layer of GET /api/reference-layers (the client consumes this shape). */
export interface RefLayerPayload {
  name: string;
  color: string;
  labelProp: string | null;
  status: "ok" | "invalid" | "missing";
  features: { type: "FeatureCollection"; features: RefFeature[] };
}
