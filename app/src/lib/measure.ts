/**
 * Measure-mode math (`.scratch/reference-layers/spec.md` §Measure mode,
 * ticket 05): the ephemeral two-point ground measurement — distance,
 * bearing A→B, and a propagated ±err — plus the readout chip's formatting.
 *
 * Pure: endpoints arrive as captured ground targets (flat-ground capture in
 * `ground-capture.ts`), the distance and bearing are `vincentyInverse` from
 * `geodesy.ts`, and the ±err propagates the endpoints' DIFFERENTIAL errors
 * (`errDiffM` — pitch sensitivity + terrain) in quadrature. The camera-
 * position σ is common-mode for two endpoints captured from the same pano
 * and cancels in their separation, so it is excluded; the cross-track /
 * bearing terms are dominated and omitted, mirroring the copy record's own
 * omissions.
 */
import { formatError } from "./copy-record.ts";
import { vincentyInverse } from "./geodesy.ts";
import { formatDistance } from "./ground-distance.ts";

/** A captured measure endpoint — structurally ground-capture's
 * `GroundTarget` (`[lon, lat]` degrees + differential error). */
export interface MeasurePoint {
  lon: number;
  lat: number;
  /** Differential along-track error in meters (position σ excluded). */
  errDiffM: number;
}

/** The A→B measurement. */
export interface MeasureReadout {
  distanceM: number;
  /** Forward bearing A→B, degrees clockwise from true north. */
  bearingDeg: number;
  /** ±err in meters: quadrature of the two endpoints' differential errors. */
  errM: number;
}

/** Distance + forward bearing A→B (Vincenty inverse on WGS84). */
export function measureBetween(a: MeasurePoint, b: MeasurePoint): MeasureReadout {
  const inv = vincentyInverse(a.lat, a.lon, b.lat, b.lon);
  return {
    distanceM: inv.distanceM,
    bearingDeg: inv.bearingDeg,
    errM: Math.hypot(a.errDiffM, b.errDiffM),
  };
}

/** `±… m`, unit dropped when `formatError` already collapsed to `>1 km`. */
function errText(errM: number): string {
  const s = formatError(errM);
  return s.endsWith("km") ? s : `${s} m`;
}

/**
 * Readout chip: `<dist> · <bearing>° · ±<err>` — 10 m rounding via the HUD
 * `dist` formatter (with its `> 5 km` cap), bearing at 1 dp, err at 2
 * significant figures (the copy record's formatter).
 */
export function formatMeasureChip(r: MeasureReadout): string {
  return `${formatDistance(r.distanceM)} · ${r.bearingDeg.toFixed(1)}° · ±${errText(r.errM)}`;
}
