/**
 * Annotation overlay (ticket 04): finished / in-progress / selected annotation
 * shapes drawn into the Photo Sphere Viewer three.js scene, plus DOM labels
 * projected onto the pano per frame.
 *
 * Spec: `.scratch/annotations/spec.md` ("Rendering" / "Capture &
 * interaction"). Mount as a sibling of the PSV container inside
 * `.viewer-wrap` (the label layer covers `inset: 0` of that box, which is
 * exactly the viewer's own size — `sphericalCoordsToViewerCoords` returns
 * container-relative CSS pixels).
 *
 * ── Prop contract (ticket 07 conforms to this; report any change) ──
 *
 *   viewer       the PSV `Viewer` instance (required, never null once
 *                mounted — unmount the overlay together with the viewer).
 *   cam          current photo's fix + XMP RelativeAltitude
 *                (`{ lat, lon, relAltM }` from `OverlayCam`); `null` draws
 *                nothing (mode buttons are greyed out in that state anyway).
 *   features     the current photo's finished annotations. `vertices` are
 *                `[lon, lat]` ground positions; polygon rings WITHOUT the
 *                duplicated closing vertex (serialization adds it on write).
 *   inProgress   the shape being drawn (`line` | `polygon`), or null. Gets
 *                the dashed "sketch" style; the polygon's closing edge is
 *                previewed faintly (finish auto-closes, never re-aim).
 *   selectedId   highlights that feature: white halo at a slightly larger
 *                radius + larger markers + label emphasis — selection is
 *                never color-only.
 *   onLabelPositions  optional; fires whenever a label's integer-pixel
 *                position or visibility changes (i.e. per rendered frame
 *                during camera motion — keep handlers cheap) with
 *                `{ id, x, y, visible }[]` for every finished feature.
 *
 * ── PSV API surface used (public, 5.15.1 index.d.ts) ──
 *
 *   viewer.renderer.addObject / removeObject(Object3D)   scene access
 *   viewer.dataHelper.sphericalCoordsToVector3(pos, vec, distance)
 *   viewer.dataHelper.sphericalCoordsToViewerCoords(pos)  DOM labels
 *   viewer.dataHelper.isPointVisible(pos)                 behind-camera
 *   viewer.addEventListener/removeEventListener("render") per-frame hook
 *   viewer.needsUpdate()                                  trigger a render
 *   viewer.animate({ yaw, pitch, speed })  (via the exported `swingTo`)
 *
 *   `Position` yaw/pitch is the *view-true* frame: PSV applies
 *   `sphereCorrection` (north offset) by rotating the pano mesh container,
 *   while `sphericalCoordsToVector3` is the raw camera-frame conversion used
 *   for `state.direction` — the same yaw the app feeds `vincentyDirect`. So
 *   bearing-sense yaw/pitch from `vertexView` maps straight onto the sphere
 *   and stays aligned when the north offset changes. Overlay objects are
 *   added to the scene root (not the rotated mesh container).
 *
 * ── Geometry conventions ──
 *
 *   Overlay sits at radius `SPHERE_RADIUS − 0.08` (selection halo at
 *   `+0.045`, still inside) so it always renders in front of the photo from
 *   the interior camera. Lines are 1 px `LineBasicMaterial` (WebGL/ANGLE
 *   ignores linewidth — selection reads as halo + opacity + marker scale
 *   instead). Polygon fills are triangulated on the ring's tangent plane
 *   (chord sag is ≪ a pixel for ≤ 5 km edges on a radius-10 sphere). Points
 *   are `Sprite`s sharing one canvas dot texture. Everything is rebuilt on
 *   any prop change and fully disposed (geometries, materials, texture) on
 *   unmount — no leaks across photo switches.
 *
 * DUPLICATION NOTE for 07: vertex→ray math lives in
 * `../lib/overlay-geometry.ts` until `ground-capture.ts` (ticket 03) lands;
 * see that file's header.
 */

import { useEffect, useRef } from "react";
import { CONSTANTS } from "@photo-sphere-viewer/core";
import type { Viewer } from "@photo-sphere-viewer/core";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Material,
  Mesh,
  MeshBasicMaterial,
  ShapeUtils,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from "three";
import { vertexView, verticesCentroid, type OverlayCam } from "../lib/overlay-geometry";
import { effectiveAlpha } from "../lib/overlay-opacity";
import "./AnnotationOverlay.css";

/* ---------- public prop types (ticket 07 consumes these) ---------- */

/** One finished annotation of the current photo (spec §Schema, render-side:
 * no closing vertex, no GeoJSON wrapper — that lives in lib/annotations). */
export interface OverlayFeature {
  /** `properties.id` (`ann-<ULID>`). */
  id: string;
  kind: "point" | "line" | "polygon";
  label: string;
  /** Ground vertices `[lon, lat]`; polygon rings without the closing dup. */
  vertices: [number, number][];
}

/** The shape currently being drawn (never persisted in this form). */
export interface InProgressShape {
  kind: "line" | "polygon";
  vertices: [number, number][];
}

/** Screen position of one label, viewer-container-relative CSS pixels. */
export interface LabelPosition {
  id: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface AnnotationOverlayProps {
  viewer: Viewer;
  cam: OverlayCam | null;
  features: OverlayFeature[];
  inProgress: InProgressShape | null;
  selectedId: string | null;
  /**
   * Global overlay opacity multiplier (`pano.overlayOpacity`): scales the
   * finished features' strokes / fills / point dots (effective = base ×
   * multiplier, ≤ 1). In-progress sketch and selection affordances stay at
   * base alpha — never dimmed below usability (overlay-opacity spec §Scope).
   */
  opacityMultiplier: number;
  onLabelPositions?: (positions: LabelPosition[]) => void;
}

/* ---------- styling constants ---------- */

const KIND_COLOR = {
  point: 0x5ac8fa, // sky blue
  line: 0xffc95e, // amber
  polygon: 0x6fe0a8, // mint
} as const;
const SKETCH_COLOR = 0xffe14d; // bright yellow, dashed
const HALO_COLOR = 0xffffff;

/** Overlay radius: just inside the photo sphere (SPHERE_RADIUS = 10). */
const RADIUS = CONSTANTS.SPHERE_RADIUS - 0.08;
/** Selection halo radius: still inside the sphere, far enough to read as a
 * second, wider stroke rather than z-fighting the main one. */
const HALO_RADIUS = RADIUS + 0.045;

const LINE_OPACITY = 0.75;
const LINE_OPACITY_SELECTED = 0.95;

/* ---------- scene building ---------- */

/** White disc with a dark rim, tinted per kind via the sprite material. */
function makeDotTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.stroke();
  }
  return new CanvasTexture(canvas);
}

/** Everything GPU-backed created for one build, disposed together on
 * teardown — the overlay never leaks objects across rebuilds or photo
 * switches. */
class OverlayBuild {
  readonly group = new Group();
  readonly geometries: BufferGeometry[] = [];
  readonly materials: Material[] = [];
  readonly textures: CanvasTexture[] = [];

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

/** World positions of the vertices' view rays at `radius`. */
function rayPositions(
  viewer: Viewer,
  cam: OverlayCam,
  vertices: readonly (readonly [number, number])[],
  radius: number,
): Vector3[] {
  const out: Vector3[] = [];
  for (const v of vertices) {
    const { yawRad, pitchRad } = vertexView(cam, v);
    out.push(
      viewer.dataHelper.sphericalCoordsToVector3(
        { yaw: yawRad, pitch: pitchRad },
        new Vector3(),
        radius,
      ),
    );
  }
  return out;
}

/** Polyline through `points`; `closed` appends the first point again (ring). */
function makeLine(
  build: OverlayBuild,
  points: Vector3[],
  material: LineBasicMaterial | LineDashedMaterial,
  closed: boolean,
): void {
  if (points.length < 2) return;
  const geom = new BufferGeometry();
  build.geometries.push(geom);
  geom.setFromPoints(closed ? [...points, points[0]] : points);
  const line = new Line(geom, material);
  if (material instanceof LineDashedMaterial) line.computeLineDistances();
  build.group.add(line);
}

function makeDot(
  build: OverlayBuild,
  position: Vector3,
  scale: number,
  material: SpriteMaterial,
): void {
  const sprite = new Sprite(material);
  sprite.position.copy(position);
  sprite.scale.setScalar(scale);
  build.group.add(sprite);
}

/** Triangulate a spherical ring by projecting it onto its own tangent plane;
 * the fallback reference axis keeps the basis non-degenerate for rings right
 * under the camera (nadir), where the ground normal is near ±y. */
function triangulateRing(points: Vector3[]): number[][] {
  const center = new Vector3();
  for (const p of points) center.add(p);
  center.divideScalar(points.length);
  const normal = center.clone().normalize();
  const ref = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const e1 = new Vector3().crossVectors(ref, normal).normalize();
  const e2 = new Vector3().crossVectors(normal, e1);
  const contour = points.map((p) => new Vector2(p.dot(e1), p.dot(e2)));
  return ShapeUtils.triangulateShape(contour, []);
}

function makeFill(build: OverlayBuild, points: Vector3[], material: MeshBasicMaterial): void {
  if (points.length < 3) return;
  const faces = triangulateRing(points);
  if (faces.length === 0) return; // no faces → nothing to draw (outline only)
  const arr = new Float32Array(faces.length * 9);
  let k = 0;
  for (const face of faces) {
    for (const idx of face) {
      const p = points[idx];
      arr[k++] = p.x;
      arr[k++] = p.y;
      arr[k++] = p.z;
    }
  }
  const geom = new BufferGeometry();
  build.geometries.push(geom);
  geom.setAttribute("position", new BufferAttribute(arr, 3));
  build.group.add(new Mesh(geom, material));
}

/** One tinted-dot sprite material (4 lockstep construction sites share it). */
function makeSpriteMat(
  build: OverlayBuild,
  texture: CanvasTexture,
  color: number,
  opacity: number,
): SpriteMaterial {
  const mat = new SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  build.materials.push(mat);
  return mat;
}

/** Rebuild the whole overlay scene graph for the current props. The caller
 * adds/removes the root group on the PSV scene and disposes the build. */
function buildOverlay(
  viewer: Viewer,
  cam: OverlayCam | null,
  features: OverlayFeature[],
  inProgress: InProgressShape | null,
  selectedId: string | null,
  opacityMultiplier: number,
): OverlayBuild {
  const build = new OverlayBuild();
  if (cam === null) return build;

  // Finished-feature alphas scale with the global multiplier; the sketch /
  // halo / vertex-marker materials below deliberately do NOT (spec §Scope:
  // in-progress and selection affordances are never dimmed below usability).
  const alpha = (base: number): number => effectiveAlpha(base, opacityMultiplier);

  const texture = makeDotTexture();
  build.textures.push(texture);

  const haloLine = new LineBasicMaterial({
    color: HALO_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  build.materials.push(haloLine);

  const sketchLine = new LineDashedMaterial({
    color: SKETCH_COLOR,
    dashSize: 0.18,
    gapSize: 0.12,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  build.materials.push(sketchLine);

  const sketchClosing = new LineDashedMaterial({
    color: SKETCH_COLOR,
    dashSize: 0.12,
    gapSize: 0.12,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  build.materials.push(sketchClosing);

  const haloSprite = makeSpriteMat(build, texture, HALO_COLOR, 0.35);
  const sketchDot = makeSpriteMat(build, texture, SKETCH_COLOR, 0.95);

  for (const f of features) {
    if (f.vertices.length === 0) continue;
    const selected = f.id === selectedId;

    if (f.kind === "point") {
      const [p] = rayPositions(viewer, cam, f.vertices, RADIUS);
      if (selected) makeDot(build, p, 0.26, haloSprite);
      makeDot(
        build,
        p,
        selected ? 0.18 : 0.13,
        makeSpriteMat(build, texture, KIND_COLOR.point, alpha(0.95)),
      );
      continue;
    }

    const color = KIND_COLOR[f.kind];
    const stroke = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: alpha(selected ? LINE_OPACITY_SELECTED : LINE_OPACITY),
      depthWrite: false,
    });
    build.materials.push(stroke);

    const pts = rayPositions(viewer, cam, f.vertices, RADIUS);
    makeLine(build, pts, stroke, f.kind === "polygon");

    if (f.kind === "polygon") {
      const fill = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: alpha(0.15),
        side: 2, // THREE.DoubleSide (see lib/three-core.d.ts)
        depthWrite: false,
      });
      build.materials.push(fill);
      makeFill(build, pts, fill);
    }

    if (selected) {
      // Halo stroke + vertex markers: selection must not be color-only.
      makeLine(
        build,
        rayPositions(viewer, cam, f.vertices, HALO_RADIUS),
        haloLine,
        f.kind === "polygon",
      );
      const dot = makeSpriteMat(build, texture, color, 0.95);
      for (const p of pts) makeDot(build, p, 0.09, dot);
    }
  }

  if (inProgress !== null && inProgress.vertices.length > 0) {
    const pts = rayPositions(viewer, cam, inProgress.vertices, RADIUS);
    makeLine(build, pts, sketchLine, false);
    if (inProgress.kind === "polygon" && pts.length >= 2) {
      // Closing-edge preview — finish auto-closes, the user never re-aims.
      makeLine(build, [pts[0], pts[pts.length - 1]], sketchClosing, false);
    }
    pts.forEach((p, i) => makeDot(build, p, i === pts.length - 1 ? 0.16 : 0.12, sketchDot));
  }

  return build;
}

/* ---------- camera swing helper (list-panel "click → swing") ---------- */

/**
 * Animated rotate to a view-true target (degrees; yaw = compass bearing,
 * pitch negative = down). PSV's `animate` takes the shortest yaw arc and
 * cancels any running animation. Default speed ≈ 50°/s (a 90° swing takes
 * ~1.8 s; tiny corrections fall back to PSV's 500 ms minimum).
 */
export function swingTo(
  viewer: Viewer,
  target: { yawDeg: number; pitchDeg: number },
  speed: string | number = "50dps",
): void {
  viewer.animate({
    yaw: (target.yawDeg * Math.PI) / 180,
    pitch: (target.pitchDeg * Math.PI) / 180,
    speed,
  });
}

/* ---------- component ---------- */

export default function AnnotationOverlay({
  viewer,
  cam,
  features,
  inProgress,
  selectedId,
  opacityMultiplier,
  onLabelPositions,
}: AnnotationOverlayProps) {
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const lastPositionsKey = useRef<string | null>(null);

  // Three.js scene graph: full rebuild on any prop change, full disposal on
  // teardown / rebuild — nothing survives a photo switch. The multiplier is
  // an ordinary prop here (annotation graphs are a handful of features; the
  // overlay-opacity spec prefers in-place only where rebuilds would hurt).
  useEffect(() => {
    const build = buildOverlay(viewer, cam, features, inProgress, selectedId, opacityMultiplier);
    viewer.renderer.addObject(build.group);
    viewer.needsUpdate();
    return () => {
      viewer.renderer.removeObject(build.group);
      build.dispose();
    };
  }, [viewer, cam, features, inProgress, selectedId, opacityMultiplier]);

  // DOM labels: React owns the elements (props), the PSV "render" event owns
  // their transforms (direct style writes — no per-frame React state). PSV
  // only renders when something changed (camera, zoom, resize, needsUpdate),
  // which is exactly when the projections go stale.
  useEffect(() => {
    const update = () => {
      const out: LabelPosition[] = [];
      for (const f of features) {
        const el = labelEls.current.get(f.id);
        if (el === undefined) continue;
        let visible = false;
        let x = 0;
        let y = 0;
        if (cam !== null && f.vertices.length > 0) {
          const anchor = f.kind === "point" ? f.vertices[0] : verticesCentroid(f.vertices);
          const ray = vertexView(cam, anchor);
          const pos = { yaw: ray.yawRad, pitch: ray.pitchRad };
          visible = viewer.dataHelper.isPointVisible(pos);
          const p = viewer.dataHelper.sphericalCoordsToViewerCoords(pos);
          x = p.x;
          y = p.y;
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -140%)`;
        }
        el.classList.toggle("is-hidden", !visible);
        out.push({ id: f.id, x, y, visible });
      }
      const key = JSON.stringify(out);
      if (key !== lastPositionsKey.current) {
        lastPositionsKey.current = key;
        onLabelPositions?.(out);
      }
    };

    update();
    viewer.addEventListener("render", update);
    return () => viewer.removeEventListener("render", update);
  }, [viewer, cam, features, selectedId, onLabelPositions]);

  return (
    <div className="annotation-overlay" aria-hidden="true">
      {features.map((f) => (
        <div
          key={f.id}
          ref={(el) => {
            if (el === null) labelEls.current.delete(f.id);
            else labelEls.current.set(f.id, el);
          }}
          className={
            "annotation-label kind-" + f.kind + (f.id === selectedId ? " selected" : "")
          }
        >
          {f.label}
        </div>
      ))}
    </div>
  );
}
