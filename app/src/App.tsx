import { useCallback, useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import { CompassPlugin } from "@photo-sphere-viewer/compass-plugin";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/compass-plugin/index.css";
import type { PhotoEntry, PhotosManifest } from "./lib/types";
import { formatDistanceHud, groundDistance } from "./lib/ground-distance";
import MetadataPanel from "./components/MetadataPanel";
import NavStrip from "./components/NavStrip";

const DEG = 180 / Math.PI;
const FLASH_MS = 1250;

interface HudState {
  yaw: number;
  pitch: number;
  fov: number;
}

interface ErrorState {
  title: string;
  detail: string;
}

/**
 * Drone panorama viewer shell.
 *
 * URL params: `?pos=N` (0-based, primary) selects the pano; `?id=<stem>` is
 * the legacy form and resolves to its index; `?title=<text>` overrides the
 * banner title. Title precedence: `?title` > playlist entry title >
 * `id · EXIF capture time` (reported by the MetadataPanel via
 * `onCaptureTime`). Switching panos (`[`/`]`, `p`/`n`, nav strip) keeps the
 * zoom level, resets yaw/pitch, flashes the new title and updates `?pos`.
 */
export default function App() {
  const [photos, setPhotos] = useState<PhotoEntry[] | null>(null);
  const [pos, setPos] = useState<number | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [hud, setHud] = useState<HudState>({ yaw: 0, pitch: 0, fov: 90 });
  const [captureTime, setCaptureTime] = useState<string | null>(null);
  const [relAlt, setRelAlt] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ n: number; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const zoomRef = useRef<number | null>(null);
  const flashSeq = useRef(0);

  const [params] = useState(() => new URLSearchParams(window.location.search));
  const titleParam = params.get("title");

  const current =
    photos === null || pos === null || photos.length === 0 ? null : photos[pos];
  const next =
    photos === null || photos.length === 0 ? null : photos[((pos ?? 0) + 1) % photos.length];
  const nextTitle = next === null ? null : (next.title ?? next.id);
  const nextUrl = next?.url ?? null;
  const timeText = captureTime === null ? "" : ` · ${captureTime.slice(0, 19).replace("T", " ")}`;
  const title =
    titleParam ?? current?.title ?? `${current?.id ?? ""}${timeText}`;
  const panoramaUrl = current?.url ?? null;

  // Each pano carries its own EXIF capture time and XMP altitude.
  useEffect(() => {
    setCaptureTime(null);
    setRelAlt(null);
  }, [panoramaUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/photos")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PhotosManifest>;
      })
      .then((manifest) => {
        if (cancelled) return;
        const list = manifest.photos;
        const posParam = params.get("pos");
        const idParam = params.get("id");
        let idx = 0;
        const posNum = posParam === null ? NaN : Number(posParam);
        if (posParam !== null && posParam.trim() !== "" && Number.isInteger(posNum) && posNum >= 0) {
          idx = Math.min(posNum, Math.max(0, list.length - 1));
        } else if (idParam !== null) {
          const found = list.findIndex((p) => p.id === idParam);
          if (found >= 0) {
            idx = found;
          } else if (manifest.playlist) {
            setError({
              title: "Pano not found",
              detail: `No panorama with id "${idParam}" in the playlist.`,
            });
            return;
          }
        }
        setPhotos(list);
        setPos(idx);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError({
            title: "Failed to load the photo manifest",
            detail: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  // Keep `?pos` in sync so a refresh keeps the place; `pos` supersedes `id`.
  useEffect(() => {
    if (pos === null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("pos", String(pos));
    url.searchParams.delete("id");
    window.history.replaceState(null, "", url);
  }, [pos]);

  /**
   * Switch panorama: remember the zoom level to re-apply after the new
   * viewer is ready (yaw/pitch reset to default), then move `pos` with
   * wrap-around.
   */
  const navigate = useCallback(
    (delta: number) => {
      const total = photos?.length ?? 0;
      if (total <= 1) return;
      const zoom = viewerRef.current?.getZoomLevel();
      if (zoom !== undefined) zoomRef.current = zoom;
      setPos((p) => ((((p ?? 0) + delta) % total) + total) % total);
    },
    [photos],
  );

  // `[` / `p` = previous, `]` / `n` = next. PSV owns arrows and +/-; these
  // keys never collide. Skipped while loading or for single-photo manifests.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "]" || e.key === "n") {
        e.preventDefault();
        navigate(1);
      } else if (e.key === "[" || e.key === "p") {
        e.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // Flash the new title large center-screen on every pano change, fading
  // out via CSS animation. Fires on `panoramaUrl` only — the EXIF capture
  // time arrives later and settles into the top banner instead.
  useEffect(() => {
    if (panoramaUrl === null) return;
    const text = titleParam ?? current?.title ?? current?.id ?? "";
    if (text === "") return;
    flashSeq.current += 1;
    setFlash({ n: flashSeq.current, text });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panoramaUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || panoramaUrl === null) return;

    const viewer = new Viewer({
      container,
      panorama: panoramaUrl,
      navbar: ["zoom", "move", "fullscreen"],
      keyboard: "always",
      plugins: [CompassPlugin.withConfig({ position: "bottom left", size: "110px" })],
    });
    viewerRef.current = viewer;

    // Live yaw/pitch/FOV overlay — events write into `latest`, a 10 Hz timer
    // pushes it into React state so drags don't trigger a render storm.
    const latest: HudState = { yaw: 0, pitch: 0, fov: 90 };
    const seed = () => {
      const p = viewer.getPosition();
      latest.yaw = p.yaw;
      latest.pitch = p.pitch;
      latest.fov = viewer.dataHelper.zoomLevelToFov(viewer.getZoomLevel());
    };
    viewer.addEventListener("ready", () => {
      // Carry the zoom level across the switch; yaw/pitch stay default.
      if (zoomRef.current !== null) viewer.zoom(zoomRef.current);
      seed();
      // Background-preload the next pano so `]` feels instant.
      if (nextUrl !== null && nextUrl !== panoramaUrl) {
        const img = new Image();
        img.src = nextUrl;
      }
    });
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
      viewerRef.current = null;
      viewer.destroy();
    };
  }, [panoramaUrl, nextUrl]);

  return (
    <div className="app">
      <div className="viewer-wrap">
        <div ref={containerRef} className="viewer" />
        {title !== "" && <div className="title-banner">{title}</div>}
        {panoramaUrl !== null && <div className="reticle" aria-hidden="true" />}
        <div
          className="hud"
          aria-live="polite"
          title="dist: flat-ground estimate from this pano's XMP RelativeAltitude (height above takeoff). Slopes and buildings degrade it, especially at shallow pitch."
        >
          yaw {(hud.yaw * DEG).toFixed(1)}° · pitch {(hud.pitch * DEG).toFixed(1)}° · fov{" "}
          {hud.fov.toFixed(1)}° · dist {formatDistanceHud(groundDistance(relAlt, hud.pitch))}
        </div>
        {panoramaUrl !== null && (
          <MetadataPanel
            imageUrl={panoramaUrl}
            onCaptureTime={setCaptureTime}
            onRelativeAltitude={setRelAlt}
          />
        )}
        <NavStrip
          pos={pos ?? 0}
          total={photos?.length ?? 0}
          nextTitle={nextTitle}
          onPrev={() => navigate(-1)}
          onNext={() => navigate(1)}
        />
        {flash !== null && (
          <div key={flash.n} className="title-flash">
            {flash.text}
          </div>
        )}
      </div>
      {error !== null && (
        <div className="overlay-msg">
          <div>
            <strong>{error.title}</strong>
            <div className="overlay-detail">{error.detail}</div>
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
