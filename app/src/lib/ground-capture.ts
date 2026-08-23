/**
 * Flat-ground capture: view ray → ground lon/lat (+ along-track error), and
 * the inverse direction (ground vertices → view yaw/pitch) for camera swings.
 *
 * Spec: `.scratch/annotations/issues/03-ground-capture-lib.md`. This is the
 * copy record's target math extracted into a reusable seam: horizontal
 * distance from `ground-distance.ts`, the target itself from
 * `geodesy.ts`'s `vincentyDirect`, and the error from `copy-record.ts`'s
 * model — nothing is reimplemented here.
 *
 * Yaw is view-true (degrees clockwise from true north): the north offset is
 * already applied at the sphere level via `sphereCorrection`, exactly as
 * `copyRecord` consumes PSV's yaw — hence no offset parameter.
 */
import { type CameraFix, estimateErrorM, positionSigmaM } from "./copy-record.ts";
import { vincentyDirect, vincentyInverse } from "./geodesy.ts";
import { groundDistance } from "./ground-distance.ts";

/** Camera fix plus the pano's XMP `RelativeAltitude` (m AGL over takeoff). */
export type GroundCam = CameraFix & { relAltM: number };

/** Ground point under the aim: EPSG:4326 degrees + error estimate. */
export interface GroundTarget {
  lon: number;
  lat: number;
  /** Along-track error in meters — the copy-record error model. */
  errM: number;
}

/** View angles that put a world point at the reticle. */
export interface ViewAngles {
  yawDeg: number;
  pitchDeg: number;
}

/**
 * Flat-ground projection of the view ray from the camera: `groundDistance`
 * turns the altitude and pitch into horizontal travel, `vincentyDirect`
 * lands it at the yaw, and the error is the copy-record model (pitch
 * sensitivity + 1 m terrain + position σ).
 *
 * Returns null when there is no ground point — pitch at/above the horizon,
 * missing/zero/negative altitude, or missing/non-finite camera position
 * (the conditions that render `tgt n/a` / `—` in the copy record).
 */
export function groundTarget(
  cam: GroundCam | null,
  yawDeg: number,
  pitchDeg: number,
): GroundTarget | null {
  if (cam === null) return null;
  if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) return null;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  if (!Number.isFinite(pitchRad)) return null;
  // groundDistance keeps h = 0 as a 0 m aim; a drone sitting on the ground
  // has no meaningful ground point, so only strictly positive altitudes aim.
  if (!(cam.relAltM > 0)) return null;
  const g = groundDistance(cam.relAltM, pitchRad); // null ⇔ pitch ≥ 0 here
  if (g === null) return null;
  const target = vincentyDirect(cam.lat, cam.lon, yawDeg, g.horizontal);
  return {
    lon: target.lon,
    lat: target.lat,
    errM: estimateErrorM(cam.relAltM, pitchRad, positionSigmaM(cam)),
  };
}

/**
 * Inverse direction — the camera swing that puts an entity's centroid at
 * the reticle: yaw via `vincentyInverse` from the camera to the planar
 * centroid of the `[lon, lat]` vertices, pitch from the flat-ground
 * relation `tan|pitch| = h/d` (nadir when the centroid is directly below).
 * Returns null when the camera position is missing or there are no vertices.
 */
export function centroidView(
  cam: GroundCam | null,
  vertices: [lon: number, lat: number][],
): ViewAngles | null {
  if (cam === null || vertices.length === 0) return null;
  if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) return null;
  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of vertices) {
    lonSum += lon;
    latSum += lat;
  }
  const inv = vincentyInverse(
    cam.lat,
    cam.lon,
    latSum / vertices.length,
    lonSum / vertices.length,
  );
  return {
    yawDeg: inv.bearingDeg,
    pitchDeg: (-Math.atan2(cam.relAltM, inv.distanceM) * 180) / Math.PI,
  };
}
