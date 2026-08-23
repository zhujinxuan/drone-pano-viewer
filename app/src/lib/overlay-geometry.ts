/**
 * Ground vertex → view-ray math for the annotation overlay (ticket 04).
 *
 * Spec: `.scratch/annotations/spec.md` ("Rendering" / "Capture &
 * interaction"). Vertices are ground lon/lat captured with the flat-ground
 * projection (Vincenty direct from the camera fix + RelativeAltitude — see
 * `App.tsx` `copyRecord`, extracted into `ground-capture.ts` by ticket 03).
 * The overlay needs the inverse — ground lon/lat back to the view-true
 * yaw/pitch ray — to place shapes on the pano sphere.
 *
 * DECISION (ticket 07, post-review): `ground-capture.ts` owns the forward
 * direction (capture) and `centroidView` (Vincenty-inverse) for one-shot
 * camera swings. The overlay deliberately does NOT reuse vincentyInverse:
 * `vertexView` runs per vertex per overlay rebuild, where the closed-form
 * M/N-radii linearization beats an iterative Vincenty solve and stays
 * sub-pixel (< 5e-4 rad yaw at the 5 km cap — overlay-geometry.test.ts).
 * Two implementations, one assumption (flat ground at takeoff elevation),
 * each tested against the other direction.
 *
 * Accuracy: local WGS84 radii (meridional M, prime vertical N) linearize the
 * lat/lon deltas — against a full Vincenty-direct round trip the error stays
 * < 5e-4 rad in yaw and < 4e-6 rad in pitch at the 5 km feature cap (see
 * overlay-geometry.test.ts), i.e. sub-pixel on screen. Flat ground at the
 * takeoff elevation is the same assumption the capture path makes.
 */

/** WGS84 ellipsoid (matches geodesy.ts). */
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

const RAD = Math.PI / 180;

/** Camera fix + XMP RelativeAltitude (m AGL above the takeoff plane). */
export interface OverlayCam {
  lat: number;
  lon: number;
  relAltM: number;
}

/** A view ray in PSV convention: radians, yaw = compass bearing (0 = north,
 *  positive east), pitch negative = looking down. */
export interface ViewRay {
  yawRad: number;
  pitchRad: number;
}

/** Vertex position, `[lon, lat]` degrees. */
export type Vertex = readonly [number, number];

/**
 * View-true ray from the camera to a ground vertex: yaw from the local
 * east/north offsets (M/N radii), pitch from `atan2(h, d)` over the flat
 * ground plane. Degenerate cases: vertex at the camera → nadir
 * (pitch −π/2, yaw 0 — atan2(0, 0)); `relAltM = 0` → pitch 0 (horizon) for
 * every distance. Undefined for NaN inputs; no clamping — PSV consumes any
 * angle.
 */
export function vertexView(cam: OverlayCam, vertex: Vertex): ViewRay {
  const phi = cam.lat * RAD;
  const sinPhi = Math.sin(phi);
  const denom = 1 - E2 * sinPhi * sinPhi;
  const mPhi = (A * (1 - E2)) / Math.pow(denom, 1.5);
  const nPhi = A / Math.sqrt(denom);

  const dN = (vertex[1] - cam.lat) * RAD * mPhi;
  const dE = (vertex[0] - cam.lon) * RAD * nPhi * Math.cos(phi);

  return {
    yawRad: Math.atan2(dE, dN),
    pitchRad: -Math.atan2(cam.relAltM, Math.hypot(dN, dE)),
  };
}

/**
 * Plain arithmetic mean of the vertices (`[lon, lat]`), as a display anchor
 * for labels. Undefined for an empty list; antimeridian wraparound is
 * ignored (annotation spans are ≪ a degree). A GeoJSON-style duplicated
 * closing vertex skews the mean — pass rings without it (the UI never stores
 * one; serialization adds it on write).
 */
export function verticesCentroid(vertices: readonly Vertex[]): [number, number] {
  let lon = 0;
  let lat = 0;
  for (const v of vertices) {
    lon += v[0];
    lat += v[1];
  }
  const n = vertices.length;
  return [lon / n, lat / n];
}
