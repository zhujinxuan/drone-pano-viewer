/**
 * Client-side reference-layer build/visibility policies (tickets 16/17) —
 * the pure seams of ReferenceOverlay's scheduler and App's visibility
 * seeding, extracted for unit tests.
 */
import { SLOW_LAYER_VERTEX_BUDGET } from "./reference-lod.ts";
import type { RefLayerPayload } from "./reference-layers.ts";

/**
 * Visibility seeding (ticket 17): a layer the user has already toggled keeps
 * their choice; a newly-seen layer starts visible unless its served vertex
 * count exceeds SLOW_LAYER_VERTEX_BUDGET — heavy layers (dissolved avoidance
 * unions) load but start hidden, enabled deliberately from the toolbar.
 */
export function seedVisibility(
  layers: readonly RefLayerPayload[],
  prev: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const l of layers) {
    next[l.name] = prev[l.name] ?? l.vertices <= SLOW_LAYER_VERTEX_BUDGET;
  }
  return next;
}

/**
 * Overlay build queue (ticket 16): visible, non-empty layers, cheapest
 * (fewest served vertices) first — the pano's first paint carries the light
 * layers while a monster builds in the background. Flag order survives among
 * equals (Array.sort is stable).
 */
export function buildQueue(
  layers: readonly RefLayerPayload[],
  visible: Readonly<Record<string, boolean>>,
): RefLayerPayload[] {
  return layers
    .filter((l) => visible[l.name] !== false && l.features.features.length > 0)
    .sort((a, b) => a.vertices - b.vertices);
}
