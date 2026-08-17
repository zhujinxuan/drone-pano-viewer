/**
 * Base32 geohash decoding.
 *
 * Pano filenames are `{geohash8}.jpg` — an 8-character base32 geohash whose
 * cell center is the drone position (geohash8 precision is roughly ±20 m,
 * good enough for viewer purposes). Files with no GPS use the `nogps-*`
 * prefix instead and carry no coordinates.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface LonLat {
  lon: number;
  lat: number;
}

/** True when the stem is a plausible 8-char base32 geohash (case-insensitive). */
export function isGeohash8(stem: string): boolean {
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{8}$/i.test(stem);
}

/**
 * Decode a base32 geohash of any length to the CENTER of its cell.
 * Returns `null` for empty or invalid input.
 */
export function decodeGeohash(geohash: string): LonLat | null {
  if (geohash.length === 0) return null;

  let evenBit = true;
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  for (const ch of geohash.toLowerCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) return null;

    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        // longitude
        const lonMid = (lonMin + lonMax) / 2;
        if (bit === 1) lonMin = lonMid;
        else lonMax = lonMid;
      } else {
        // latitude
        const latMid = (latMin + latMax) / 2;
        if (bit === 1) latMin = latMid;
        else latMax = latMid;
      }
      evenBit = !evenBit;
    }
  }

  return {
    lon: (lonMin + lonMax) / 2,
    lat: (latMin + latMax) / 2,
  };
}

/** Great-circle distance in kilometres between two points. */
export function haversineKm(a: LonLat, b: LonLat): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
