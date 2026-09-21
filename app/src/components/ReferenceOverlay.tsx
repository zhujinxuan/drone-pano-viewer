/**
 * Reference-layer overlay (`.scratch/reference-layers/spec.md` §Client
 * behavior, ticket 03): externally-owned read-only GeoJSON (turbine
 * foundations, avoidance areas…) drawn into the Photo Sphere Viewer scene.
 *
 * The App fetches `GET /api/reference-layers` (frozen contract:
 * `{ layers: [{ name, color, labelProp, status, dropped, features }] }`) on mount and
 * refetches on the `reference-layers:changed` HMR push; this component only
 * renders what it is handed.
 *
 * Render discipline mirrors `AnnotationOverlay` / `MeasureOverlay`:
 * `vertexView` flat-ground projection onto the sphere (RADIUS just inside
 * the pano), objects attached to the scene ROOT via
 * `renderer.addObject` — never the sphereCorrection-rotated mesh container —
 * and DOM labels projected per frame on the PSV "render" event (direct style
 * writes, no per-frame React state). Point dots reuse the annotation dot
 * texture construction (kept local — AnnotationOverlay does not export it).
 *
 * Build discipline (tickets 14/15/16): per layer, one batched LineSegments +
 * one fill Mesh (+ point sprites); layers build one per time slice, cheapest
 * first, so the pano stays draggable while heavy layers stream in; features
 * beyond 200 m render from a cached 3 m ground-DP coarse geometry.
 *
 * Per-pano cull (`lib/reference-cull`): a feature with every vertex > 700 m
 * from the camera is not drawn; vertex-based, no clipping. `cam === null`
 * (`nogps-*` / altitude-less photos) renders nothing.
 *
 * Click-inspect (ticket 04): while `onInspect` is non-null — App nulls it
 * whenever an annotation or measure capture mode is active, so reference
 * clicks never steal from capture — drag-guarded clicks (same slop
 * discipline as App's click-to-add) hit-test the visible, unculled
 * features in screen space (lib/reference-inspect) and call back with the
 * nearest hit, or null on a click elsewhere (dismiss).
 */
import { useEffect, useMemo, useRef } from "react";
import { CONSTANTS } from "@photo-sphere-viewer/core";
import type { Viewer } from "@photo-sphere-viewer/core";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { makeProjector, SIMPLIFY_EPS_RAD, simplifyViewRays, vertexView, type OverlayCam, type ViewRay } from "../lib/overlay-geometry";
import {
  nearestInspectFeature,
  type InspectCandidate,
  type InspectHit,
  type InspectPath,
  type ScreenPoint,
} from "../lib/reference-inspect";
import { cullEntry, entryIsCulled, entryIsFar, type CullEntry } from "../lib/reference-cull";
import { lodGeometry } from "../lib/reference-lod";
import { buildQueue } from "../lib/reference-build";
import { triangulateRings } from "../lib/reference-fill";
import type { RefFeature, RefGeometry, RefLayerPayload, RefPosition } from "../lib/reference-layers";
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
  /**
   * Click-inspect sink (ticket 04), null while an annotation/measure mode
   * is active (App's choice — capture clicks are never inspected). Gets the
   * nearest hit under a drag-guarded click, or null on a click elsewhere.
   */
  onInspect: ((hit: InspectHit | null) => void) | null;
  /**
   * Per-layer build progress (ticket 16): called with "building" when a
   * layer's slice is scheduled and "ready" when its objects are in the
   * scene. App forwards the map to the toolbar. Stable-callback discipline:
   * it is an effect dep, so App must memoize it.
   */
  onLayerStatus?: (name: string, status: "building" | "ready") => void;
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
/** Click-inspect hit radius: generous for dots, tight enough to feel
 * deliberate. No capture-slop constraint applies — inspect is only wired
 * when no annotation/measure mode is active, so the drag guard (6 px) is
 * the only misroute guard, never the threshold. */
const INSPECT_HIT_PX = 14;
/** Same drag-guard slop as App's CLICK_SLOP_PX (kept local: App doesn't
 * export it, and the two must not import each other). */
const CLICK_SLOP_PX = 6;

/* ---------- per-feature caches (ticket 10) ----------
 *
 * Payload features pass through by reference (lossless invariant), so object
 * identity is stable until a layer reload replaces them — WeakMap keys give
 * us cache invalidation for free: a reload's new objects miss, the old
 * entries are GC'd. Two caches share that key:
 *
 *  - cullEntries: flattened vertices + bbox for the two-tier cull (the
 *    per-switch Vincenty-per-vertex scan was the dominant switch cost with
 *    dense avoidance polygons — ~160 k geodesic calls per keypress).
 *  - fillFaces: earcut face indices of a Polygon fill. The indices address
 *    the flattened ring vertex list, whose composition is cam-independent;
 *    between switches only the vertex POSITIONS change, and the
 *    stereographic fill projection (lib/reference-fill) is injective over
 *    every ground ray for any camera, so ring topology — hence the
 *    triangulation — is preserved exactly: cached faces stay valid under
 *    any camera (ticket 11's tangent-plane fills were only approximately
 *    valid and leaked near-camera holes).
 */

const cullEntries = new WeakMap<RefFeature, CullEntry>();
const fillFaces = new WeakMap<RefFeature, readonly number[][] | null>();
/**
 * Far-band caches (ticket 14): the cam-independent coarse geometry per
 * feature, and the earcut faces of its rings. Coarse rings never change
 * with the camera, so a far feature's fill triangulates ONCE per payload —
 * the property ticket 11's cam-dependent decimation couldn't have.
 */
const lodGeometries = new WeakMap<RefFeature, RefGeometry>();
const lodFillFaces = new WeakMap<RefFeature, readonly number[][] | null>();

function entryFor(f: RefFeature): CullEntry {
  let e = cullEntries.get(f);
  if (e === undefined) {
    e = cullEntry(f.geometry);
    cullEntries.set(f, e);
  }
  return e;
}

/** Far-band geometry of a feature, built once and cached by identity. */
function lodGeometryFor(f: RefFeature): RefGeometry {
  let g = lodGeometries.get(f);
  if (g === undefined) {
    g = lodGeometry(f.geometry);
    lodGeometries.set(f, g);
  }
  return g;
}

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
      if (entryIsCulled(cam, entryFor(f))) return;
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
  const project = makeProjector(cam);
  const out: Vector3[] = [];
  for (const v of vertices) {
    const { yawRad, pitchRad } = project(v);
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

/**
 * Decimation floor: rings/lines smaller than this skip Douglas-Peucker
 * entirely (simplification cost would exceed the saving) and keep the
 * per-feature fill cache.
 */
const SIMPLIFY_MIN_VERTICES = 1000;

/**
 * Fill decimation ε, 5× the stroke ε (≈1.5 px at 1600 px/60° FOV, 0.5 px
 * zoomed to 30°). The boundary strokes carry the visible edge at full
 * fidelity; the 15%-opacity fill may wobble under them — but earcut's
 * hole-bridging cost is superlinear, and for the 900-hole monster polygons
 * this is the difference between a 160 ms and a 30 ms triangulation.
 */
const FILL_EPS_RAD = 5 * SIMPLIFY_EPS_RAD;

/**
 * Projected positions of a line/ring, angularly decimated when `decimate`
 * (ticket 11): huge producer polygons land dozens of vertices per screen
 * pixel near the horizon; Douglas-Peucker at a sub-pixel ε collapses those
 * runs before any Vector3 allocation or GPU upload. The decimate decision is
 * made per FEATURE by the caller (a 900-ring monster must decimate its small
 * rings too — 900 undecimated "small" rings still total ~54 k fill vertices
 * and turn earcut's hole-bridging quadratic). `decimated` reports whether
 * any vertices were actually dropped.
 */
function projectedPath(
  viewer: Viewer,
  cam: OverlayCam,
  vertices: readonly RefPosition[],
  radius: number,
  closed: boolean,
  decimate: boolean,
  epsRad: number = SIMPLIFY_EPS_RAD,
): { points: Vector3[]; decimated: boolean } {
  if (!decimate) {
    return { points: rayPositions(viewer, cam, vertices, radius), decimated: false };
  }
  const project = makeProjector(cam);
  const rays: ViewRay[] = vertices.map(project);
  const kept = simplifyViewRays(rays, closed, epsRad);
  const out: Vector3[] = [];
  for (const i of kept) {
    const r = rays[i]!;
    out.push(
      viewer.dataHelper.sphericalCoordsToVector3(
        { yaw: r.yawRad, pitch: r.pitchRad },
        new Vector3(),
        radius,
      ),
    );
  }
  return { points: out, decimated: kept.length < vertices.length };
}

/** Append a path's segments (endpoint pairs) to the layer's stroke soup. */
function appendStroke(out: number[], points: Vector3[], closed: boolean): void {
  if (points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  if (closed) {
    const a = points[points.length - 1]!;
    const b = points[0]!;
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

/**
 * Expand earcut faces into the layer's fill triangle soup. `faces` index the
 * same flattening triangulateRings consumed: contour + holes with ≥ 3
 * points, in order — anything else would shift the cached indices.
 */
function appendFill(out: number[], rings: Vector3[][], faces: readonly number[][]): void {
  const pts = [rings[0]!, ...rings.slice(1).filter((r) => r.length >= 3)].flat();
  for (const face of faces) {
    for (const idx of face) {
      const p = pts[idx]!;
      out.push(p.x, p.y, p.z);
    }
  }
}

/** Face indices of a polygon's fill, from the named per-feature cache or fresh. */
function fillFacesOf(
  cache: WeakMap<RefFeature, readonly number[][] | null>,
  feature: RefFeature,
  rings: Vector3[][],
): readonly number[][] | null {
  let faces = cache.get(feature);
  if (faces === undefined) {
    faces = triangulateRings(rings);
    cache.set(feature, faces);
  }
  return faces;
}

/**
 * Build ONE layer's scene graph (ticket 15 batching + ticket 14 banding).
 *
 * Batching: every stroke of the layer lands in a single LineSegments, every
 * fill in a single non-indexed triangle-soup Mesh — per-layer draw calls
 * stay ~2 regardless of feature count (the pre-ticket-15 per-ring/per-fill
 * objects put ~10³ draw calls on every frame of a drag with the reporter's
 * 5-layer set). Point dots stay sprites on a shared material. Frustum-culling
 * granularity is surrendered deliberately: everything drawn is within
 * 700 m of the camera on an always-drawn sphere.
 *
 * Banding: a feature with no vertex within NEAR_BAND_M of the camera renders
 * from its cached coarse geometry (3 m ground DP); only its simplified
 * rings are projected per switch, and its fill triangulation is
 * cam-independent (lodFillFaces — computed once per payload). Near features
 * keep the full-fidelity path: ticket 11 angular DP for > 1000-vertex
 * features, fillFaces cache for the undecimated, fresh coarser-ε fill for
 * the decimated. Chord sag stays ≪ a pixel for ≤ 5 km edges on the
 * radius-10 sphere (see AnnotationOverlay's geometry notes).
 */
function buildLayerOverlay(
  viewer: Viewer,
  cam: OverlayCam,
  layer: RefLayerPayload,
): OverlayBuild {
  const build = new OverlayBuild();
  const features = layer.features.features;
  if (features.length === 0) return build;

  const color = colorNum(layer.color);
  const texture = makeDotTexture();
  build.textures.push(texture);
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

  const stroke: number[] = [];
  const fill: number[] = [];

  for (const f of features) {
    const entry = entryFor(f);
    if (entryIsCulled(cam, entry)) continue;
    const far = entryIsFar(cam, entry);
    const geometry = far ? lodGeometryFor(f) : f.geometry;
    switch (geometry.type) {
      case "Point": {
        const [p] = rayPositions(viewer, cam, [geometry.coordinates], RADIUS);
        const sprite = new Sprite(dotMat);
        sprite.position.copy(p!);
        sprite.scale.setScalar(DOT_SCALE);
        build.group.add(sprite);
        break;
      }
      case "LineString": {
        const coords = geometry.coordinates;
        const { points } = projectedPath(
          viewer,
          cam,
          coords,
          RADIUS,
          false,
          coords.length > SIMPLIFY_MIN_VERTICES,
        );
        appendStroke(stroke, points, false);
        break;
      }
      case "Polygon": {
        const rings = geometry.coordinates.map(openRing);
        // Decimate per FEATURE: a huge polygon decimates every ring, small
        // ones included (undecimated "small" rings of a 900-ring monster
        // still flood the fill's hole-bridging). Far-band rings are already
        // 3 m-coarse; the angular pass still applies when a coarse ring
        // exceeds the floor.
        const decimate = rings.reduce((n, r) => n + r.length, 0) > SIMPLIFY_MIN_VERTICES;
        // One projection per vertex, shared by the boundary strokes and the
        // fill; huge rings are angularly decimated (sub-pixel) first.
        const paths = rings.map((r) => projectedPath(viewer, cam, r, RADIUS, true, decimate));
        for (const { points } of paths) appendStroke(stroke, points, true);

        if (far) {
          // Fill from the FULL coarse rings (cam-independent vertex list →
          // faces cacheable). When angular decimation dropped stroke
          // vertices the paths no longer address that list — reproject.
          const fillRings = decimate
            ? rings.map((r) => rayPositions(viewer, cam, r, RADIUS))
            : paths.map((p) => p.points);
          const faces = fillFacesOf(lodFillFaces, f, fillRings);
          if (faces !== null) appendFill(fill, fillRings, faces);
        } else if (decimate) {
          // Ticket 11: decimated fills triangulate fresh per cam at the
          // coarser fill ε (the stroke already draws the true edge).
          const fillRings = rings.map(
            (r) => projectedPath(viewer, cam, r, RADIUS, true, true, FILL_EPS_RAD).points,
          );
          const faces = triangulateRings(fillRings);
          if (faces !== null) appendFill(fill, fillRings, faces);
        } else {
          const fillRings = paths.map((p) => p.points);
          const faces = fillFacesOf(fillFaces, f, fillRings);
          if (faces !== null) appendFill(fill, fillRings, faces);
        }
        break;
      }
    }
  }

  if (stroke.length > 0) {
    const geom = new BufferGeometry();
    build.geometries.push(geom);
    geom.setAttribute("position", new BufferAttribute(new Float32Array(stroke), 3));
    build.group.add(new LineSegments(geom, strokeMat));
  }
  if (fill.length > 0) {
    const geom = new BufferGeometry();
    build.geometries.push(geom);
    geom.setAttribute("position", new BufferAttribute(new Float32Array(fill), 3));
    build.group.add(new Mesh(geom, fillMat));
  }
  return build;
}

/* ---------- click-inspect (ticket 04) ---------- */

/** One vertex's screen position, or null when outside the current frustum
 * (off-view strokes must never win a hit; a fully-off-view feature has no
 * candidate at all). */
function projectVertex(viewer: Viewer, cam: OverlayCam, v: RefPosition): ScreenPoint | null {
  const { yawRad, pitchRad } = vertexView(cam, v);
  const pos = { yaw: yawRad, pitch: pitchRad };
  if (!viewer.dataHelper.isPointVisible(pos)) return null;
  const p = viewer.dataHelper.sphericalCoordsToViewerCoords(pos);
  return { x: p.x, y: p.y };
}

/**
 * Frustum-filtered stroke paths of a geometry for hit-testing: a Point is a
 * single-point path; polylines split into maximal runs of consecutive
 * visible vertices (splitting mid-path keeps segments real — a gap edge
 * across an off-screen span would be a phantom hit target). A run closes
 * only when it covers a closed input whole (the ring wrap edge); a partial
 * run's missing wrap is a frustum-edge corner case, deliberately skipped.
 */
function featurePaths(viewer: Viewer, cam: OverlayCam, g: RefGeometry): InspectPath[] {
  const runs = (verts: readonly RefPosition[], closed: boolean): InspectPath[] => {
    const out: InspectPath[] = [];
    let cur: ScreenPoint[] = [];
    for (const v of verts) {
      const p = projectVertex(viewer, cam, v);
      if (p === null) {
        if (cur.length > 0) out.push({ points: cur, closed: false });
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (cur.length > 0) out.push({ points: cur, closed: false });
    if (closed && out.length === 1 && out[0].points.length === verts.length) {
      return [{ points: out[0].points, closed: true }];
    }
    return out;
  };

  switch (g.type) {
    case "Point": {
      const p = projectVertex(viewer, cam, g.coordinates);
      return p === null ? [] : [{ points: [p], closed: false }];
    }
    case "LineString":
      return runs(g.coordinates, false);
    case "Polygon":
      return g.coordinates.flatMap((ring) => runs(openRing(ring), true));
  }
}

/** Nearest inspectable feature under a viewer-space click, null if none. */
function inspectAt(
  viewer: Viewer,
  cam: OverlayCam,
  layers: readonly RefLayerPayload[],
  visible: Readonly<Record<string, boolean>>,
  click: ScreenPoint,
): InspectHit | null {
  const candidates: InspectCandidate[] = [];
  for (const layer of layers) {
    if (visible[layer.name] === false) continue;
    for (const f of layer.features.features) {
      // Culled features are not rendered — nothing to click.
      if (entryIsCulled(cam, entryFor(f))) continue;
      candidates.push({
        layerName: layer.name,
        color: layer.color,
        properties: f.properties,
        paths: featurePaths(viewer, cam, f.geometry),
      });
    }
  }
  return nearestInspectFeature(click, candidates, INSPECT_HIT_PX);
}

/* ---------- component ---------- */

export default function ReferenceOverlay({ viewer, cam, layers, visible, onInspect, onLayerStatus }: ReferenceOverlayProps) {
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  // Memoized: a fresh array per render would re-run the labels effect (and
  // its PSV listener subscription) on every App render.
  const labels = useMemo(() => labeledPoints(cam, layers, visible), [cam, layers, visible]);
  // Generation counter cancelling pending build slices (ticket 16).
  const buildGen = useRef(0);

  // Three.js scene graph: one layer per time slice, cheapest (fewest served
  // vertices) first — the pano is draggable from the first frame and light
  // layers paint within milliseconds while a monster layer builds in the
  // background (ticket 16). A prop change (pano switch, visibility toggle,
  // layer refetch) bumps the generation: pending slices drop their work, the
  // cleanup disposes every completed build. Hidden layers never build. What
  // survives a switch is the per-feature CPU-side caches (cull entries, LOD
  // geometries, fill faces) — every GPU-backed object is recreated.
  useEffect(() => {
    if (cam === null) return; // nogps / altitude-less: nothing to draw
    const gen = ++buildGen.current;
    const queue = buildQueue(layers, visible);
    for (const l of queue) onLayerStatus?.(l.name, "building");
    const done: OverlayBuild[] = [];
    let i = 0;
    let timer: number | undefined;
    const step = (): void => {
      if (buildGen.current !== gen) return; // superseded — drop the slice
      const layer = queue[i++];
      if (layer === undefined) return;
      const b = buildLayerOverlay(viewer, cam, layer);
      done.push(b);
      viewer.renderer.addObject(b.group);
      viewer.needsUpdate();
      onLayerStatus?.(layer.name, "ready");
      if (i < queue.length) timer = window.setTimeout(step, 0);
    };
    step(); // the lightest layer builds synchronously — first paint carries it
    return () => {
      buildGen.current = gen + 1; // cancel pending slices
      clearTimeout(timer);
      for (const b of done) {
        viewer.renderer.removeObject(b.group);
        b.dispose();
      }
    };
  }, [viewer, cam, layers, visible, onLayerStatus]);

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

  // Click-inspect: mounted only while App hands us a sink (null while an
  // annotation/measure capture mode is active) and a camera exists. Same
  // drag-guard discipline as App's click-to-add — a look-around drag that
  // travels > CLICK_SLOP_PX is never an inspect. A miss reports null: the
  // click-elsewhere dismiss signal.
  useEffect(() => {
    if (onInspect === null || cam === null) return;
    const container = viewer.container;
    let downX = 0;
    let downY = 0;
    const onDown = (ev: MouseEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    // DOM click on the pano canvas (canvas target only — navbar/compass
    // clicks are chrome, not pano). viewerX/viewerY are container-relative
    // pixels, same space sphericalCoordsToViewerCoords emits.
    const onClick = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      if (!(ev.target instanceof HTMLCanvasElement)) return;
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > CLICK_SLOP_PX) return;
      const rect = container.getBoundingClientRect();
      onInspect(
        inspectAt(viewer, cam, layers, visible, {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        }),
      );
    };
    container.addEventListener("mousedown", onDown);
    container.addEventListener("click", onClick);
    return () => {
      container.removeEventListener("mousedown", onDown);
      container.removeEventListener("click", onClick);
    };
  }, [viewer, cam, layers, visible, onInspect]);

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
