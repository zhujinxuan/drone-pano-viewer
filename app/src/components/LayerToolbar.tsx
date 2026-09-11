/**
 * LayerToolbar (reference-layers ticket 04, spec §Client behavior): the
 * foldable, draggable floating panel listing every reference layer — color
 * swatch, name, visibility checkbox (drives ReferenceOverlay's `visible`
 * map), feature count, and a warning glyph with explanatory tooltip when
 * `status != "ok"`. Panel position and fold state persist in localStorage;
 * dragging is by header via pointer events (pointer capture, so a drag that
 * leaves the header never drops the panel).
 *
 * Also exports `InspectReadout` — the small dismissable readout for
 * click-inspect (same ticket): layer name + the feature's property table,
 * read-only. Esc / click-elsewhere / ✕ all dismiss (App owns that keymap).
 *
 * Pure-props discipline like AnnotationPanel: visibility state and the
 * inspect hit live in App; the only local state is the panel's own UI
 * geometry (position + fold).
 */
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RefLayerPayload } from "../lib/reference-layers";
import type { InspectHit } from "../lib/reference-inspect";
import "./LayerToolbar.css";

/** localStorage key — same "pano." prefix as `pano.northOffsetDeg`. */
const STORAGE_KEY = "pano.refLayerToolbar";
/** Drag clamps keep at least this many px of the panel inside the viewport. */
const EDGE_MARGIN_PX = 8;
const MIN_VISIBLE_PX = 64;

export interface LayerToolbarProps {
  layers: readonly RefLayerPayload[];
  /** Layer name → visible (absent = visible); App owns it, we only toggle. */
  visible: Readonly<Record<string, boolean>>;
  /** Flip one layer's visibility. */
  onToggleVisible: (name: string) => void;
}

interface PanelState {
  x: number;
  y: number;
  folded: boolean;
}

/** Bottom-right, clear of the compass (bottom-left) and nav strip (center). */
function defaultPanelState(): PanelState {
  return {
    x: window.innerWidth - 278,
    y: window.innerHeight - 176,
    folded: false,
  };
}

/** Keep the header grabbable: never fully off-viewport (windows resize). */
function clampToViewport(s: PanelState): PanelState {
  const maxX = Math.max(EDGE_MARGIN_PX, window.innerWidth - MIN_VISIBLE_PX);
  const maxY = Math.max(EDGE_MARGIN_PX, window.innerHeight - MIN_VISIBLE_PX);
  return {
    x: Math.min(Math.max(s.x, EDGE_MARGIN_PX), maxX),
    y: Math.min(Math.max(s.y, EDGE_MARGIN_PX), maxY),
    folded: s.folded,
  };
}

function persist(s: PanelState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable (private mode…) — position just won't persist */
  }
}

/** Load + validate the stored geometry; anything malformed → the default. */
function loadPanelState(): PanelState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof v.x === "number" &&
        Number.isFinite(v.x) &&
        typeof v.y === "number" &&
        Number.isFinite(v.y) &&
        typeof v.folded === "boolean"
      ) {
        return clampToViewport({ x: v.x, y: v.y, folded: v.folded });
      }
    }
  } catch {
    /* corrupted JSON → default */
  }
  return defaultPanelState();
}

/** Warning-glyph tooltip per endpoint status (ticket 04 wording). */
function statusTip(status: RefLayerPayload["status"]): string {
  if (status === "invalid") return "invalid geojson, showing last good";
  if (status === "missing") return "file not found";
  return "";
}

export default function LayerToolbar({ layers, visible, onToggleVisible }: LayerToolbarProps) {
  const [panel, setPanel] = useState<PanelState>(loadPanelState);
  // Latest geometry outside React's batching: the drag-end persist must see
  // the final move even if pointerup lands before the last re-render.
  const panelRef = useRef(panel);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const movePanel = (next: PanelState): void => {
    panelRef.current = next;
    setPanel(next);
  };

  /* Drag by header: left button only, never from the fold button (its click
   * is a toggle, not a drag), pointer capture so leaving the header mid-drag
   * keeps following. Position persists on release — not per move. */
  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button") !== null) return;
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      ox: panelRef.current.x,
      oy: panelRef.current.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null) return;
    movePanel(
      clampToViewport({
        ...panelRef.current,
        x: d.ox + e.clientX - d.px,
        y: d.oy + e.clientY - d.py,
      }),
    );
  };
  const onHeaderPointerUp = (): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    persist(panelRef.current);
  };

  const toggleFold = (): void => {
    const next = { ...panelRef.current, folded: !panelRef.current.folded };
    movePanel(next);
    persist(next);
  };

  if (layers.length === 0) return null; // zero layers → no toolbar at all

  return (
    <div
      className="lt-root"
      style={{ left: panel.x, top: panel.y }}
      role="complementary"
      aria-label="Reference layers"
    >
      <div
        className="lt-head"
        title="Drag to move"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="lt-title">Layers · {layers.length}</span>
        <button
          type="button"
          className="lt-fold"
          aria-expanded={!panel.folded}
          title={panel.folded ? "Unfold layer list" : "Fold layer list"}
          onClick={toggleFold}
        >
          {panel.folded ? "▸" : "▾"}
        </button>
      </div>
      {!panel.folded && (
        <div className="lt-body">
          {layers.map((l) => (
            <label key={l.name} className="lt-row" title={l.name}>
              <input
                type="checkbox"
                checked={visible[l.name] ?? true}
                onChange={() => onToggleVisible(l.name)}
              />
              <span className="lt-swatch" style={{ background: l.color }} />
              <span className="lt-name">{l.name}</span>
              {l.status !== "ok" && (
                <span className="lt-warn" title={statusTip(l.status)}>
                  ⚠
                </span>
              )}
              <span className="lt-count">{l.features.features.length}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- click-inspect readout ---------- */

/** Property value → display text: scalars verbatim, containers as JSON. */
function inspectValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v); // e.g. circular — properties come from JSON so this is moot
  }
}

export interface InspectReadoutProps {
  hit: InspectHit;
  onClose: () => void;
}

/**
 * Small read-only readout for the clicked reference feature: layer name
 * (with its swatch) + every property, in file order. No editing
 * affordances — the only control is the ✕.
 */
export function InspectReadout({ hit, onClose }: InspectReadoutProps) {
  const entries = Object.entries(hit.properties);
  return (
    <div className="lt-readout" role="dialog" aria-label="Reference feature properties">
      <div className="lt-ro-head">
        <span className="lt-swatch" style={{ background: hit.color }} />
        <span className="lt-ro-name">{hit.layerName}</span>
        <button type="button" className="lt-ro-x" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="lt-ro-empty">No properties on this feature.</div>
      ) : (
        <table className="lt-ro-table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{inspectValue(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
