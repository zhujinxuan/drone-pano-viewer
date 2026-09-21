import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { vincentyDirect } from "./geodesy.ts";
import { makeProjector, type OverlayCam } from "./overlay-geometry.ts";
import { triangulateRings } from "./reference-fill.ts";

// Ticket 11 (giant-polygon fill leak) reproducer, driven through the public
// seam. Geometry mirrors the reporter's farmland mask: the camera stands
// inside a 300 m hole; the 8 km exterior is centered 5 km due north, so it
// SURROUNDS the camera (5000 < 8000) with an azimuthally asymmetric vertex
// distribution — the surviving vertices are dense on the near (south) arc,
// sparse on the far (north) arc — exactly what tilts a centroid-derived
// tangent-plane normal off nadir. Camera = the spec's example capture
// (same as overlay-geometry.test.ts).

/** The spec's example capture (44.9 N, 125.1 E, 112.5 m AGL). */
const CAM: OverlayCam = { lat: 44.9, lon: 125.1, relAltM: 112.5 };

/** Overlay sphere radius (SPHERE_RADIUS 10, just inside the pano). */
const R = 10;

const project = makeProjector(CAM);

/** Closed [lon, lat] ground circle: `n` vertices + the duplicated closer. */
function groundCircle(lat: number, lon: number, radiusM: number, n: number): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = vincentyDirect(lat, lon, (360 * i) / n, radiusM);
    ring.push([p.lon, p.lat]);
  }
  ring.push(ring[0]!);
  return ring;
}

/**
 * A ground vertex's position on the `radius` sphere in the PSV ray frame
 * (x east, y up, z north — every ground ray has pitch ≤ 0, i.e. y ≤ 0).
 */
function spherePoint(vertex: readonly [number, number], radius: number = R): Vector3 {
  const { yawRad, pitchRad } = project(vertex);
  return new Vector3(
    radius * Math.cos(pitchRad) * Math.sin(yawRad),
    radius * Math.sin(pitchRad),
    radius * Math.cos(pitchRad) * Math.cos(yawRad),
  );
}

/** Unit camera ray toward the ground point `distanceM` away on `bearing`. */
function groundRay(bearingDeg: number, distanceM: number): Vector3 {
  const p = vincentyDirect(CAM.lat, CAM.lon, bearingDeg, distanceM);
  return spherePoint([p.lon, p.lat], 1);
}

/**
 * Projection-independent oracle: how many fill triangles the ray t·dir
 * (t > 0, camera at the origin) passes through. Plane intersection +
 * barycentric containment over the 3D sphere points — it never consults
 * the 2D projection under test, so it cannot be tautological with the
 * code it checks.
 */
function rayHitCount(dir: Vector3, faces: readonly number[][], pts: readonly Vector3[]): number {
  let hits = 0;
  for (const [ia, ib, ic] of faces) {
    const a = pts[ia]!;
    const b = pts[ib]!;
    const c = pts[ic]!;
    const ab = new Vector3().subVectors(b, a);
    const ac = new Vector3().subVectors(c, a);
    const n = new Vector3().crossVectors(ab, ac);
    const denom = n.dot(dir);
    if (Math.abs(denom) < 1e-12) continue; // ray parallel to the face plane
    const t = n.dot(a) / denom;
    if (t <= 0) continue;
    const ap = dir.clone().multiplyScalar(t).sub(a);
    const d00 = ab.dot(ab);
    const d01 = ab.dot(ac);
    const d11 = ac.dot(ac);
    const d20 = ap.dot(ab);
    const d21 = ap.dot(ac);
    const det = d00 * d11 - d01 * d01;
    if (Math.abs(det) < 1e-12) continue; // degenerate (zero-area) face
    const u = (d11 * d20 - d01 * d21) / det;
    const v = (d00 * d21 - d01 * d20) / det;
    if (u >= 0 && v >= 0 && u + v <= 1) hits++;
  }
  return hits;
}

describe("triangulateRings — hole containment (ticket 11 giant-mask leak)", () => {
  // Hole: 300 m circle centered ON the camera (the camera is inside it).
  // Exterior: 8 km circle centered 5 km north — the camera is inside it as
  // well (5000 < 8000); its southern reach ends 3 km south of the camera.
  const hole = groundCircle(CAM.lat, CAM.lon, 300, 180).map((v) => spherePoint(v));
  const extCenter = vincentyDirect(CAM.lat, CAM.lon, 0, 5000);
  const exterior = groundCircle(extCenter.lat, extCenter.lon, 8000, 720).map((v) => spherePoint(v));

  const faces = triangulateRings([exterior, hole]);
  const pts = [exterior, hole].flat(); // the flattening the indices address

  it("triangulates the giant ring set (guards a vacuous leak test)", () => {
    expect(faces).not.toBeNull();
  });

  it("keeps the hole unfilled — in-hole ground rays hit no fill triangle", () => {
    expect(faces).not.toBeNull();
    // Nadir (0 m), 100 m due east, 200 m due north — all inside the 300 m
    // hole, whose center is the camera itself.
    const rays = [groundRay(0, 0), groundRay(90, 100), groundRay(0, 200)];
    for (const ray of rays) {
      expect(rayHitCount(ray, faces!, pts)).toBe(0);
    }
  });

  it("still fills the ring — an in-fill ground ray hits a fill triangle", () => {
    expect(faces).not.toBeNull();
    // 2000 m due south: inside the exterior (southern reach 5000 − 8000 =
    // −3000 m), far beyond the 300 m hole.
    expect(rayHitCount(groundRay(180, 2000), faces!, pts)).toBeGreaterThan(0);
  });
});
