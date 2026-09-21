/**
 * The HUD copy record: one clipboard line carrying the full measurement —
 * camera position, view angles, ground distance, target WGS84, and a live
 * error estimate.
 *
 * Spec: `.scratch/target-coordinates/issues/01-copy-button-target-wgs84.md`.
 * Geometry lives in `ground-distance.ts` (distance) and `geodesy.ts`
 * (target); this module owns the error model and the payload string.
 */

export interface CameraFix {
  lat: number;
  lon: number;
  /** Where the position came from — drives both the tag and the σ. */
  source: "rtk" | "gnss" | "geohash";
  /** RTK height σ in meters, when the XMP carried `RtkStd*`. */
  rtkStd?: number;
}

export interface CopyRecordInput {
  id: string;
  fix: CameraFix | null;
  /** View-center yaw in degrees (corrected bearing when an offset is set). */
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
  /** From `formatDistanceHud` — reused verbatim, may be `—`. */
  distText: string;
  target: { lat: number; lon: number } | null;
  errorM: number | null;
  /** Appended as ` · north+x.x°` only when non-zero. */
  northOffsetDeg: number;
}

/** σ assumption per source: RTK σ from XMP, 3 m plain GNSS, 20 m geohash8. */
export function positionSigmaM(fix: CameraFix): number {
  if (fix.source === "rtk") return fix.rtkStd ?? 3;
  return fix.source === "gnss" ? 3 : 20;
}

/** Error-model assumptions, also stated in the HUD tooltip. */
export const PITCH_ERR_RAD = (0.1 * Math.PI) / 180; // aim/readout
const TERRAIN_ERR_M = 1; // flat-ground assumption vs real relief

/**
 * Along-track error estimate: pitch sensitivity `h·δp/sin²|p|` (identical to
 * the spec's `2d·δp/sin 2|p|` but stable at nadir, where d → 0), terrain
 * relief `Δz/tan|p|`, plus the camera position σ. Cross-track terms are
 * dominated and omitted. Requires pitch < 0 (no ground point otherwise).
 */
export function estimateErrorM(
  altitudeM: number,
  pitchRad: number,
  posSigmaM: number,
): number {
  const down = Math.abs(pitchRad);
  const sin = Math.sin(down);
  return (
    (altitudeM * PITCH_ERR_RAD) / (sin * sin) +
    TERRAIN_ERR_M / Math.tan(down) +
    posSigmaM
  );
}

/** 2 significant figures; rounded values ≥ 1000 m collapse to `>1 km`. */
export function formatError(errM: number): string {
  const rounded = Number(errM.toPrecision(2));
  return rounded >= 1000 ? ">1 km" : String(rounded);
}

/** Source tag alone — `RTK σ… m` / `GNSS ±3 m` / `geohash ±20 m`. The
 *  annotation schema's `cam.src` stores this verbatim. */
export function cameraSourceText(fix: CameraFix): string {
  if (fix.source === "rtk") return `RTK σ${(fix.rtkStd ?? 3).toFixed(2)} m`;
  return fix.source === "gnss" ? "GNSS ±3 m" : "geohash ±20 m";
}

function camText(fix: CameraFix): string {
  return `${fix.lat.toFixed(5)},${fix.lon.toFixed(5)} (${cameraSourceText(fix)})`;
}

/**
 * `<id> · cam … (…) · yaw … · pitch … · fov … · dist … · tgt … ±… m`
 * with ` · north+x.x°` appended when an offset is active. Yaw is normalized
 * into [0, 360) for bearing sense; `tgt n/a` when no ground point or no
 * camera position.
 */
export function formatCopyRecord(input: CopyRecordInput): string {
  const yaw = (((input.yawDeg % 360) + 360) % 360).toFixed(1);
  const parts = [
    input.id,
    `cam ${input.fix === null ? "n/a" : camText(input.fix)}`,
    `yaw ${yaw}°`,
    `pitch ${input.pitchDeg.toFixed(1)}°`,
    `fov ${input.fovDeg.toFixed(1)}°`,
    `dist ${input.distText}`,
  ];
  parts.push(
    input.target === null
      ? "tgt n/a"
      : `tgt ${input.target.lat.toFixed(5)},${input.target.lon.toFixed(5)}` +
          (input.errorM === null ? "" : ` ±${formatError(input.errorM)} m`),
  );
  if (input.northOffsetDeg !== 0) {
    parts.push(`north${input.northOffsetDeg < 0 ? "-" : "+"}${Math.abs(input.northOffsetDeg).toFixed(1)}°`);
  }
  return parts.join(" · ");
}
