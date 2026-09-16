/**
 * Per-pano reference-layer cull (`.scratch/reference-layers/spec.md`
 * §Client behavior, ticket 03).
 *
 * The server prefilter bounds the data extent at load time (whole-feature
 * inclusion in the 600 m circle union around every positioned pano); this
 * module is the per-photo render half: a feature is NOT drawn when every
 * vertex is more than {@link CULL_RADIUS_M} from the current camera. The
 * rule is strictly vertex-based — a long edge whose interior passes near the
 * camera with both endpoints far still culls (documented spec choice: the
 * prefilter already handled edge-clips for data extent; render hygiene does
 * not clip geometry). No geometry is ever modified.
 *
 * Distances use `vincentyInverse` (geodesy.ts, GeodTest-verified) rather
 * than the overlay's linearized `vertexView` math: the cull runs once per
 * vertex per rebuild over a small prefiltered set, and the spec pins the
 * 700 m threshold to ground-truth geodesics.
 */
import { vincentyInverse } from "./geodesy.ts";
import { mPerDegLat, mPerDegLon } from "./reference-layers.ts";
import { NEAR_BAND_M } from "./reference-lod.ts";
import type { RefGeometry, RefPosition } from "./reference-layers.ts";

/** Spec: features with every vertex > 700 m from the camera are not drawn. */
export const CULL_RADIUS_M = 700;

/** Camera ground position — the `{ lat, lon }` slice of `OverlayCam`. */
export interface CullCam {
  lat: number;
  lon: number;
}

/** Every `[lon, lat]` vertex of a geometry (Polygon rings flattened). */
export function geometryVertices(geometry: RefGeometry): RefPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "LineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates.flat();
  }
}

/**
 * True when the feature must not render: every vertex lies strictly farther
 * than `radiusM` (default {@link CULL_RADIUS_M}) from the camera. An empty
 * vertex list culls — there is nothing to place. Any vertex within the
 * radius renders the feature whole.
 */
export function featureIsCulled(
  cam: CullCam,
  vertices: readonly RefPosition[],
  radiusM: number = CULL_RADIUS_M,
): boolean {
  if (vertices.length === 0) return true;
  for (const [lon, lat] of vertices) {
    if (vincentyInverse(cam.lat, cam.lon, lat, lon).distanceM <= radiusM) return false;
  }
  return true;
}

/* ---------- Three-tier cull (ticket 10): bbox reject, per-vertex planar reject, Vincenty confirm ----------
 *
 * The exact per-vertex Vincenty loop above runs once per vertex per overlay
 * rebuild; with dissolved MultiPolygon avoidance layers (~160 k served
 * vertices across layers, ticket 09 measurements) that alone cost ~0.3–0.8 s
 * of main-thread time per photo switch. The verdict only depends on whether
 * ANY vertex is within the radius, so a whole feature can be rejected from
 * its bounding box alone. Entries are built once per feature and cached by
 * the caller (features pass through by reference — identity is stable until
 * the next layer reload).
 */

/**
 * Precomputed per-feature cull data: the flattened vertex list (built once —
 * `geometryVertices` allocates per call) and its lon/lat bbox.
 */
export interface CullEntry {
  readonly vertices: RefPosition[];
  /** `[minLon, minLat, maxLon, maxLat]`; infinities for an empty geometry. */
  readonly bbox: readonly [number, number, number, number];
}

/** Build the cached cull data of one geometry. */
export function cullEntry(geometry: RefGeometry): CullEntry {
  const vertices = geometryVertices(geometry);
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of vertices) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return { vertices, bbox: [minLon, minLat, maxLon, maxLat] };
}

/**
 * Safety band around the radius for the planar bbox reject. The planar
 * approximation deliberately UNDER-estimates true distance (meters-per-degree
 * evaluated at whichever extreme of the feature makes each axis smallest), so
 * only the residual series error needs covering — sub-meter at these
 * distances; 100 m is generous. Underestimation means a wrongly rejected
 * feature is impossible: a feature is only bbox-rejected when even its
 * underestimated distance clears the radius.
 */
const CULL_BAND_MARGIN_M = 100;

const RAD = Math.PI / 180;

/**
 * The underestimating planar scales of a cam/bbox pair (see
 * CULL_BAND_MARGIN_M): mPerDegLon shrinks pole-wards (evaluate at the
 * pole-wards extreme), mPerDegLat shrinks equator-wards (evaluate at the
 * equator-wards extreme), so distances computed with them under-read the
 * truth for every vertex of the feature.
 */
function underestimatingScales(
  cam: CullCam,
  bbox: readonly [number, number, number, number],
): { sx: number; sy: number } {
  const latLonScale = Math.max(Math.abs(cam.lat), Math.abs(bbox[1]), Math.abs(bbox[3])) * RAD;
  const latLatScale = Math.min(Math.abs(cam.lat), Math.abs(bbox[1]), Math.abs(bbox[3])) * RAD;
  return { sx: mPerDegLon(latLonScale), sy: mPerDegLat(latLatScale) };
}

/** Planar bbox-to-cam distance with given scales (underestimating). */
function bboxDistance(cam: CullCam, bbox: readonly [number, number, number, number], sx: number, sy: number): number {
  const bx = Math.max(bbox[0] - cam.lon, cam.lon - bbox[2], 0) * sx;
  const by = Math.max(bbox[1] - cam.lat, cam.lat - bbox[3], 0) * sy;
  return Math.hypot(bx, by);
}

/**
 * Same verdict as {@link featureIsCulled}, three-tier: a feature whose bbox
 * clears `radiusM + margin` from the camera in the (underestimating) planar
 * approximation is culled with no geodesic work; within the band, every
 * vertex gets the same planar reject before any geodesic call (real data
 * includes single polygons with ~900 km bboxes and ~100 k vertices — a
 * feature-level band alone still floods the Vincenty loop); only vertices
 * that survive planar rejection get the exact Vincenty check, so the
 * spec-pinned 700 m threshold stays geodesic-exact.
 */
export function entryIsCulled(
  cam: CullCam,
  entry: CullEntry,
  radiusM: number = CULL_RADIUS_M,
): boolean {
  const { vertices, bbox } = entry;
  if (vertices.length === 0) return true;
  const { sx, sy } = underestimatingScales(cam, bbox);
  const limit = radiusM + CULL_BAND_MARGIN_M;
  if (bboxDistance(cam, bbox, sx, sy) > limit) return true;
  for (const [lon, lat] of vertices) {
    const dx = (lon - cam.lon) * sx;
    const dy = (lat - cam.lat) * sy;
    if (dx * dx + dy * dy > limit * limit) continue;
    if (vincentyInverse(cam.lat, cam.lon, lat, lon).distanceM <= radiusM) return false;
  }
  return true;
}

/**
 * LOD band verdict (ticket 14): true when the feature is certainly FAR —
 * every vertex beyond `bandM` (default {@link NEAR_BAND_M}) from the camera.
 * Same underestimating scales as the cull, so the directions stay
 * conservative: an underestimated distance beyond the band means the true
 * distance is beyond it too, while any vertex whose estimate falls inside
 * the band flips the feature to near (full fidelity) — a borderline feature
 * never renders coarse. Bbox fast path first; the per-vertex scan is planar
 * arithmetic with early exit (no Vincenty — band precision is not
 * spec-pinned the way the 700 m cull threshold is). An empty vertex list is
 * "near" — harmless, the cull drops it upstream anyway.
 */
export function entryIsFar(
  cam: CullCam,
  entry: CullEntry,
  bandM: number = NEAR_BAND_M,
): boolean {
  const { vertices, bbox } = entry;
  if (vertices.length === 0) return false;
  const { sx, sy } = underestimatingScales(cam, bbox);
  if (bboxDistance(cam, bbox, sx, sy) > bandM) return true;
  const band2 = bandM * bandM;
  for (const [lon, lat] of vertices) {
    const dx = (lon - cam.lon) * sx;
    const dy = (lat - cam.lat) * sy;
    if (dx * dx + dy * dy <= band2) return false;
  }
  return true;
}
