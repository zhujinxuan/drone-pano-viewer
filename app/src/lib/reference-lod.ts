/**
 * Distance-banded LOD for reference-layer rendering (ticket 14,
 * `.scratch/reference-layers/spec.md` §Client behavior).
 *
 * Research basis (2026-09-16, ticket 14): the standard practice everywhere
 * — tippecanoe vector tiles, mapshaper, terrain/game LOD — is to simplify
 * ONCE per detail band and select per feature by camera distance, never to
 * re-simplify per camera move. The viewer's camera is discrete (one per
 * pano), so band switches only happen on pano switches and no hysteresis is
 * needed.
 *
 * This module is the cam-independent half: a ground-space Douglas-Peucker in
 * local planar meters (the codebase's documented mPerDeg convention) at
 * {@link FAR_LOD_EPS_M}, cached per feature by the caller (WeakMap, same
 * discipline as the cull/fill caches — feature identity is payload-stable).
 * A FAR feature (no vertex within {@link NEAR_BAND_M} of the camera — the
 * verdict lives in reference-cull.ts beside the cull) renders from the
 * simplified geometry: per-switch projection cost collapses to the
 * simplified ring size, and the coarse fill triangulation becomes
 * cam-independent and therefore cacheable (ticket 11's decimated fills
 * couldn't be).
 *
 * Error budget: screen error of a ground error eps at distance d ≈ eps/d
 * rad (≈ 935 px/rad at 1080p/60° FOV). 3 m at 200 m ≈ 14 px worst case,
 * shrinking with distance — visible corner-cutting only when zoomed into a
 * far feature; the user accepted "aggressive" trimming beyond 200 m. The
 * far stroke still gets ticket 11's sub-pixel angular DP on top.
 *
 * Render-only: the served GeoJSON, the 600 m prefilter, the 700 m cull and
 * click-inspect all keep the full-fidelity geometry.
 */
import { mPerDegLat, mPerDegLon } from "./reference-layers.ts";
import type { RefGeometry, RefPosition } from "./reference-layers.ts";

/** Band boundary: a feature with no vertex within this distance renders coarse. */
export const NEAR_BAND_M = 200;

/** Far-band ground-space DP tolerance, meters (see module docstring). */
export const FAR_LOD_EPS_M = 3;

/**
 * Heavy-layer visibility seeding budget (ticket 17): a layer whose served
 * vertex count exceeds this starts hidden in the toolbar — the user enables
 * it deliberately. Lives here with the other render-cost constants; the
 * server-side warning budget (200 k, ticket 13) is a separate, looser bound
 * aimed at producer discipline.
 */
export const SLOW_LAYER_VERTEX_BUDGET = 50_000;

const RAD = Math.PI / 180;

/** Perpendicular distance of p to segment ab, planar meters. */
function segmentDistanceM(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/**
 * Douglas-Peucker over ground vertices in a local planar frame (origin =
 * first vertex, mPerDeg scales at its latitude — sub-meter series error at
 * these scales, and the 3 m tolerance dwarfs it). Returns the kept indices,
 * ascending, endpoints always kept; `closed` additionally guarantees ≥ 3
 * kept points so a ring never decimates below a fill-able triangle.
 * Iterative stack — producer rings can be 100 k deep.
 */
export function simplifyGroundM(
  vertices: readonly RefPosition[],
  closed: boolean,
  epsM: number,
): number[] {
  const n = vertices.length;
  if (n === 0) return [];
  const minKeep = closed ? 3 : 2;
  if (n <= minKeep) return vertices.map((_, i) => i);

  const latRad = vertices[0]![1] * RAD;
  const sx = mPerDegLon(latRad);
  const sy = mPerDegLat(latRad);
  const lon0 = vertices[0]![0];
  const lat0 = vertices[0]![1];
  // Planar meters, flat arrays — 100 k rings must not allocate per vertex.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (vertices[i]![0] - lon0) * sx;
    ys[i] = (vertices[i]![1] - lat0) * sy;
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let maxI = -1;
    const ax = xs[s]!;
    const ay = ys[s]!;
    const bx = xs[e]!;
    const by = ys[e]!;
    for (let i = s + 1; i < e; i++) {
      const d = segmentDistanceM(xs[i]!, ys[i]!, ax, ay, bx, by);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsM) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(i);
  if (out.length < minKeep) {
    // Every interior vertex within ε of the endpoint chord — pin the middle
    // vertex to preserve ring-ness (same guard as simplifyViewRays).
    out.splice(1, 0, n >> 1);
  }
  return out;
}

/** Drop a duplicated closing vertex (rings may be written closed). */
function unclosed(ring: readonly RefPosition[]): readonly RefPosition[] {
  const n = ring.length;
  return n >= 2 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1]
    ? ring.slice(0, n - 1)
    : ring;
}

/**
 * The far-band geometry of a feature: every LineString/Polygon ring replaced
 * by its {@link FAR_LOD_EPS_M} simplification (rings stored unclosed — the
 * render path closes strokes itself and earcut needs no closure marker), a
 * Point passed through. Returns the SAME object when no ring lost a vertex —
 * small features pay no copy, and identity lets the caller skip the cache.
 * Pure function of the geometry: cacheable per feature identity.
 */
export function lodGeometry(geometry: RefGeometry, epsM: number = FAR_LOD_EPS_M): RefGeometry {
  switch (geometry.type) {
    case "Point":
      return geometry;
    case "LineString": {
      const kept = simplifyGroundM(geometry.coordinates, false, epsM);
      if (kept.length === geometry.coordinates.length) return geometry;
      return { type: "LineString", coordinates: kept.map((i) => geometry.coordinates[i]!) };
    }
    case "Polygon": {
      let droppedAny = false;
      const rings = geometry.coordinates.map((ring) => {
        const open = unclosed(ring);
        const kept = simplifyGroundM(open, true, epsM);
        if (kept.length < open.length) droppedAny = true;
        return kept.map((i) => open[i]!);
      });
      if (!droppedAny) return geometry;
      return { type: "Polygon", coordinates: rings };
    }
  }
}
