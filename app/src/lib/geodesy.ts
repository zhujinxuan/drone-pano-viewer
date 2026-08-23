/**
 * Vincenty's direct and inverse geodesics on the WGS84 ellipsoid.
 *
 * Spec: `.scratch/target-coordinates/issues/01-copy-button-target-wgs84.md`
 * (direct) and `.scratch/annotations/issues/03-ground-capture-lib.md`
 * (inverse). Direct: start point + true-north bearing + distance →
 * destination. Inverse: two points → distance + forward bearing. No
 * projection, no CRS conversion — mm-level error, no dependencies. Both
 * verified against GeographicLib's GeodTest reference vectors (see
 * geodesy.test.ts).
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

/** Result of `vincentyInverse`: geodesic distance and forward bearing. */
export interface InverseResult {
  /** Geodesic distance in meters (≥ 0). */
  distanceM: number;
  /** Forward azimuth at the first point, degrees clockwise from true north, [0, 360). */
  bearingDeg: number;
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

/**
 * Geodesic distance and forward bearing from `(lat1, lon1)` to
 * `(lat2, lon2)` (degrees). Longitude difference is normalized to
 * (−180, 180] so pairs straddling the antimeridian take the short way.
 *
 * Iterates λ to |Δλ| < 1e-12, matching `vincentyDirect`'s convergence.
 * Coincident points return zero distance with bearing 0 (azimuth is
 * undefined there); near-antipodal pairs can fail to converge — irrelevant
 * here (feature caps at 5 km) — and the bounded iteration throws rather
 * than returning a silently wrong answer.
 */
export function vincentyInverse(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): InverseResult {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const L = ((((lon2 - lon1) % 360) + 540) % 360 - 180) * RAD;

  const tanU1 = (1 - F) * Math.tan(phi1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const tanU2 = (1 - F) * Math.tan(phi2);
  const cosU2 = 1 / Math.sqrt(1 + tanU2 * tanU2);
  const sinU2 = tanU2 * cosU2;
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 1;
  let cos2SigmaM = 0;
  for (let i = 0; i < 100; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return { distanceM: 0, bearingDeg: 0 }; // coincident
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // cos²α = 0 on the equator line: cos2σm is singular, take the limit 0.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) break;
    if (i === 99) throw new Error("vincentyInverse: failed to converge");
  }

  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const alpha1 = Math.atan2(
    cosU2 * Math.sin(lambda),
    cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda),
  );
  return {
    distanceM: B * bigA * (sigma - deltaSigma),
    bearingDeg: ((alpha1 * DEG % 360) + 360) % 360,
  };
}
