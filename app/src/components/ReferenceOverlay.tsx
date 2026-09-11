/**
 * Reference-layer overlay (`.scratch/reference-layers/spec.md` §Client
 * behavior, ticket 03): externally-owned read-only GeoJSON (turbine
 * foundations, avoidance areas…) drawn into the Photo Sphere Viewer scene.
 *
 * The App fetches `GET /api/reference-layers` (frozen contract:
 * `{ layers: [{ name, color, labelProp, status, features }] }`) on mount and
 * refetches on the `reference-layers:changed` HMR push; this component only
 * renders what it is handed.
 *
 * Render discipline mirrors `AnnotationOverlay` / `MeasureOverlay`:
 * `vertexView` flat-ground projection onto the sphere (RADIUS just inside
 * the pano), full rebuild on every prop change, full disposal on
 * teardown/rebuild, objects attached to the scene ROOT via
 * `renderer.addObject` — never the sphereCorrection-rotated mesh container —
 * and DOM labels projected per frame on the PSV "render" event (direct style
 * writes, no per-frame React state). Point dots reuse the annotation dot
 * texture construction (kept local — AnnotationOverlay does not export it).
 *
 * Per-pano cull (`lib/reference-cull`): a feature with every vertex > 1100 m
 * from the camera is not drawn; vertex-based, no clipping. `cam === null`
 * (`nogps-*` / altitude-less photos) renders nothing.
 *
 * Toolbar visibility toggles + click-inspect are ticket 04 — this component
 * takes a `visible` map (absent name = visible) so 04 only needs to write
 * state, and renders every layer always-visible meanwhile.
 */
import { useEffect, useRef } from "react";
import { CONSTANTS } from "@photo-sphere-viewer/core";
import type { Viewer } from "@photo-sphere-viewer/core";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshBasicMaterial,
  ShapeUtils,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from "three";
import { vertexView, type OverlayCam } from "../lib/overlay-geometry";
import { featureIsCulled, geometryVertices } from "../lib/reference-cull";
import type { RefLayerPayload, RefPosition } from "../lib/reference-layers";
import "./ReferenceOverlay.css";

export interface ReferenceOverlayProps {
  viewer: Viewer;
  /** Current photo's fix + RelativeAltitude; null draws nothing. */
  cam: OverlayCam | null;
  /** Endpoint payload verbatim; empty array draws nothing. */
  layers: readonly RefLayerPayload[];
  /**
   * Layer name → visible. Absent name = visible (all-true default); ticket
   * 04's toolbar is the only writer.
   */
  visible: Readonly<Record<string, boolean>>;
}

/** One DOM-labeled point feature (culled features never get here). */
interface LabeledPoint {
  key: string;
  vertex: RefPosition;
  text: string;
  /** Layer color as `#rrggbb` (inline chip border). */
  color: string;
}

/* ---------- styling constants ---------- */

/** Overlay radius: just inside the photo sphere (same as annotations). */
const RADIUS = CONSTANTS.SPHERE_RADIUS - 0.08;
/** Reference strokes sit over imagery — a touch stronger than annotations. */
const STROKE_OPACITY = 0.8;
/** Spec: translucent polygon fill ~15% opacity. */
const FILL_OPACITY = 0.15;
/** Point dot sprite size (annotation point scale). */
const DOT_SCALE = 0.13;

/** Default point-label property precedence (spec §CLI contract). */
const LABEL_KEYS = ["label", "name", "id", "turbine"] as const;

/* ---------- pure helpers ---------- */

/**
 * `#hex` → three color number. Accepts every width the CLI contract allows
 * (3/4/6/8 digits, already lowercased): short forms expand per digit, an
 * alpha channel is dropped. Malformed input falls back to grey.
 */
function colorNum(color: string): number {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color);
  if (m === null) return 0x888888;
  let hex = m[1]!;
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return parseInt(hex.slice(0, 6), 16);
}

/**
 * Point label text: `labelProp` first (explicit `label=<prop>` flag), else
 * the default `label > name > id > turbine` chain. String values must be
 * non-blank; finite numbers stringify. No match → null (bare dot).
 */
function pointLabel(labelProp: string | null, props: Record<string, unknown>): string | null {
  const keys = labelProp !== null ? [labelProp, ...LABEL_KEYS] : LABEL_KEYS;
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Drop a GeoJSON duplicated closing vertex (rings are stored closed). */
function openRing(ring: readonly RefPosition[]): RefPosition[] {
  const n = ring.length;
  if (n >= 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) {
    return ring.slice(0, n - 1);
  }
  return ring as RefPosition[];
}

/**
 * Culled-in-aware labeled points of the visible layers — the single source
 * shared by the scene build and the DOM labels (cam null → none).
 */
function labeledPoints(
  cam: OverlayCam | null,
  layers: readonly RefLayerPayload[],
  visible: Readonly<Record<string, boolean>>,
): LabeledPoint[] {
  const out: LabeledPoint[] = [];
  if (cam === null) return out;
  for (const layer of layers) {
    if (visible[layer.name] === false) continue;
    layer.features.features.forEach((f, i) => {
      if (f.geometry.type !== "Point") return;
      if (featureIsCulled(cam, geometryVertices(f.geometry))) return;
      const text = pointLabel(layer.labelProp, f.properties);
      if (text === null) return;
      out.push({ key: `${layer.name}#${i}`, vertex: f.geometry.coordinates, text, color: layer.color });
    });
  }
  return out;
}

/* ---------- scene building (AnnotationOverlay discipline) ---------- */

/** White disc with a dark rim, tinted per layer via the sprite material. */
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

/** Everything GPU-backed created for one build, disposed together. */
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
  vertices: readonly RefPosition[],
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
  material: LineBasicMaterial,
  closed: boolean,
): void {
  if (points.length < 2) return;
  const geom = new BufferGeometry();
  build.geometries.push(geom);
  geom.setFromPoints(closed ? [...points, points[0]] : points);
  build.group.add(new Line(geom, material));
}

/**
 * Triangulate a polygon onto the sphere like the annotation fill: project
 * every ring onto one tangent plane (basis from all rings' points — a shared
 * frame keeps exterior and holes coherent), then ShapeUtils with the
 * interior rings as holes. Chord sag is ≪ a pixel for ≤ 5 km edges on the
 * radius-10 sphere (see AnnotationOverlay's geometry notes).
 */
function makeFill(build: OverlayBuild, rings: Vector3[][], material: MeshBasicMaterial): void {
  const contour = rings[0];
  if (contour === undefined || contour.length < 3) return;
  const holes = rings.slice(1).filter((r) => r.length >= 3);
  const all = [contour, ...holes];

  const center = new Vector3();
  let count = 0;
  for (const r of all) {
    for (const p of r) {
      center.add(p);
      count++;
    }
  }
  center.divideScalar(count);
  const normal = center.clone().normalize();
  const ref = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const e1 = new Vector3().crossVectors(ref, normal).normalize();
  const e2 = new Vector3().crossVectors(normal, e1);

  const to2D = (r: Vector3[]): Vector2[] => r.map((p) => new Vector2(p.dot(e1), p.dot(e2)));
  const faces = ShapeUtils.triangulateShape(to2D(contour), holes.map(to2D));
  if (faces.length === 0) return;

  const pts = all.flat();
  const arr = new Float32Array(faces.length * 9);
  let k = 0;
  for (const face of faces) {
    for (const idx of face) {
      const p = pts[idx];
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

/** Rebuild the whole reference scene graph for the current props. */
function buildReferenceOverlay(
  viewer: Viewer,
  cam: OverlayCam | null,
  layers: readonly RefLayerPayload[],
  visible: Readonly<Record<string, boolean>>,
): OverlayBuild {
  const build = new OverlayBuild();
  if (cam === null) return build;

  const texture = makeDotTexture();
  build.textures.push(texture);

  for (const layer of layers) {
    if (visible[layer.name] === false) continue;
    const features = layer.features.features;
    if (features.length === 0) continue;

    const color = colorNum(layer.color);
    const dotMat = new SpriteMaterial({
      map: texture,
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    build.materials.push(dotMat);
    const strokeMat = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: STROKE_OPACITY,
      depthWrite: false,
    });
    build.materials.push(strokeMat);
    const fillMat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: FILL_OPACITY,
      side: DoubleSide,
      depthWrite: false,
    });
    build.materials.push(fillMat);

    for (const f of features) {
      if (featureIsCulled(cam, geometryVertices(f.geometry))) continue;
      switch (f.geometry.type) {
        case "Point": {
          const [p] = rayPositions(viewer, cam, [f.geometry.coordinates], RADIUS);
          const sprite = new Sprite(dotMat);
          sprite.position.copy(p);
          sprite.scale.setScalar(DOT_SCALE);
          build.group.add(sprite);
          break;
        }
        case "LineString": {
          makeLine(build, rayPositions(viewer, cam, f.geometry.coordinates, RADIUS), strokeMat, false);
          break;
        }
        case "Polygon": {
          const rings = f.geometry.coordinates.map(openRing);
          for (const ring of rings) {
            makeLine(build, rayPositions(viewer, cam, ring, RADIUS), strokeMat, true);
          }
          makeFill(
            build,
            rings.map((r) => rayPositions(viewer, cam, r, RADIUS)),
            fillMat,
          );
          break;
        }
      }
    }
  }

  return build;
}

/* ---------- component ---------- */

export default function ReferenceOverlay({ viewer, cam, layers, visible }: ReferenceOverlayProps) {
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const labels = labeledPoints(cam, layers, visible);

  // Three.js scene graph: full rebuild on any prop change, full disposal on
  // teardown / rebuild — nothing survives a photo switch or a layer reload.
  useEffect(() => {
    const build = buildReferenceOverlay(viewer, cam, layers, visible);
    viewer.renderer.addObject(build.group);
    viewer.needsUpdate();
    return () => {
      viewer.renderer.removeObject(build.group);
      build.dispose();
    };
  }, [viewer, cam, layers, visible]);

  // DOM labels: React owns the elements (props), the PSV "render" event owns
  // their transforms — same per-frame projection as annotation labels.
  useEffect(() => {
    const update = () => {
      if (cam === null) return; // labels is empty then — nothing to project
      for (const l of labels) {
        const el = labelEls.current.get(l.key);
        if (el === undefined) continue;
        const { yawRad, pitchRad } = vertexView(cam, l.vertex);
        const pos = { yaw: yawRad, pitch: pitchRad };
        el.classList.toggle("is-hidden", !viewer.dataHelper.isPointVisible(pos));
        const p = viewer.dataHelper.sphericalCoordsToViewerCoords(pos);
        el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -140%)`;
      }
    };
    update();
    viewer.addEventListener("render", update);
    return () => viewer.removeEventListener("render", update);
  }, [viewer, cam, labels]);

  return (
    <div className="reference-overlay" aria-hidden="true">
      {labels.map((l) => (
        <div
          key={l.key}
          ref={(el) => {
            if (el === null) labelEls.current.delete(l.key);
            else labelEls.current.set(l.key, el);
          }}
          className="reference-label"
          style={{ borderLeftColor: l.color }}
        >
          {l.text}
        </div>
      ))}
    </div>
  );
}
