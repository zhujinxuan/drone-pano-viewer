/**
 * Flat-ground distance from the drone to the ground point at the view center.
 *
 * Spec: `.scratch/ground-distance/issues/01-center-reticle-ground-distance.md`.
 * Ground is assumed to be a plane at the takeoff point's elevation, so the
 * only inputs are the pano's `RelativeAltitude` (m, AGL above takeoff) and
 * the live view-center pitch (radians, negative = looking down).
 */

export interface GroundDistance {
  /** Ground distance from below the drone to the aimed point (primary). */
  horizontal: number;
  /** Line-of-sight range along the view ray (secondary). Always ≥ horizontal. */
  slant: number;
}

/** Distances beyond this render as `> 5 km`. */
const DIST_CAP_M = 5000;

/**
 * `d = h / tan(|pitch|)`, `r = h / sin(|pitch|)`. Returns null when the ray
 * never meets the ground plane (pitch ≥ 0), when the altitude is missing, or
 * when it is negative (drone below the takeoff-elevation plane, so a downward
 * ray never meets it). h = 0 computes to 0 m per the formula.
 *
 * No near-horizon clamp: as pitch → 0 both values exceed the 5 km cap and
 * the formatter takes over.
 */
export function groundDistance(
  altitudeM: number | null | undefined,
  pitchRad: number,
): GroundDistance | null {
  if (altitudeM == null || !Number.isFinite(altitudeM) || altitudeM < 0) return null;
  if (pitchRad >= 0) return null;
  const down = -pitchRad;
  return { horizontal: altitudeM / Math.tan(down), slant: altitudeM / Math.sin(down) };
}

/** Meters rounded to 10 m; anything over the cap renders `> 5 km`. */
export function formatDistance(m: number): string {
  if (m > DIST_CAP_M) return "> 5 km";
  return `${Math.round(m / 10) * 10} m`;
}

/**
 * HUD segment: horizontal primary, slant secondary, each formatted
 * independently (slant ≥ horizontal always, so the slant can cap while the
 * horizontal doesn't). `—` when there is no distance.
 */
export function formatDistanceHud(g: GroundDistance | null): string {
  if (g === null) return "—";
  return `${formatDistance(g.horizontal)} (slant ${formatDistance(g.slant)})`;
}
