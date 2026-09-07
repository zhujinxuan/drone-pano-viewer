import { useCallback, useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import { CompassPlugin } from "@photo-sphere-viewer/compass-plugin";
import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/compass-plugin/index.css";
import type { PhotoEntry, PhotosManifest } from "./lib/types";
import { formatDistanceHud, groundDistance } from "./lib/ground-distance";
import { cameraSourceText, formatCopyRecord, type CameraFix } from "./lib/copy-record";
import {
  createEntity,
  deleteEntity,
  featureVertices,
  forPhoto,
  parseAnnotations,
  relabelEntity,
  serializeAnnotations,
  type AnnCollection,
  type AnnDraft,
  type AnnFeature,
  type AnnKind,
} from "./lib/annotations";
import { centroidView, groundTarget, type GroundCam } from "./lib/ground-capture";
import MetadataPanel from "./components/MetadataPanel";
import NavStrip from "./components/NavStrip";
import AnnotationOverlay, { swingTo } from "./components/AnnotationOverlay";
import AnnotationPanel from "./components/AnnotationPanel";

const DEG = 180 / Math.PI;
const FLASH_MS = 1250;

declare global {
  interface Window {
    /** Live PSV viewer, exposed for debugging/e2e probes. */
    __psv?: Viewer;
  }
}
/** Drag-guard for click-to-add: a click whose mousedown moved farther than
 * this (px) was a look-around drag, not an add. */
const CLICK_SLOP_PX = 6;

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
  const [gpsFix, setGpsFix] = useState<CameraFix | null>(null);
  const [copied, setCopied] = useState(false);
  // App-wide north offset (ticket 02): ?north= > localStorage > 0.
  const [northOffset, setNorthOffset] = useState<number>(() => {
    const p = new URLSearchParams(window.location.search).get("north");
    if (p !== null && Number.isFinite(Number(p))) return Number(p);
    const s = window.localStorage.getItem("pano.northOffsetDeg");
    return s !== null && Number.isFinite(Number(s)) ? Number(s) : 0;
  });
  // The viewer effect must read the offset without re-creating the viewer.
  const northOffsetRef = useRef(northOffset);
  const [flash, setFlash] = useState<{ n: number; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const zoomRef = useRef<number | null>(null);
  const flashSeq = useRef(0);

  // --- Annotations (.scratch/annotations/spec.md) ---
  // `anns` null = outbox not loaded → annotation disabled, never save (a
  // failed load must never clobber the file with an empty rewrite).
  const [anns, setAnns] = useState<AnnCollection | null>(null);
  const annsRef = useRef<AnnCollection | null>(null);
  const [mode, setMode] = useState<AnnKind | null>(null);
  const [draftVerts, setDraftVerts] = useState<[number, number][]>([]);
  const [draftErrs, setDraftErrs] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ feature: AnnFeature; index: number } | null>(null);
  const [pendingLabelForId, setPendingLabelForId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [saveState, setSaveState] = useState<"saving" | "saved" | null>(null);
  const [rejectActive, setRejectActive] = useState(false);
  // The Viewer also lives in state so the overlay re-mounts per pano.
  const [viewerObj, setViewerObj] = useState<Viewer | null>(null);
  const hudRef = useRef(hud);
  const saveTimer = useRef<number | null>(null);
  const rejectTimer = useRef<number | null>(null);

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

  // Camera fix for measurement + capture: XMP GPS when the panel has it,
  // else the geohash8 stem fallback (same precedence as the copy record).
  const camFix: CameraFix | null =
    gpsFix ??
    (current !== null && current.lon !== null && current.lat !== null
      ? { lat: current.lat, lon: current.lon, source: "geohash" }
      : null);
  const groundCam: GroundCam | null =
    camFix !== null && relAlt !== null && relAlt > 0 ? { ...camFix, relAltM: relAlt } : null;
  // Annotation needs a loaded outbox, a camera position and an altitude.
  const canAnnotate = current !== null && groundCam !== null && anns !== null;
  const annCam: AnnDraft["cam"] | null =
    groundCam === null
      ? null
      : {
          lat: groundCam.lat,
          lon: groundCam.lon,
          src: cameraSourceText(groundCam),
          relAltM: groundCam.relAltM,
        };
  const currentFeatures =
    anns !== null && current !== null ? forPhoto(anns, current.id) : [];

  // Each pano carries its own EXIF capture time and XMP altitude. A switch
  // also discards the in-progress shape (spec §Small print) and the
  // selection (entities are per-photo).
  useEffect(() => {
    setCaptureTime(null);
    setRelAlt(null);
    setGpsFix(null);
    setDraftVerts([]);
    setDraftErrs([]);
    setSelectedId(null);
    setPendingLabelForId(null);
    setDeleted(null);
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

  // Boot-load the annotations outbox (spec §File contract: load-then-rewrite).
  // On failure annotation stays disabled rather than risking a clobbering
  // save over an unreadable file; the server already maps missing/corrupt
  // files to an empty v1 collection.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/annotations")
      .then((r) =>
        r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((json) => {
        if (cancelled) return;
        const c = parseAnnotations(json);
        annsRef.current = c;
        setAnns(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // (The single global keydown listener lives below the annotation ops —
  //  it needs their callbacks; nav keys merged into it, ticket 07 item 4.)

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

  // Persist + mirror into ?north in the change handler itself — a mount-time
  // effect would make a one-off ?north= override silently overwrite the
  // stored value (and is StrictMode-double-effect fragile).
  const changeNorthOffset = useCallback((deg: number) => {
    setNorthOffset(deg);
    window.localStorage.setItem("pano.northOffsetDeg", String(deg));
    const url = new URL(window.location.href);
    if (deg === 0) url.searchParams.delete("north");
    else url.searchParams.set("north", String(deg));
    window.history.replaceState(null, "", url);
  }, []);

  // Apply the offset to the live sphere; construction covers pano switches.
  useEffect(() => {
    northOffsetRef.current = northOffset;
    viewerRef.current?.setOption("sphereCorrection", {
      pan: (northOffset * Math.PI) / 180,
      tilt: 0,
      roll: 0,
    });
  }, [northOffset]);

  /** Copy the full measurement record (ticket 01) to the clipboard. */
  const copyRecord = useCallback(() => {
    if (current === null) return;
    const t = groundTarget(groundCam, hud.yaw * DEG, hud.pitch * DEG);
    const line = formatCopyRecord({
      id: current.id,
      fix: camFix,
      yawDeg: hud.yaw * DEG,
      pitchDeg: hud.pitch * DEG,
      fovDeg: hud.fov,
      distText: formatDistanceHud(groundDistance(relAlt, hud.pitch)),
      target: t,
      errorM: t === null ? null : t.errM,
      northOffsetDeg: northOffset,
    });
    navigator.clipboard.writeText(line).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1000);
      },
      () => {},
    );
  }, [current, relAlt, hud, camFix, groundCam, northOffset]);

  /** Debounced full-file autosave — every mutation rewrites the outbox
   *  (spec §File contract; atomic on the server side). */
  const scheduleSave = useCallback((next: AnnCollection) => {
    setSaveState("saving");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeAnnotations(next),
      })
        .then((r) => setSaveState(r.ok ? "saved" : null))
        .catch(() => setSaveState(null));
    }, 300);
  }, []);

  const mutateAnns = useCallback(
    (next: AnnCollection) => {
      annsRef.current = next;
      setAnns(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  /** Red reticle flash (~400 ms) when the aim has no ground point. */
  const flashReject = useCallback(() => {
    setRejectActive(true);
    if (rejectTimer.current !== null) window.clearTimeout(rejectTimer.current);
    rejectTimer.current = window.setTimeout(() => setRejectActive(false), 400);
  }, []);

  /**
   * Add a vertex at the aimed ground point (reticle yaw/pitch or a
   * drag-guarded click). Point mode finishes immediately and opens the
   * label input; line/polygon accumulate until Enter. No ground point →
   * reject flash, no vertex (spec §Reject flash).
   */
  const addVertex = useCallback(
    (yawDeg: number, pitchDeg: number) => {
      const store = annsRef.current;
      if (mode === null || groundCam === null || current === null || store === null || annCam === null)
        return;
      const t = groundTarget(groundCam, yawDeg, pitchDeg);
      if (t === null) {
        flashReject();
        return;
      }
      if (mode === "point") {
        const { collection, feature } = createEntity(store, {
          kind: "point",
          photo: current.id,
          photoTitle: title,
          cam: annCam,
          vertices: [[t.lon, t.lat]],
          vertexErrM: [t.errM],
        });
        mutateAnns(collection);
        setSelectedId(feature.properties.id);
        setPendingLabelForId(feature.properties.id);
      } else {
        setDraftVerts((v) => [...v, [t.lon, t.lat]]);
        setDraftErrs((e) => [...e, t.errM]);
      }
    },
    [mode, groundCam, current, title, annCam, mutateAnns, flashReject],
  );
  // The viewer's click listener (created per pano) calls through this ref.
  const addVertexRef = useRef(addVertex);
  useEffect(() => {
    addVertexRef.current = addVertex;
  });

  const clearDraft = useCallback(() => {
    setDraftVerts([]);
    setDraftErrs([]);
  }, []);

  /** Enter: finish at ≥ min vertices → entity + label input; else cancel. */
  const finishDraft = useCallback(() => {
    if (mode !== "line" && mode !== "polygon") return;
    const store = annsRef.current;
    const min = mode === "line" ? 2 : 3;
    if (
      store !== null &&
      current !== null &&
      annCam !== null &&
      draftVerts.length >= min
    ) {
      const { collection, feature } = createEntity(store, {
        kind: mode,
        photo: current.id,
        photoTitle: title,
        cam: annCam,
        vertices: draftVerts,
        vertexErrM: draftErrs,
      });
      mutateAnns(collection);
      setSelectedId(feature.properties.id);
      setPendingLabelForId(feature.properties.id);
    }
    clearDraft();
  }, [mode, draftVerts, draftErrs, current, title, annCam, mutateAnns, clearDraft]);

  const undoVertex = useCallback(() => {
    setDraftVerts((v) => v.slice(0, -1));
    setDraftErrs((e) => e.slice(0, -1));
  }, []);

  /** Instant delete + 5 s undo toast (spec §Delete). */
  const deleteEntityById = useCallback(
    (id: string) => {
      const store = annsRef.current;
      if (store === null) return;
      const index = store.features.findIndex((f) => f.properties.id === id);
      if (index < 0) return;
      const feature = store.features[index];
      mutateAnns(deleteEntity(store, id));
      setDeleted({ feature, index });
      if (selectedId === id) setSelectedId(null);
      if (pendingLabelForId === id) setPendingLabelForId(null);
    },
    [mutateAnns, selectedId, pendingLabelForId],
  );

  /** Same-id restore — the consumer sees vanish-then-return; its upsert
   *  handles resurrection (spec §Small print). */
  const undoDelete = useCallback(() => {
    const store = annsRef.current;
    if (store === null || deleted === null) return;
    const features = [...store.features];
    features.splice(Math.min(deleted.index, features.length), 0, deleted.feature);
    mutateAnns({ ...store, features });
    setDeleted(null);
  }, [deleted, mutateAnns]);

  const handleLabelChange = useCallback(
    (id: string, label: string) => {
      const store = annsRef.current;
      if (store === null) return;
      mutateAnns(relabelEntity(store, id, label));
      if (pendingLabelForId === id) setPendingLabelForId(null);
    },
    [mutateAnns, pendingLabelForId],
  );

  /** Swing the camera onto an entity without touching the selection. */
  const lookAtFeature = useCallback(
    (id: string) => {
      const store = annsRef.current;
      const viewer = viewerRef.current;
      if (store === null || viewer === null || groundCam === null) return;
      const f = store.features.find((x) => x.properties.id === id);
      if (f === undefined) return;
      const view = centroidView(groundCam, featureVertices(f));
      if (view !== null) swingTo(viewer, view);
    },
    [groundCam],
  );

  /** List click: select + swing the camera onto the entity (spec §Q12). */
  const selectAndSwing = useCallback(
    (id: string) => {
      setSelectedId(id);
      lookAtFeature(id);
    },
    [lookAtFeature],
  );

  // The one global keydown listener: photo nav (`[`/`]`/`p`/`n`) plus the
  // annotation keymap (spec §Capture & interaction / §Selection). Input
  // targets are skipped, so label typing never draws or navigates. Space/Tab
  // are preventDefaulted against scroll/focus moves; PSV owns arrows and
  // +/-, none of these collide.
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
      } else if (e.key === " " && mode !== null) {
        e.preventDefault();
        addVertexRef.current(hudRef.current.yaw * DEG, hudRef.current.pitch * DEG);
      } else if (e.key === "Enter" && (mode === "line" || mode === "polygon")) {
        e.preventDefault();
        finishDraft();
      } else if ((e.key === "u" || e.key === "Backspace") && draftVerts.length > 0) {
        e.preventDefault();
        undoVertex();
      } else if (e.key === "Escape") {
        if (draftVerts.length > 0) clearDraft();
        else if (mode !== null) setMode(null);
      } else if ((e.key === "Delete" || e.key === "d") && selectedId !== null) {
        e.preventDefault();
        deleteEntityById(selectedId);
      } else if (e.key === "l" && selectedId !== null) {
        setPendingLabelForId(selectedId);
        setPanelOpen(true);
      } else if (e.key === "Tab" && current !== null && annsRef.current !== null) {
        const feats = forPhoto(annsRef.current, current.id);
        if (feats.length === 0) return;
        e.preventDefault();
        const idx = feats.findIndex((f) => f.properties.id === selectedId);
        setSelectedId(feats[(idx + 1) % feats.length].properties.id);
      } else if (e.key === "e") {
        setPanelOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, mode, draftVerts.length, selectedId, current, finishDraft, undoVertex, clearDraft, deleteEntityById]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || panoramaUrl === null) return;

    const viewer = new Viewer({
      container,
      panorama: panoramaUrl,
      navbar: ["zoom", "move", "fullscreen"],
      keyboard: "always",
      sphereCorrection: { pan: (northOffsetRef.current * Math.PI) / 180, tilt: 0, roll: 0 },
      plugins: [CompassPlugin.withConfig({ position: "bottom left", size: "110px" })],
    });
    viewerRef.current = viewer;
    setViewerObj(viewer);
    window.__psv = viewer;

    // Click-to-add vertex: fire only for genuine clicks — a drag that
    // rotated the view is look-around, not an add (spec §Capture input).
    let downX = 0;
    let downY = 0;
    const onDown = (ev: MouseEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    container.addEventListener("mousedown", onDown);
    viewer.addEventListener("click", (ev) => {
      const d = ev.data;
      if (d.rightclick) return;
      if (Math.hypot(d.clientX - downX, d.clientY - downY) > CLICK_SLOP_PX) return;
      addVertexRef.current(d.yaw * DEG, d.pitch * DEG);
    });

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
        const snap = { ...latest };
        hudRef.current = snap;
        setHud(snap);
      }
    }, 100);

    return () => {
      window.clearInterval(timer);
      container.removeEventListener("mousedown", onDown);
      viewerRef.current = null;
      setViewerObj(null);
      viewer.destroy();
    };
  }, [panoramaUrl, nextUrl]);

  return (
    <div className="app">
      <div className="viewer-wrap">
        <div ref={containerRef} className="viewer" />
        {title !== "" && <div className="title-banner">{title}</div>}
        {panoramaUrl !== null && (
          <div className={rejectActive ? "reticle reject" : "reticle"} aria-hidden="true" />
        )}
        <div
          className="hud"
          aria-live="polite"
          title="dist: flat-ground estimate from this pano's XMP RelativeAltitude (height above takeoff). Slopes and buildings degrade it, especially at shallow pitch. Copy payload error model: ±(h·0.1°/sin²|pitch| + 1 m/tan|pitch| + position σ) along-track."
        >
          <span>
            yaw {(hud.yaw * DEG).toFixed(1)}° · pitch {(hud.pitch * DEG).toFixed(1)}° · fov{" "}
            {hud.fov.toFixed(1)}° · dist {formatDistanceHud(groundDistance(relAlt, hud.pitch))}
          </span>
          <button
            type="button"
            className="hud-copy"
            onClick={copyRecord}
            title="Copy the full measurement record (camera · angles · dist · target WGS84 ±error)"
          >
            {copied ? "✓" : "copy"}
          </button>
          {saveState !== null && (
            <span className="ann-save" title="Annotations autosave">
              {saveState === "saving" ? "saving…" : "saved ✓"}
            </span>
          )}
        </div>
        {panoramaUrl !== null && (
          <MetadataPanel
            imageUrl={panoramaUrl}
            onCaptureTime={setCaptureTime}
            onRelativeAltitude={setRelAlt}
            onGpsFix={setGpsFix}
            northOffset={northOffset}
            onNorthOffsetChange={changeNorthOffset}
          />
        )}
        {viewerObj !== null && current !== null && (
          <AnnotationOverlay
            viewer={viewerObj}
            cam={groundCam}
            features={currentFeatures.map((f) => ({
              id: f.properties.id,
              kind: f.properties.kind,
              label: f.properties.label,
              vertices: featureVertices(f),
            }))}
            inProgress={
              mode === "line" || mode === "polygon"
                ? { kind: mode, vertices: draftVerts }
                : null
            }
            selectedId={selectedId}
          />
        )}
        {photos !== null && (
          <AnnotationPanel
            features={currentFeatures}
            mode={mode}
            onModeChange={(m) => {
              setMode(m);
              clearDraft();
            }}
            canAnnotate={canAnnotate}
            inProgress={
              mode === "line" || mode === "polygon"
                ? { kind: mode, vertexCount: draftVerts.length }
                : null
            }
            onFinish={finishDraft}
            onUndoVertex={undoVertex}
            selectedId={selectedId}
            onSelect={selectAndSwing}
            onLookAt={lookAtFeature}
            onLabelChange={handleLabelChange}
            onDelete={deleteEntityById}
            toast={
              deleted !== null
                ? { id: deleted.feature.properties.id, label: deleted.feature.properties.label }
                : null
            }
            onUndoDelete={undoDelete}
            onDismissToast={() => setDeleted(null)}
            pendingLabelForId={pendingLabelForId}
            onPendingLabelDone={() => setPendingLabelForId(null)}
            open={panelOpen}
            onOpenChange={setPanelOpen}
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
