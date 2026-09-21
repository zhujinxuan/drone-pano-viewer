/**
 * Global overlay opacity multiplier (`.scratch/overlay-opacity/spec.md`).
 *
 * Layers are often too faint against the pano, but the base alphas are the
 * right balance for reading the photo — so Alt+scroll scales them by a
 * multiplier that reaches **above** 100% (default). Effective material
 * alpha = base × multiplier, clamped at 1 (three.js opacity ceiling).
 *
 * Scope: reference layers + finished annotations only; measure/HUD/reticle
 * and in-progress sketch affordances are never scaled (kept usable at low
 * multiplier). Applied in App, consumed by both overlay components.
 */

/** localStorage key — same "pano." prefix as `pano.northOffsetDeg`. */
export const OVERLAY_OPACITY_KEY = "pano.overlayOpacity";
export const OPACITY_MIN = 0.1;
export const OPACITY_MAX = 3;
/** One Alt+wheel notch = one step (10% of base). */
export const OPACITY_STEP = 0.1;
export const OPACITY_DEFAULT = 1;

/** Quantize onto the 10% grid, then clamp into [10%, 300%]. Non-finite → default. */
export function clampMultiplier(m: number): number {
  if (!Number.isFinite(m)) return OPACITY_DEFAULT;
  // ×10/÷10 kills float dust (0.7 + 0.1 === 0.7999999999999999) — stepped
  // values must stay exactly on the grid or the chip would show 80.000…%.
  const stepped = Math.round(m * 10) / 10;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, stepped));
}

/** One Alt+wheel notch from `current`: ±10% on the grid, clamped at the range ends. */
export function stepMultiplier(current: number, dir: 1 | -1): number {
  return clampMultiplier(current + dir * OPACITY_STEP);
}

/**
 * Effective material alpha: base × multiplier, never above 1 (a three.js
 * opacity > 1 is meaningless and a selected 0.95 stroke must cap at solid).
 */
export function effectiveAlpha(base: number, multiplier: number): number {
  return Math.min(1, base * multiplier);
}

/** Parse the persisted multiplier; missing/malformed/out-of-range → default 100%. */
export function parseStoredMultiplier(raw: string | null): number {
  // `Number("") === 0` — an empty or whitespace value must read as "not
  // set" (→ 100%), never clamp 0 up to the 10% floor.
  if (raw === null || raw.trim() === "") return OPACITY_DEFAULT;
  return clampMultiplier(Number(raw));
}

/** Read the persisted multiplier (storage unavailable/corrupt → default 100%). */
export function loadOverlayOpacity(): number {
  try {
    return parseStoredMultiplier(window.localStorage.getItem(OVERLAY_OPACITY_KEY));
  } catch {
    return OPACITY_DEFAULT;
  }
}

/** Persist the multiplier; storage failures are non-fatal (session-only then). */
export function saveOverlayOpacity(m: number): void {
  try {
    window.localStorage.setItem(OVERLAY_OPACITY_KEY, String(m));
  } catch {
    /* private mode… — the multiplier just won't survive a reload */
  }
}
