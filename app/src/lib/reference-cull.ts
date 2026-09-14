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
  // Scales chosen to UNDER-estimate: mPerDegLon shrinks pole-wards (evaluate
  // at the pole-wards extreme), mPerDegLat shrinks equator-wards (evaluate at
  // the equator-wards extreme). The same two scales underestimate for every
  // vertex of the feature, so the per-vertex tier inherits the guarantee.
  const latLonScale = Math.max(Math.abs(cam.lat), Math.abs(bbox[1]), Math.abs(bbox[3])) * RAD;
  const latLatScale = Math.min(Math.abs(cam.lat), Math.abs(bbox[1]), Math.abs(bbox[3])) * RAD;
  const sx = mPerDegLon(latLonScale);
  const sy = mPerDegLat(latLatScale);
  const bx = Math.max(bbox[0] - cam.lon, cam.lon - bbox[2], 0) * sx;
  const by = Math.max(bbox[1] - cam.lat, cam.lat - bbox[3], 0) * sy;
  const limit = radiusM + CULL_BAND_MARGIN_M;
  if (Math.hypot(bx, by) > limit) return true;
  for (const [lon, lat] of vertices) {
    const dx = (lon - cam.lon) * sx;
    const dy = (lat - cam.lat) * sy;
    if (dx * dx + dy * dy > limit * limit) continue;
    if (vincentyInverse(cam.lat, cam.lon, lat, lon).distanceM <= radiusM) return false;
  }
  return true;
}
