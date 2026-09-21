/**
 * Height overlay (`.scratch/vertical-measure/spec.md`, ticket 01): the
 * ephemeral vertical (tree-height) measurement on the pano — dashed
 * vertical line at the captured tree base A (ground → H), a base ring
 * marker, and a DOM readout chip (H · d · ±err, formatted by
 * `lib/height.ts`) projected at the top of the line.
 *
 * Render discipline mirrors `MeasureOverlay`: `vertexView` flat-ground
 * projection for A's yaw + ground pitch, full rebuild on prop change, full
 * disposal on teardown, and the chip driven per frame by the PSV "render"
 * event (direct style writes, no per-frame React state). The line is a
 * pitch arc at A's yaw: H = relAlt + d·tan(pitch_B) means pitch_B is by
 * construction the view pitch of the tree top, so the top point shares
 * A's yaw while B is live (rubber band) and fixed alike. Nothing here is
 * persisted.
 */
import { useEffect, useRef } from "react";
import { CONSTANTS } from "@photo-sphere-viewer/core";
import type { Viewer } from "@photo-sphere-viewer/core";
import {
  type CanvasTexture,
  BufferGeometry,
  Group,
  Line,
  LineDashedMaterial,
  Material,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { vertexView, type OverlayCam } from "../lib/overlay-geometry";
import { makeRingTexture } from "./MeasureOverlay";
import type { HeightPoint } from "../lib/height";
import "./HeightOverlay.css";

export interface HeightOverlayProps {
  viewer: Viewer;
  cam: OverlayCam | null;
  /** Captured tree base; no A → nothing renders. */
  a: HeightPoint | null;
  /**
   * Top pitch in degrees — captured pitch_B once set, else the live
   * reticle pitch (the rubber band tracks it; the caller owns the fallback).
   */
  pitchTopDeg: number | null;
  /** Formatted chip text; the chip hides when null (e.g. live H ≤ 0). */
  chipText: string | null;
}

/** Warm orange — distinct from the annotation kind colors, the yellow
 * sketch, and measure's pink. */
const HEIGHT_COLOR = 0xffa657;
/** Overlay radius: just inside the photo sphere (same as annotations). */
const RADIUS = CONSTANTS.SPHERE_RADIUS - 0.08;
/** Base ring sprite size on the RADIUS=9.92 sphere. */
const RING_SCALE = 0.14;

export default function HeightOverlay({ viewer, cam, a, pitchTopDeg, chipText }: HeightOverlayProps) {
  const chipRef = useRef<HTMLDivElement | null>(null);

  // Three.js scene graph: vertical dashed line + base ring, rebuilt on
  // every prop change, disposed on teardown/rebuild — nothing survives a
  // photo switch or a mode exit.
  useEffect(() => {
    const group = new Group();
    const geometries: BufferGeometry[] = [];
    const materials: Material[] = [];
    const textures: CanvasTexture[] = [];

    if (cam !== null && a !== null && pitchTopDeg !== null) {
      const ray = vertexView(cam, [a.lon, a.lat]);
      const yaw = ray.yawRad;
      const toV3 = (pitchRad: number): Vector3 =>
        viewer.dataHelper.sphericalCoordsToVector3({ yaw, pitch: pitchRad }, new Vector3(), RADIUS);
      const base = toV3(ray.pitchRad);
      const top = toV3((pitchTopDeg * Math.PI) / 180);

      const lineMat = new LineDashedMaterial({
        color: HEIGHT_COLOR,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      materials.push(lineMat);
      const geom = new BufferGeometry();
      geometries.push(geom);
      geom.setFromPoints([base, top]);
      const line = new Line(geom, lineMat);
      line.computeLineDistances();
      group.add(line);

      const texture = makeRingTexture();
      textures.push(texture);
      const ringMat = new SpriteMaterial({
        map: texture,
        color: HEIGHT_COLOR,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      materials.push(ringMat);
      const sprite = new Sprite(ringMat);
      sprite.position.copy(base);
      sprite.scale.setScalar(RING_SCALE);
      group.add(sprite);
    }

    viewer.renderer.addObject(group);
    viewer.needsUpdate();
    return () => {
      viewer.renderer.removeObject(group);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    };
  }, [viewer, cam, a, pitchTopDeg]);

  // DOM chip: projected at the top of the vertical line — the same
  // per-frame projection as annotation labels.
  useEffect(() => {
    const chip = chipRef.current;
    if (chip === null || cam === null || a === null || pitchTopDeg === null) return;
    const update = (): void => {
      const ray = vertexView(cam, [a.lon, a.lat]);
      const pos = { yaw: ray.yawRad, pitch: (pitchTopDeg * Math.PI) / 180 };
      const p = viewer.dataHelper.sphericalCoordsToViewerCoords(pos);
      chip.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -170%)`;
      chip.classList.toggle("is-hidden", !viewer.dataHelper.isPointVisible(pos));
    };
    update();
    viewer.addEventListener("render", update);
    return () => viewer.removeEventListener("render", update);
  }, [viewer, cam, a, pitchTopDeg]);

  return (
    <div className="height-overlay" aria-hidden="true">
      {a !== null && pitchTopDeg !== null && chipText !== null && (
        <div ref={chipRef} className="height-chip">
          {chipText}
        </div>
      )}
    </div>
  );
}
