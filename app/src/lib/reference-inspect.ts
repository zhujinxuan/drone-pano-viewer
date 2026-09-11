/**
 * Pure click-inspect math (ticket 04, spec §Client behavior): which
 * rendered reference feature — if any — did a drag-guarded pano click land
 * on?
 *
 * The overlay side (`ReferenceOverlay.tsx`) projects every visible,
 * unculled feature's vertices into viewer pixels (`vertexView` → PSV
 * `sphericalCoordsToViewerCoords`, frustum-filtered so off-view strokes
 * never win a hit) and hands the paths here. This module only measures:
 * nearest stroke within a pixel threshold wins, earlier layer order breaks
 * exact ties (stable, so toolbar row order decides visual coin-flips).
 *
 * Geometry rules: a path of one point (a Point feature) measures
 * point-to-point; longer paths measure point-to-segment over consecutive
 * pairs, plus a wrap segment last→first only when `closed` (polygon rings
 * are stored without their duplicated closing vertex).
 */

/** Viewer-container-relative pixel position (PSV viewer-coordinate space). */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** What the readout panel shows: read-only identity + feature properties. */
export interface InspectHit {
  layerName: string;
  /** Layer color as `#rrggbb` (swatch in the readout header). */
  color: string;
  properties: Record<string, unknown>;
}

/** One candidate feature: hit identity plus its projected stroke paths. */
export interface InspectCandidate extends InspectHit {
  readonly paths: readonly InspectPath[];
}

/** A projected polyline (or single point); `closed` adds the wrap edge. */
export interface InspectPath {
  readonly points: readonly ScreenPoint[];
  readonly closed: boolean;
}

/** Point-to-point distance, px. */
function pointDistance(p: ScreenPoint, a: ScreenPoint): number {
  return Math.hypot(p.x - a.x, p.y - a.y);
}

/** Point-to-segment distance, px. A zero-length segment is a point. */
function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return pointDistance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Min click-distance over one path's points / segments (Infinity if empty). */
function pathDistance(click: ScreenPoint, path: InspectPath): number {
  const pts = path.points;
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return pointDistance(click, pts[0]);
  let min = Infinity;
  const segments = path.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a === undefined || b === undefined) continue;
    min = Math.min(min, segmentDistance(click, a, b));
  }
  return min;
}

/**
 * The candidate whose nearest stroke is closest to `click`, provided that
 * distance is ≤ `maxDistPx`; null otherwise (also for no candidates).
 * Exact ties keep the earlier candidate.
 */
export function nearestInspectFeature(
  click: ScreenPoint,
  candidates: readonly InspectCandidate[],
  maxDistPx: number,
): InspectHit | null {
  let best: InspectCandidate | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    let dist = Infinity;
    for (const p of c.paths) dist = Math.min(dist, pathDistance(click, p));
    // strict `<` keeps the first candidate on exact ties
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (best === null || bestDist > maxDistPx) return null;
  return { layerName: best.layerName, color: best.color, properties: best.properties };
}
