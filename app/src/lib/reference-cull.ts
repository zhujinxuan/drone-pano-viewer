/**
 * Per-pano reference-layer cull (`.scratch/reference-layers/spec.md`
 * §Client behavior, ticket 03).
 *
 * The server prefilter bounds the data extent at load time (whole-feature
 * inclusion in the 1 km circle union around every positioned pano); this
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
 * 1100 m threshold to ground-truth geodesics.
 */
import { vincentyInverse } from "./geodesy.ts";
import type { RefGeometry, RefPosition } from "./reference-layers.ts";

/** Spec: features with every vertex > 1100 m from the camera are not drawn. */
export const CULL_RADIUS_M = 1100;

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
