/**
 * Image metadata parse seam (`.scratch/metadata-panel/issues/01`): exifr
 * with the drone-dji XMP safety net, hardened so the panel ALWAYS settles.
 *
 * Two exifr failure modes must not escape: `parse` can throw SYNCHRONOUSLY
 * on malformed files (a `.catch` on the returned promise never sees it —
 * hence the try/catch around the await), and it can resolve `undefined`
 * (a bare `in` check would throw). Both degrade to "no exifr output" and
 * fall through to the XMP regex fallback.
 */
import exifr from "exifr";

export type Meta = Record<string, unknown>;

/** drone-dji XMP keys used to detect whether exifr surfaced the DJI block. */
const DJI_KEYS = [
  "GimbalPitchDegree",
  "GimbalYawDegree",
  "GimbalRollDegree",
  "FlightPitchDegree",
  "FlightYawDegree",
  "FlightRollDegree",
  "AbsoluteAltitude",
  "RelativeAltitude",
  "GpsStatus",
  "UTCAtExposure",
] as const;

function coerceNum(out: Meta, key: string, raw: string): void {
  const v = raw.trim();
  out[key] = /^[-+]?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
}

/**
 * exifr normally surfaces every `drone-dji:*` attribute at the top level
 * (verified against a Matrice 4T pano); this is the safety net for files
 * where it does not: pull the JPEG and regex the XMP packet directly.
 */
async function extractDjiXmp(url: string): Promise<Meta> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const text = new TextDecoder("latin1").decode(await res.arrayBuffer());
  const start = text.indexOf("<x:xmpmeta");
  const end = text.indexOf("</x:xmpmeta>");
  if (start < 0 || end < 0) return {};
  const xmp = text.slice(start, end);
  const out: Meta = {};
  // Adobe packet form: drone-dji:Key="value"
  for (const m of xmp.matchAll(/\bdrone-dji:([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) {
    coerceNum(out, m[1], m[2]);
  }
  // RDF element form: <drone-dji:Key>value</drone-dji:Key>
  for (const m of xmp.matchAll(/<drone-dji:([A-Za-z0-9_]+)>([^<]*)<\/drone-dji:\1>/g)) {
    if (!(m[1] in out)) coerceNum(out, m[1], m[2]);
  }
  return out;
}

/**
 * Parse EXIF/XMP for one image: exifr first, the XMP regex fallback when
 * exifr produced nothing or missed the DJI block. Never throws — every
 * failure path settles to `null` ("no usable metadata") so callers can
 * degrade loudly instead of hanging.
 */
export async function parseImageMeta(url: string): Promise<Meta | null> {
  let exifrOut: Meta | null;
  try {
    exifrOut = ((await exifr.parse(url, { xmp: true, gps: true })) as Meta | undefined) ?? null;
  } catch {
    exifrOut = null;
  }
  let m: Meta | null = exifrOut;
  if (exifrOut === null || !DJI_KEYS.some((k) => k in exifrOut)) {
    try {
      const xmp = await extractDjiXmp(url);
      m = Object.keys(xmp).length > 0 ? { ...xmp, ...m } : m;
    } catch {
      /* keep whatever exifr produced */
    }
  }
  return m;
}
