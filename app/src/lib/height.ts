/**
 * Height-mode math (`.scratch/vertical-measure/spec.md`, ticket 01): the
 * ephemeral vertical (tree-height) measurement — H = relAlt + d·tan(pitch_B)
 * with a propagated ±err — plus the readout chip's formatting.
 *
 * Pure: the tree base A arrives as a captured ground target (flat-ground
 * capture in `ground-capture.ts`), d is `vincentyInverse` from `geodesy.ts`
 * (camera → A), and the ±err propagates A's DIFFERENTIAL error σ_d (pitch
 * sensitivity + terrain, camera-position σ common-mode-cancelled, as in
 * measure mode) together with the aim-pitch σ (copy-record's 0.1°) in
 * quadrature. B contributes only its pitch — the user aligns the tree
 * visually, so bearing is ignored and B is accepted at any pitch: a tree
 * shorter than the drone's altitude legitimately sits below the horizon.
 */
import { PITCH_ERR_RAD, formatError } from "./copy-record.ts";
import { vincentyInverse } from "./geodesy.ts";
import { formatDistance } from "./ground-distance.ts";

/** A captured tree base — structurally ground-capture's `GroundTarget`
 * (`[lon, lat]` degrees + differential error). */
export interface HeightPoint {
  lon: number;
  lat: number;
  /** Differential along-track error σ_d in meters (position σ excluded). */
  errDiffM: number;
}

/** Camera fix plus the pano's XMP `RelativeAltitude` (m AGL over takeoff). */
export interface HeightCam {
  lat: number;
  lon: number;
  relAltM: number;
}

/** The A→B vertical measurement. */
export interface HeightReadout {
  /** H = relAlt + d·tan(pitch_B), meters above the takeoff plane. */
  heightM: number;
  /** Horizontal distance cam→A in meters (the chip's `d`). */
  distM: number;
  /** ±err in meters: the spec's quadrature (see `sigmaHeightM`). */
  errM: number;
}

/**
 * Vertical size from a captured tree base A and the tree-top pitch: d via
 * Vincenty inverse (camera → A), then `H = relAlt + d·tan(pitch_B)`.
 * Returns null when `H ≤ 0` — B's ray meets the ground nearer than A (the
 * user clicked a closer ground point); the caller rejects with a flash,
 * never silently. pitch_B may be negative (short tree below the horizon)
 * as long as H stays positive.
 */
export function heightBetween(
  cam: HeightCam,
  a: HeightPoint,
  pitchBDeg: number,
): HeightReadout | null {
  const d = vincentyInverse(cam.lat, cam.lon, a.lat, a.lon).distanceM;
  const pitchRad = (pitchBDeg * Math.PI) / 180;
  const heightM = cam.relAltM + d * Math.tan(pitchRad);
  if (!(heightM > 0)) return null;
  return {
    heightM,
    distM: d,
    errM: sigmaHeightM(d, pitchBDeg, a.errDiffM),
  };
}

/**
 * ±err quadrature (spec): `σ_H = √((d·sec²(pitch_B)·σ_pitch)² +
 * (tan(pitch_B)·σ_d)²)` — the pitch term is how far the tree top slides
 * tangentially per aim error (sec² grows steeply as B nears the horizon),
 * the d term is A's differential ground error scaled by the slope. Same σ
 * sources as measure mode: σ_pitch defaults to the copy-record model's
 * 0.1° aim/readout assumption; the camera-position σ is common-mode and
 * cancels, and relAlt's σ is decided out of the model.
 */
export function sigmaHeightM(
  distM: number,
  pitchBDeg: number,
  sigmaDM: number,
  sigmaPitchRad: number = PITCH_ERR_RAD,
): number {
  const pitchRad = (pitchBDeg * Math.PI) / 180;
  const cos = Math.cos(pitchRad);
  const tan = Math.tan(pitchRad);
  return Math.hypot((distM * sigmaPitchRad) / (cos * cos), tan * sigmaDM);
}

/** `±… m`, unit dropped when `formatError` already collapsed to `>1 km`. */
function errText(errM: number): string {
  const s = formatError(errM);
  return s.endsWith("km") ? s : `${s} m`;
}

/**
 * Readout chip: `H <height> m · d <dist> · ±<err>` — H at 0.1 m, d with
 * the HUD `dist` formatter (10 m rounding, `> 5 km` cap), err at 2
 * significant figures (the copy record's formatter).
 */
export function formatHeightChip(r: HeightReadout): string {
  return `H ${r.heightM.toFixed(1)} m · d ${formatDistance(r.distM)} · ±${errText(r.errM)}`;
}
