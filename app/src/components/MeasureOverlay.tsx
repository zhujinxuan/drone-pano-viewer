/**
 * Measure overlay (`.scratch/reference-layers/spec.md` §Measure mode,
 * ticket 05): the ephemeral A→B ground measurement on the pano — dashed
 * rubber-band line, endpoint ring markers, and a DOM readout chip
 * (distance · bearing · ±err, formatted by `lib/measure.ts`) projected at
 * the measured end point.
 *
 * Render discipline mirrors `AnnotationOverlay` (spec §Client behavior):
 * `vertexView` flat-ground projection onto the sphere, full rebuild on prop
 * change, full disposal on teardown, and the chip driven per frame by the
 * PSV "render" event (direct style writes, no per-frame React state).
 * Nothing here is persisted — a measurement is not an annotation.
 */
import { useEffect, useRef } from "react";
import { CONSTANTS } from "@photo-sphere-viewer/core";
import type { Viewer } from "@photo-sphere-viewer/core";
import {
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineDashedMaterial,
  Material,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { vertexView, type OverlayCam } from "../lib/overlay-geometry";
import type { MeasurePoint } from "../lib/measure";
import "./MeasureOverlay.css";

export interface MeasureOverlayProps {
  viewer: Viewer;
  cam: OverlayCam | null;
  /** Captured point A; no A → nothing renders. */
  a: MeasurePoint | null;
  /**
   * The measured end point — captured B once set, else the live reticle aim.
   * The caller (App) owns the `B ?? aim` fallback; the overlay renders what
   * it is given.
   */
  end: MeasurePoint | null;
  /** Formatted chip text; the chip hides when null. */
  chipText: string | null;
}

/** Pink — distinct from every annotation kind color and the yellow sketch. */
const MEASURE_COLOR = 0xff7edb;
/** Overlay radius: just inside the photo sphere (same as annotations). */
const RADIUS = CONSTANTS.SPHERE_RADIUS - 0.08;
/** Endpoint ring sprite size on the RADIUS=9.92 sphere. */
const RING_SCALE = 0.14;
/**
 * Hollow white ring with a dark rim: a captured measure endpoint. Rings,
 * not the annotation dot — the two overlays must stay readable when both
 * are on screen.
 */
function makeRingTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.beginPath();
    ctx.arc(32, 32, 19, 0, Math.PI * 2);
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(32, 32, 19, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  return new CanvasTexture(canvas);
}

export default function MeasureOverlay({ viewer, cam, a, end, chipText }: MeasureOverlayProps) {
  const chipRef = useRef<HTMLDivElement | null>(null);

  // Three.js scene graph: dashed rubber band + endpoint rings, rebuilt on
  // every prop change, disposed on teardown/rebuild — nothing survives a
  // photo switch or a mode exit.
  useEffect(() => {
    const group = new Group();
    const geometries: BufferGeometry[] = [];
    const materials: Material[] = [];
    const textures: CanvasTexture[] = [];

    if (cam !== null && a !== null && end !== null) {
      const toV3 = (p: MeasurePoint): Vector3 => {
        const ray = vertexView(cam, [p.lon, p.lat]);
        return viewer.dataHelper.sphericalCoordsToVector3(
          { yaw: ray.yawRad, pitch: ray.pitchRad },
          new Vector3(),
          RADIUS,
        );
      };
      const pa = toV3(a);
      const pe = toV3(end);

      const lineMat = new LineDashedMaterial({
        color: MEASURE_COLOR,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      materials.push(lineMat);
      const geom = new BufferGeometry();
      geometries.push(geom);
      geom.setFromPoints([pa, pe]);
      const line = new Line(geom, lineMat);
      line.computeLineDistances();
      group.add(line);

      const texture = makeRingTexture();
      textures.push(texture);
      for (const position of [pa, pe]) {
        const mat = new SpriteMaterial({
          map: texture,
          color: MEASURE_COLOR,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        materials.push(mat);
        const sprite = new Sprite(mat);
        sprite.position.copy(position);
        sprite.scale.setScalar(RING_SCALE);
        group.add(sprite);
      }
    }

    viewer.renderer.addObject(group);
    viewer.needsUpdate();
    return () => {
      viewer.renderer.removeObject(group);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    };
  }, [viewer, cam, a, end]);

  // DOM chip: projected at the measured end (B, or the live aim while B is
  // unset) — the same per-frame projection as annotation labels.
  useEffect(() => {
    const chip = chipRef.current;
    if (chip === null || cam === null || end === null) return;
    const update = (): void => {
      const ray = vertexView(cam, [end.lon, end.lat]);
      const pos = { yaw: ray.yawRad, pitch: ray.pitchRad };
      const p = viewer.dataHelper.sphericalCoordsToViewerCoords(pos);
      chip.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -170%)`;
      chip.classList.toggle("is-hidden", !viewer.dataHelper.isPointVisible(pos));
    };
    update();
    viewer.addEventListener("render", update);
    return () => viewer.removeEventListener("render", update);
  }, [viewer, cam, end]);

  return (
    <div className="measure-overlay" aria-hidden="true">
      {a !== null && end !== null && chipText !== null && (
        <div ref={chipRef} className="measure-chip">
          {chipText}
        </div>
      )}
    </div>
  );
}
