/**
 * Minimal ambient declarations for the slice of three (r185) used by the
 * overlay components and `lib/reference-fill.ts`.
 *
 * Why this exists: `three` is installed only as a transitive dependency of
 * `@photo-sphere-viewer/core` and ships no TypeScript types; `@types/three`
 * is not installed either. Importing "three" from app code resolves fine at
 * runtime (npm hoisting) but fails `tsc --noEmit` (TS7016). This file
 * declares exactly the surface the overlay touches so the import typechecks.
 *
 * Replace with `@types/three` + `three` as a direct dependency when that
 * lands (ticket 07 cleanup). Signatures mirror the real API — do not
 * "improve" them. This declaration owns the "three" specifier project-wide
 * (ambient module), including inside PSV's own index.d.ts, which is
 * compatible because it is a subset.
 */

declare module "three" {
  export class Vector2 {
    constructor(x?: number, y?: number);
  }

  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    copy(v: Vector3): this;
    clone(): Vector3;
    normalize(): this;
    dot(v: Vector3): number;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    subVectors(a: Vector3, b: Vector3): this;
    multiplyScalar(scalar: number): this;
    divideScalar(scalar: number): this;
    crossVectors(a: Vector3, b: Vector3): this;
    length(): number;
    setScalar(scalar: number): this;
  }

  export class Object3D {
    position: Vector3;
    scale: Vector3;
    add(...objects: Object3D[]): this;
  }

  export class Group extends Object3D {}

  export interface MaterialParameters {
    color?: number;
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
  }

  export interface LineBasicMaterialParameters extends MaterialParameters {
    /** Accepted but clamped to 1 px on Windows/ANGLE. */
    linewidth?: number;
  }

  export interface LineDashedMaterialParameters extends LineBasicMaterialParameters {
    dashSize?: number;
    gapSize?: number;
  }

  export interface MeshBasicMaterialParameters extends MaterialParameters {
    side?: number;
  }

  export interface SpriteMaterialParameters extends MaterialParameters {
    map?: Texture;
  }

  export abstract class Material {
    dispose(): void;
  }

  export class LineBasicMaterial extends Material {
    constructor(params?: LineBasicMaterialParameters);
  }

  export class LineDashedMaterial extends Material {
    constructor(params?: LineDashedMaterialParameters);
  }

  export class MeshBasicMaterial extends Material {
    constructor(params?: MeshBasicMaterialParameters);
  }

  export class SpriteMaterial extends Material {
    constructor(params?: SpriteMaterialParameters);
  }

  export class Texture {
    dispose(): void;
  }

  export class CanvasTexture extends Texture {
    constructor(canvas?: HTMLCanvasElement);
  }

  export class BufferGeometry {
    setFromPoints(points: Vector3[]): this;
    setAttribute(name: string, attribute: BufferAttribute): this;
    dispose(): void;
  }

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
  }

  export class Line extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry: BufferGeometry;
    material: Material | Material[];
    /** Required for LineDashedMaterial to show dashes. */
    computeLineDistances(): this;
  }

  /** Segment-pair variant of Line — the batched stroke primitive (ticket 15). */
  export class LineSegments extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry: BufferGeometry;
    material: Material | Material[];
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry: BufferGeometry;
    material: Material | Material[];
  }

  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial);
  }

  export class ShapeUtils {
    static triangulateShape(contour: Vector2[], holes: Vector2[][]): number[][];
  }

  export const DoubleSide: number;
}
