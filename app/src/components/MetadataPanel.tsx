import { useEffect, useState } from "react";
import exifr from "exifr";

export interface MetadataPanelProps {
  imageUrl: string;
  /** Fires once per parse with UTCAtExposure (or DateTimeOriginal) as an ISO string, null when none found. */
  onCaptureTime?: (iso: string | null) => void;
  /** Fires once per parse with drone-dji RelativeAltitude in meters, null when absent. */
  onRelativeAltitude?: (m: number | null) => void;
}

type Meta = Record<string, unknown>;

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

/* ---------- formatting ---------- */

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = typeof v === "string" ? v.trim() : String(v);
  return s.length > 0 ? s : null;
};

/** Degrees: sign + 2 decimals, e.g. -90.00° / +179.10°. */
const deg = (v: unknown): string | null => {
  const n = num(v);
  return n === null ? null : `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(2)}°`;
};

/** Plain coordinate: no forced sign, `digits` decimals. */
const coord = (v: unknown, digits = 7): string | null => {
  const n = num(v);
  return n === null ? null : `${n.toFixed(digits)}°`;
};

/** DJI altitudes carry an explicit sign; keep it, 3 decimals. */
const alt = (v: unknown): string | null => {
  const n = num(v);
  return n === null ? null : `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(3)} m`;
};

/** ISO-ish timestamp → `YYYY-MM-DD HH:MM:SS[.fff] UTC` (space separator). */
const stamp = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v
      .toISOString()
      .replace("T", " ")
      .replace(/(\.\d{3})Z$/, "$1 UTC")
      .replace(/Z$/, " UTC");
  }
  const s = str(v);
  return s === null ? null : s.replace("T", " ").replace(/Z$/, " UTC");
};

/** DJI timestamps are UTC without a zone designator → viewer-local time. */
const localTime = (v: unknown): string | null => {
  const s = str(v);
  if (s === null) return null;
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { hour12: false });
};

/* ---------- XMP fallback (fetch raw bytes → regex over the XMP packet) ---------- */

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

/* ---------- grouping ---------- */

interface Row {
  label: string;
  value: string | null;
}

interface Group {
  title: string;
  rows: Row[];
}

function rtkStd(m: Meta): string | null {
  const lat = num(m.RtkStdLat);
  const lon = num(m.RtkStdLon);
  const hgt = num(m.RtkStdHgt);
  if (lat === null && lon === null && hgt === null) return null;
  const f = (n: number | null) => (n === null ? "–" : n.toFixed(3));
  return `${f(lat)} / ${f(lon)} / ${f(hgt)} m`;
}

function cameraLine(m: Meta): string | null {
  const parts = [str(m.ProductName), str(m.Model)].filter(
    (p, i, a): p is string => p !== null && a.indexOf(p) === i,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function buildGroups(m: Meta): Group[] {
  const group = (title: string, rows: Row[]): Group => ({
    title,
    rows: rows.filter((r) => r.value !== null),
  });
  const lrfDistance = num(m.LRFTargetDistance);
  const sensorTemp = num(m.SensorTemperature);

  const position = group("Position", [
    { label: "Latitude", value: coord(m.GpsLatitude ?? m.latitude, 8) },
    { label: "Longitude", value: coord(m.GpsLongitude ?? m.longitude, 8) },
    { label: "Altitude (abs)", value: alt(m.AbsoluteAltitude ?? m.GPSAltitude) },
    { label: "Altitude (rel)", value: alt(m.RelativeAltitude) },
    { label: "RTK status", value: str(m.GpsStatus) },
    { label: "RTK σ lat/lon/h", value: rtkStd(m) },
  ]);

  const attitude = group("Attitude", [
    { label: "Gimbal pitch", value: deg(m.GimbalPitchDegree) },
    { label: "Gimbal yaw", value: deg(m.GimbalYawDegree) },
    { label: "Gimbal roll", value: deg(m.GimbalRollDegree) },
    { label: "Flight yaw", value: deg(m.FlightYawDegree) },
    { label: "Flight pitch", value: deg(m.FlightPitchDegree) },
    { label: "Flight roll", value: deg(m.FlightRollDegree) },
  ]);

  const capture = group("Capture", [
    { label: "Exposure (UTC)", value: stamp(m.UTCAtExposure) },
    { label: "Exposure (local)", value: localTime(m.UTCAtExposure) },
    { label: "DateTimeOriginal", value: stamp(m.DateTimeOriginal) },
    { label: "Camera", value: cameraLine(m) },
    { label: "Sensor temp", value: sensorTemp === null ? null : `${sensorTemp.toFixed(1)} °C` },
  ]);

  const lrf = group("LRF", [
    { label: "Status", value: str(m.LRFStatus) },
    { label: "Target distance", value: lrfDistance === null ? null : `${lrfDistance.toFixed(2)} m` },
    { label: "Target latitude", value: coord(m.LRFTargetLat) },
    { label: "Target longitude", value: coord(m.LRFTargetLon) },
    { label: "Target alt (abs)", value: alt(m.LRFTargetAbsAlt) },
  ]);

  const hasLrf = m.LRFStatus != null || m.LRFTargetDistance != null;
  return [position, attitude, capture, ...(hasLrf ? [lrf] : [])].filter(
    (g) => g.rows.length > 0,
  );
}

/* ---------- component ---------- */

const CSS = `
.dji-mp-root{position:absolute;top:0;right:0;bottom:0;z-index:15;overflow:hidden;pointer-events:none;color:#e6e6ea}
.dji-mp-panel{pointer-events:auto;display:flex;flex-direction:column;width:300px;max-width:85vw;height:100%;background:rgba(15,16,20,.93);backdrop-filter:blur(10px);border-left:1px solid rgba(255,255,255,.08);transition:transform .22s ease}
.dji-mp-panel.dji-mp-closed{transform:translateX(102%)}
/* Keep the viewer's yaw/pitch/FOV HUD readable while the panel is open. */
.viewer-wrap:has(.dji-mp-panel:not(.dji-mp-closed)) .hud{right:312px}
.dji-mp-head{display:flex;align-items:flex-start;justify-content:space-between;padding:10px 10px 10px 14px;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer;user-select:none}
.dji-mp-title{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#9aa0ab}
.dji-mp-file{font-size:10.5px;color:#6b7078;margin-top:2px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dji-mp-toggle{pointer-events:auto;background:none;border:none;color:#9aa0ab;font-size:15px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:4px}
.dji-mp-toggle:hover{color:#e6e6ea;background:rgba(255,255,255,.07)}
.dji-mp-body{flex:1;overflow-y:auto;padding:4px 0 14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.dji-mp-body::-webkit-scrollbar{width:6px}
.dji-mp-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}
.dji-mp-group{margin-top:10px}
.dji-mp-group-title{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#8ab4f8;padding:2px 14px 4px}
.dji-mp-row{display:flex;justify-content:space-between;gap:10px;padding:2.5px 14px}
.dji-mp-row:hover{background:rgba(255,255,255,.045)}
.dji-mp-l{font-size:11.5px;color:#9aa0ab;white-space:nowrap}
.dji-mp-v{font-size:11.5px;color:#e6e6ea;font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.dji-mp-note{padding:16px 14px;font-size:11.5px;color:#9aa0ab;line-height:1.5}
.dji-mp-err{color:#f28b82}
.dji-mp-tab{pointer-events:auto;position:absolute;top:50%;right:0;transform:translateY(-50%);writing-mode:vertical-rl;background:rgba(15,16,20,.9);color:#9aa0ab;border:1px solid rgba(255,255,255,.08);border-right:none;border-radius:8px 0 0 8px;padding:14px 5px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
.dji-mp-tab:hover{color:#e6e6ea}
`;

export default function MetadataPanel({ imageUrl, onCaptureTime, onRelativeAltitude }: MetadataPanelProps) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMeta(null);
    (async () => {
      // const snapshot keeps TS's null-narrowing alive inside the .some() closure
      const exifrOut = await exifr.parse(imageUrl, { xmp: true, gps: true }).catch(() => null);
      let m: Meta | null = exifrOut;
      if (exifrOut === null || !DJI_KEYS.some((k) => k in exifrOut)) {
        try {
          const xmp = await extractDjiXmp(imageUrl);
          m = Object.keys(xmp).length > 0 ? { ...xmp, ...m } : m;
        } catch {
          /* keep whatever exifr produced */
        }
      }
      if (cancelled) return;
      if (m === null || Object.keys(m).length === 0) {
        setError("No EXIF/XMP metadata found in this file.");
        onCaptureTime?.(null);
        onRelativeAltitude?.(null);
      } else {
        setMeta(m);
        onCaptureTime?.(str(m.UTCAtExposure) ?? stamp(m.DateTimeOriginal));
        onRelativeAltitude?.(num(m.RelativeAltitude));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [imageUrl, onCaptureTime, onRelativeAltitude]);

  const groups = meta === null ? [] : buildGroups(meta);
  const fileName = decodeURIComponent(imageUrl.split("/").pop() ?? imageUrl);

  return (
    <div className="dji-mp-root">
      <style>{CSS}</style>
      <aside
        className={`dji-mp-panel${open ? "" : " dji-mp-closed"}`}
        aria-label="Photo metadata"
      >
        <div className="dji-mp-head" onClick={() => setOpen(false)} title="Collapse panel">
          <div>
            <div className="dji-mp-title">EXIF · XMP</div>
            <div className="dji-mp-file">{fileName}</div>
          </div>
          <button
            className="dji-mp-toggle"
            aria-label="Collapse metadata panel"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          >
            ›
          </button>
        </div>
        <div className="dji-mp-body">
          {loading && <div className="dji-mp-note">Parsing metadata…</div>}
          {!loading && error !== null && <div className="dji-mp-note dji-mp-err">{error}</div>}
          {!loading && error === null && groups.length === 0 && (
            <div className="dji-mp-note">No recognized DJI metadata.</div>
          )}
          {groups.map((g) => (
            <section className="dji-mp-group" key={g.title}>
              <div className="dji-mp-group-title">{g.title}</div>
              {g.rows.map((r) => (
                <div className="dji-mp-row" key={r.label}>
                  <span className="dji-mp-l">{r.label}</span>
                  <span className="dji-mp-v">{r.value}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>
      {!open && (
        <button className="dji-mp-tab" onClick={() => setOpen(true)} aria-label="Show metadata panel">
          EXIF · XMP
        </button>
      )}
    </div>
  );
}
