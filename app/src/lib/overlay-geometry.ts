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
  return makeProjector(cam)(vertex);
}

/**
 * `vertexView` with every cam-only term (M/N radii, cos φ, height) hoisted
 * out of the per-vertex path — overlay rebuilds project tens of thousands of
 * vertices against one camera (ticket 11). Identical math to `vertexView`.
 */
export function makeProjector(cam: OverlayCam): (vertex: Vertex) => ViewRay {
  const phi = cam.lat * RAD;
  const sinPhi = Math.sin(phi);
  const denom = 1 - E2 * sinPhi * sinPhi;
  const mPhi = (A * (1 - E2)) / Math.pow(denom, 1.5);
  const nPhiCos = (A / Math.sqrt(denom)) * Math.cos(phi);
  const h = cam.relAltM;
  return (vertex) => {
    const dN = (vertex[1] - cam.lat) * RAD * mPhi;
    const dE = (vertex[0] - cam.lon) * RAD * nPhiCos;
    return { yawRad: Math.atan2(dE, dN), pitchRad: -Math.atan2(h, Math.hypot(dN, dE)) };
  };
}

/* ---------- Render-time angular decimation (ticket 11) ----------
 *
 * Dense producer polygons (a dissolved avoidance union can be a single
 * 60 k+-vertex ring) re-project and re-buffer on every pano switch. Most of
 * those vertices are far away: they land in a thin horizon band, dozens per
 * screen pixel. Douglas-Peucker in the projected (yaw, pitch) plane with a
 * sub-pixel ε collapses exactly those runs while keeping near-field detail —
 * the deviation of every dropped vertex from the simplified polyline is
 * bounded by ε, i.e. invisible at any sane zoom. Data is never altered; this
 * is render hygiene between the cull and three.js.
 *
 * Yaw wraparound: a ring straddling ±π shows DP a huge yaw jump, which just
 * keeps the jump's endpoints — conservative (extra vertices), never wrong.
 */

/** Default ε: ≈0.3 px at 1600 px / 60° FOV; still sub-pixel zoomed 2×. */
export const SIMPLIFY_EPS_RAD = 2e-4;

/** Perpendicular distance of point p to segment ab in the (yaw, pitch) plane. */
function raySegmentDistance(p: ViewRay, a: ViewRay, b: ViewRay): number {
  const abx = b.yawRad - a.yawRad;
  const aby = b.pitchRad - a.pitchRad;
  const apx = p.yawRad - a.yawRad;
  const apy = p.pitchRad - a.pitchRad;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/**
 * Douglas-Peucker over the projected rays; returns the kept indices,
 * ascending, endpoints always kept. `closed` additionally guarantees ≥ 3
 * kept points (a ring decimated below 3 vertices would fill nothing — the
 * whole ring is sub-pixel then, but a degenerate fill must never sneak
 * through). Iterative stack — producer rings can be 100 k deep.
 */
export function simplifyViewRays(
  rays: readonly ViewRay[],
  closed: boolean,
  epsRad: number = SIMPLIFY_EPS_RAD,
): number[] {
  const n = rays.length;
  if (n === 0) return [];
  const minKeep = closed ? 3 : 2;
  if (n <= minKeep) return rays.map((_, i) => i);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let maxI = -1;
    const a = rays[s]!;
    const b = rays[e]!;
    for (let i = s + 1; i < e; i++) {
      const d = raySegmentDistance(rays[i]!, a, b);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsRad) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(i);
  if (out.length < minKeep) {
    // Can only happen when every interior vertex sits within ε of the
    // endpoint chord — pin the middle vertex to preserve ring-ness.
    out.splice(1, 0, n >> 1);
  }
  return out;
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
