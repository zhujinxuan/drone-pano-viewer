import { useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import { CompassPlugin } from "@photo-sphere-viewer/compass-plugin";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/compass-plugin/index.css";
import type { PhotoEntry } from "./lib/types";
import MetadataPanel from "./components/MetadataPanel";

const DEG = 180 / Math.PI;

interface HudState {
  yaw: number;
  pitch: number;
  fov: number;
}

/**
 * Drone panorama viewer shell.
 *
 * URL params: `?id=<geohash8>&title=<text>` — `id` selects the pano (falls
 * back to the first photo in the manifest), `title` overrides the banner;
 * the default title is the id plus the EXIF capture time reported by the
 * MetadataPanel via `onCaptureTime`.
 */
export default function App() {
  const [photos, setPhotos] = useState<PhotoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<HudState>({ yaw: 0, pitch: 0, fov: 90 });
  const [captureTime, setCaptureTime] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [params] = useState(() => new URLSearchParams(window.location.search));
  const idParam = params.get("id");

  const current = photos === null ? null : (photos.find((p) => p.id === idParam) ?? photos[0]);
  const timeText = captureTime === null ? "" : ` · ${captureTime.slice(0, 19).replace("T", " ")}`;
  const title = params.get("title") ?? `${current?.id ?? ""}${timeText}`;
  const panoramaUrl = current?.url ?? null;

  // Each pano carries its own EXIF capture time.
  useEffect(() => {
    setCaptureTime(null);
  }, [panoramaUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/photos")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PhotoEntry[]>;
      })
      .then((list) => {
        if (!cancelled) setPhotos(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || panoramaUrl === null) return;

    const viewer = new Viewer({
      container,
      panorama: panoramaUrl,
      navbar: ["zoom", "move", "fullscreen"],
      plugins: [CompassPlugin.withConfig({ position: "bottom left", size: "110px" })],
    });

    // Live yaw/pitch/FOV overlay — events write into `latest`, a 10 Hz timer
    // pushes it into React state so drags don't trigger a render storm.
    const latest: HudState = { yaw: 0, pitch: 0, fov: 90 };
    const seed = () => {
      const pos = viewer.getPosition();
      latest.yaw = pos.yaw;
      latest.pitch = pos.pitch;
      latest.fov = viewer.dataHelper.zoomLevelToFov(viewer.getZoomLevel());
    };
    viewer.addEventListener("ready", seed);
    viewer.addEventListener("position-updated", (e) => {
      latest.yaw = e.position.yaw;
      latest.pitch = e.position.pitch;
    });
    viewer.addEventListener("zoom-updated", (e) => {
      latest.fov = viewer.dataHelper.zoomLevelToFov(e.zoomLevel);
    });
    let lastPush = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - lastPush >= 100) {
        lastPush = now;
        setHud({ ...latest });
      }
    }, 100);

    return () => {
      window.clearInterval(timer);
      viewer.destroy();
    };
  }, [panoramaUrl]);

  return (
    <div className="app">
      <div className="viewer-wrap">
        <div ref={containerRef} className="viewer" />
        {title !== "" && <div className="title-banner">{title}</div>}
        <div className="hud" aria-live="polite">
          yaw {(hud.yaw * DEG).toFixed(1)}° · pitch {(hud.pitch * DEG).toFixed(1)}° · fov{" "}
          {hud.fov.toFixed(1)}°
        </div>
        {panoramaUrl !== null && (
          <MetadataPanel imageUrl={panoramaUrl} onCaptureTime={setCaptureTime} />
        )}
      </div>
      {error !== null && (
        <div className="overlay-msg">
          <div>
            <strong>Failed to load the photo manifest</strong>
            <div className="overlay-detail">{error}</div>
          </div>
        </div>
      )}
      {error === null && photos !== null && photos.length === 0 && (
        <div className="overlay-msg">
          <div>
            <strong>No panoramas found</strong>
            <div className="overlay-detail">The photos dir is empty or its DVC objects are not pulled.</div>
          </div>
        </div>
      )}
      {error === null && photos === null && <div className="overlay-msg">Loading…</div>}
    </div>
  );
}
