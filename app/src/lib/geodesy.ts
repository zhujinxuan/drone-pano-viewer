/**
 * Vincenty's direct geodesic on the WGS84 ellipsoid.
 *
 * Spec: `.scratch/target-coordinates/issues/01-copy-button-target-wgs84.md`.
 * Given a start point, a true-north bearing and a distance, returns the
 * destination in EPSG:4326 degrees. No projection, no CRS conversion —
 * mm-level error, ~40 lines, no dependencies. Verified against
 * GeographicLib's GeodTest reference vectors (see geodesy.test.ts).
 */

/** WGS84 ellipsoid. */
const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface LonLat {
  lat: number;
  lon: number;
}

/**
 * Destination point from `(lat, lon)` (degrees) traveling `distanceM` meters
 * along bearing `bearingDeg` (degrees clockwise from true north, any range —
 * normalized internally).
 *
 * Iterates σ to |Δσ| < 1e-12 (≈0.06 mm on the auxiliary sphere). Vincenty
 * can fail to converge near-antipodal; irrelevant here (feature caps at
 * 5 km), but the iteration is bounded and throws rather than returning a
 * silently wrong point.
 */
export function vincentyDirect(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceM: number,
): LonLat {
  if (distanceM === 0) return { lat, lon };

  const alpha1 = ((bearingDeg % 360) + 360) % 360 * RAD;
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);

  const tanU1 = (1 - F) * Math.tan(lat * RAD);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distanceM / (B * bigA);
  let deltaSigma = 0;
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  for (let i = 0; i < 100; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    deltaSigma =
      bigB *
      sinSigma *
      (cos2SigmaM +
        (bigB / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (bigB / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const prev = sigma;
    sigma = distanceM / (B * bigA) + deltaSigma;
    if (Math.abs(sigma - prev) < 1e-12) break;
    if (i === 99) throw new Error("vincentyDirect: failed to converge");
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp),
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1,
  );
  const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) *
      F *
      sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

  return { lat: lat2 * DEG, lon: lon + L * DEG };
}
