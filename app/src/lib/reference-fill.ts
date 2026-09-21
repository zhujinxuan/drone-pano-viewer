/**
 * Camera-local fill triangulation for polygon reference layers (ticket 11
 * fix, `.scratch/reference-layers/spec.md` §Client behavior "Camera-local
 * fill triangulation").
 *
 * The leak this module exists for: fills used to triangulate on ONE
 * tangent plane per feature whose normal was the normalized centroid of
 * all ring points. A giant near-horizon exterior ring that SURROUNDS the
 * camera (the farmland mask: tens of km of ring, camera inside a km-scale
 * hole) makes that normal an accident of vertex distribution — the
 * surviving vertices are dense on the near side of the camera, sparse on
 * the far side, so the normal tilted off nadir. Orthographic projection
 * then folds every ray more than 90° from the normal onto the near side
 * of the plane: the far arc of the exterior landed on top of the
 * near-camera hole ring, earcut bridged the "hole", and the fill rendered
 * over allowed ground that the served data provably excluded (issue 11:
 * data-side `contains=False` while the pano showed fill on the pad).
 *
 * Fix: triangulate in a stereographic projection from the zenith pole.
 * Ring points arrive on the overlay sphere (|p| = R, camera at the origin,
 * +y up): `f = 1 / (|p| − p.y)`, 2D = `(p.x·f, p.z·f)`. Every ground ray
 * has pitch ≤ 0 → p.y ≤ 0 → f ∈ [1/(2R), 1/R] — bounded for any camera —
 * and the map is a homeomorphism of the sphere-minus-zenith onto the
 * plane, injective over the ENTIRE ground hemisphere, so ring containment
 * (what earcut's hole bridging relies on) is preserved exactly, not
 * approximately. Nadir maps to the origin, the horizon to the unit circle.
 * The only singularity is the zenith itself (p.y = |p|), which no ground
 * ray can reach from a finite camera altitude — documented, not
 * runtime-guarded.
 *
 * Cache validity (ReferenceOverlay's per-feature fillFaces / lodFillFaces):
 * ring topology is camera-independent and the projection now provably
 * preserves it, so cached face indices stay correct under ANY camera — no
 * approximate-validity caveat remains.
 */
import { ShapeUtils, Vector2, Vector3 } from "three";

/**
 * Earcut face indices of a polygon's rings: project every ring
 * stereographically from the zenith pole (see module docstring — injective
 * over all ground rays, so planar hole containment equals containment on
 * the sphere), then ShapeUtils with the interior rings as holes. Returns
 * null when there is nothing to fill (degenerate contour or empty
 * triangulation). The result is cached per feature (fillFaces): the
 * indices address the flattened ring vertex list, which is cam-independent.
 */
export function triangulateRings(rings: readonly (readonly Vector3[])[]): readonly number[][] | null {
  const contour = rings[0];
  if (contour === undefined || contour.length < 3) return null;
  const holes = rings.slice(1).filter((r) => r.length >= 3);
  const to2D = (r: readonly Vector3[]): Vector2[] =>
    r.map((p) => {
      const f = 1 / (p.length() - p.y);
      return new Vector2(p.x * f, p.z * f);
    });
  const faces = ShapeUtils.triangulateShape(to2D(contour), holes.map(to2D));
  return faces.length === 0 ? null : faces;
}
