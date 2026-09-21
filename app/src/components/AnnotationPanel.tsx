import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { AnnFeature, AnnKind } from "../lib/annotations";
import { featureVertices } from "../lib/annotations";

/**
 * AnnotationPanel — annotation UI chrome for the pano viewer
 * (spec: `.scratch/annotations/spec.md`, "Capture & interaction" +
 * "Selection, labels, deletion").
 *
 * Renders:
 *  1. Top-left rail (always visible): Point / Line / Polygon mode buttons
 *     with active-state styling, a fourth `measure` button (reference-layers
 *     ticket 05) and a fifth `height` button (vertical-measure ticket 01) —
 *     each exclusive with the others, wired through to App like the rest —
 *     a `?` chip unfolding a shortcuts dropdown (help only — no rebinding),
 *     and a list-toggle chip.
 *  2. Entity list panel (`e` toggles): the current photo's entities grouped
 *     Point/Line/Polygon in file order; each row = label (click → select +
 *     camera swing, double-click → rename), a look-at affordance, inline
 *     label edit (Enter/blur commits, Esc cancels), delete button.
 *  3. Drawing hint bar while `inProgress` is set, with ✓ finish and undo
 *     vertex buttons (finish disabled below the min vertex count).
 *  4. Undo-delete toast: rendered from the `toast` prop with a 5-second
 *     auto-dismiss countdown; Undo fires `onUndoDelete`.
 *  5. Label-after-finish: when `pendingLabelForId` is set, that row's inline
 *     input opens focused with the auto-name pre-filled and selected (typing
 *     replaces); Enter/Esc accept as-is per spec.
 *
 * Pure-props component: every piece of annotation state (mode, selection,
 * features, toast, panel open) lives in App (ticket 07). Local state is UI
 * only — shortcuts dropdown, inline-edit session, edit buffer. No global
 * keyboard listeners are attached here (App owns the keymap); the inline
 * input stops keydown propagation so draw keys don't leak while typing.
 *
 * Props contract for App.tsx wiring (ticket 07):
 *
 *   features            current photo's entities (file order; grouping is local)
 *   mode                active draw mode, null = idle
 *   onModeChange        new mode, or null when the active mode's button is
 *                       clicked again (exit) — App also exits via Esc
 *   canAnnotate         false greys the mode buttons (no position/altitude)
 *   measureActive       measure mode on (ticket 05; exclusive with `mode`)
 *   onMeasureToggle     measure rail button click — App enters/exits measure,
 *                       leaving the annotation modes
 *   canMeasure          false greys the measure AND height buttons (no
 *                       position/altitude — needs no annotations outbox:
 *                       a measurement is never persisted)
 *   heightActive        height mode on (ticket 01; exclusive with `mode`
 *                       and measure)
 *   onHeightToggle      height rail button click — App enters/exits height,
 *                       leaving the annotation modes and measure
 *   inProgress          non-null shows the hint bar; vertexCount drives the
 *                       `N verts` readout and the ✓/undo disabled states
 *   onFinish            ✓ button (enabled only at line ≥ 2 / polygon ≥ 3)
 *   onUndoVertex        ↩ button (enabled only at vertexCount ≥ 1)
 *   selectedId          highlighted row
 *   onSelect            row label click → select + camera swing (App)
 *   onLookAt            row ⌖ click → camera swing (App)
 *   onLabelChange       inline edit commit (only when label actually changed
 *                       and non-empty; App relabels + bumps `updated`)
 *   onDelete            row ✕ click → instant delete (App shows the toast)
 *   toast               {id, label} of the just-deleted feature, null = none
 *   onUndoDelete        toast Undo → same-id restore (store logic in lib)
 *   onDismissToast      fired by this component after the 5 s countdown
 *   pendingLabelForId   entity id whose label input should open focused
 *                       (select-all); also forces the list panel open
 *   onPendingLabelDone  fired when a pending-originated label session closes
 *                       (accept-as-is counts) — App clears the pending id so
 *                       a later `l` on the same entity re-triggers
 *   open / onOpenChange entity list panel visibility (`e` key + chips here)
 */

/** Hint-bar model while a shape is being drawn (point finishes instantly). */
export interface AnnotationHint {
  kind: "line" | "polygon";
  vertexCount: number;
}

/** Undo-delete toast model: the feature as it was at deletion time. */
export interface AnnotationToast {
  id: string;
  label: string;
}

export interface AnnotationPanelProps {
  features: AnnFeature[];
  mode: AnnKind | null;
  onModeChange: (mode: AnnKind | null) => void;
  canAnnotate: boolean;
  /** Measure mode (reference-layers ticket 05): rail button state. */
  measureActive: boolean;
  /** Enter/exit measure mode; exclusive with the draw modes. */
  onMeasureToggle: () => void;
  /** Height mode (vertical-measure ticket 01): rail button state. */
  heightActive: boolean;
  /** Enter/exit height mode; exclusive with the draw modes and measure. */
  onHeightToggle: () => void;
  /** Position + altitude available (nogps / missing RelativeAltitude). */
  canMeasure: boolean;
  inProgress: AnnotationHint | null;
  onFinish: () => void;
  onUndoVertex: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLookAt: (id: string) => void;
  onLabelChange: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  toast: AnnotationToast | null;
  onUndoDelete: (id: string) => void;
  onDismissToast: () => void;
  pendingLabelForId: string | null;
  onPendingLabelDone: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* ---------- static tables ---------- */

const KIND_ORDER: readonly AnnKind[] = ["point", "line", "polygon"];

/** Help-only keymap (spec: no rebinding in v1). */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["Space / click", "add vertex at reticle / clicked ground point"],
  ["Enter", "finish shape"],
  ["u / Backspace", "undo last vertex"],
  ["Esc", "cancel drawing / exit mode"],
  ["Delete / d", "delete selected entity"],
  ["l", "relabel selected entity"],
  ["Tab", "cycle selection"],
  ["e", "toggle this entity list"],
  ["[ / ]", "previous / next photo"],
];

const MODES: readonly { kind: AnnKind; name: string; icon: ReactNode }[] = [
  {
    kind: "point",
    name: "Point",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.6" fill="currentColor" />
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    kind: "line",
    name: "Line",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <polyline
          points="2,13 6.5,7 10.5,9 14,3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    kind: "polygon",
    name: "Polygon",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <polygon
          points="8,1.8 14.2,6.3 11.8,13.6 4.2,13.6 1.8,6.3"
          fill="currentColor"
          fillOpacity="0.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

/** Min vertices before ✓ is enabled (spec: line ≥ 2, polygon ≥ 3). */
const minVerts = (kind: "line" | "polygon"): number => (kind === "line" ? 2 : 3);

/** Vertex count for display (in-memory polygon rings are stored unclosed). */
const vertCount = (f: AnnFeature): number => featureVertices(f).length;

/* ---------- component ---------- */

const CSS = `
.ann-pnl-root{position:absolute;inset:0;z-index:15;pointer-events:none;color:#e6e6ea}
.ann-pnl-rail{pointer-events:auto;position:absolute;top:52px;left:12px;display:flex;flex-direction:column;gap:5px;padding:7px 6px;background:rgba(15,16,20,.9);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:10px}
.ann-pnl-rail-sep{height:1px;margin:2px 3px;background:rgba(255,255,255,.1)}
.ann-pnl-mbtn{display:flex;align-items:center;justify-content:center;width:34px;height:34px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:7px;color:#cdd2dc;cursor:pointer;padding:0;font-size:14px;line-height:1}
.ann-pnl-mbtn svg{display:block}
.ann-pnl-mbtn:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff}
.ann-pnl-mbtn.ann-pnl-on{background:rgba(138,180,248,.22);border-color:#8ab4f8;color:#aecbfa}
.ann-pnl-mbtn:disabled{opacity:.32;cursor:not-allowed}
.ann-pnl-help{pointer-events:auto;position:absolute;top:52px;left:64px;width:268px;background:rgba(15,16,20,.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:4px 0 8px;z-index:17;animation:ann-pnl-in .16s ease}
.ann-pnl-help-title{display:flex;align-items:center;justify-content:space-between;padding:7px 8px 7px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#9aa0ab}
.ann-pnl-help-x{background:none;border:none;color:#9aa0ab;font-size:12px;cursor:pointer;padding:2px 5px;border-radius:4px}
.ann-pnl-help-x:hover{color:#e6e6ea;background:rgba(255,255,255,.07)}
.ann-pnl-help-row{display:flex;align-items:center;gap:9px;padding:3.5px 14px;font-size:11.5px}
.ann-pnl-help-row kbd{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:4px;padding:1px 6px;font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:10.5px;color:#e6e6ea;white-space:nowrap;flex:none}
.ann-pnl-help-row span{color:#9aa0ab}
.ann-pnl-panel{pointer-events:auto;position:absolute;top:52px;left:64px;width:282px;max-width:calc(100vw - 80px);max-height:min(60vh,560px);display:flex;flex-direction:column;background:rgba(15,16,20,.93);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;animation:ann-pnl-in .16s ease}
.ann-pnl-head{display:flex;align-items:center;justify-content:space-between;padding:9px 8px 9px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.ann-pnl-title{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#9aa0ab}
.ann-pnl-x{background:none;border:none;color:#9aa0ab;font-size:12px;cursor:pointer;padding:3px 6px;border-radius:4px}
.ann-pnl-x:hover{color:#e6e6ea;background:rgba(255,255,255,.07)}
.ann-pnl-body{flex:1;overflow-y:auto;padding:2px 0 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
.ann-pnl-body::-webkit-scrollbar{width:6px}
.ann-pnl-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}
.ann-pnl-group{margin-top:8px}
.ann-pnl-gtitle{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#8ab4f8;padding:2px 14px 3px}
.ann-pnl-row{display:flex;align-items:center;gap:2px;padding:0 5px 0 8px;border-left:2px solid transparent}
.ann-pnl-row:hover{background:rgba(255,255,255,.045)}
.ann-pnl-row.ann-pnl-sel{background:rgba(138,180,248,.14);border-left-color:#8ab4f8}
.ann-pnl-label{flex:1;min-width:0;display:flex;align-items:center;gap:7px;background:none;border:none;color:#e6e6ea;font-size:12px;padding:4.5px 3px;cursor:pointer;text-align:left}
.ann-pnl-label:hover{color:#fff}
.ann-pnl-kdot{width:7px;height:7px;border-radius:50%;flex:none}
.ann-pnl-k-point{background:#8ab4f8}
.ann-pnl-k-line{background:#81c99b}
.ann-pnl-k-polygon{background:#fdd663}
.ann-pnl-ltext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ann-pnl-vc{font-size:10px;color:#6b7078;flex:none;font-variant-numeric:tabular-nums}
.ann-pnl-acts{display:flex;align-items:center;flex:none;opacity:.6}
.ann-pnl-row:hover .ann-pnl-acts,.ann-pnl-row.ann-pnl-sel .ann-pnl-acts{opacity:1}
.ann-pnl-abtn{background:none;border:none;color:#9aa0ab;font-size:12px;line-height:1;padding:4px 4px;border-radius:4px;cursor:pointer}
.ann-pnl-abtn:hover{color:#e6e6ea;background:rgba(255,255,255,.07)}
.ann-pnl-abtn.ann-pnl-del:hover{color:#f28b82}
.ann-pnl-input{flex:1;min-width:0;background:rgba(255,255,255,.07);border:1px solid #8ab4f8;border-radius:5px;color:#fff;font-size:12px;padding:3.5px 7px;outline:none}
.ann-pnl-empty{padding:16px 14px;font-size:11.5px;color:#9aa0ab;line-height:1.55}
.ann-pnl-bottom{position:absolute;bottom:58px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:14}
.ann-pnl-hint{pointer-events:auto;display:flex;align-items:center;gap:8px;background:rgba(15,16,20,.9);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 8px 6px 12px;font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:11.5px;color:#cdd2dc;white-space:nowrap}
.ann-pnl-hbtn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:#cdd2dc;border-radius:6px;font-size:12px;width:27px;height:24px;cursor:pointer;line-height:1;padding:0}
.ann-pnl-hbtn:hover:not(:disabled){color:#fff;border-color:rgba(255,255,255,.4)}
.ann-pnl-hbtn:disabled{opacity:.35;cursor:not-allowed}
.ann-pnl-hok{border-color:rgba(129,201,155,.5);color:#81c99b}
.ann-pnl-hok:hover:not(:disabled){color:#0d0f14;background:#81c99b;border-color:#81c99b}
.ann-pnl-toast{pointer-events:auto;display:flex;align-items:center;gap:12px;background:rgba(15,16,20,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px 7px 14px;font-size:12px;color:#cdd2dc;animation:ann-pnl-in .18s ease}
.ann-pnl-tbtn{background:rgba(138,180,248,.18);border:1px solid rgba(138,180,248,.55);color:#aecbfa;border-radius:6px;font-size:10.5px;font-weight:600;padding:3.5px 10px;cursor:pointer;text-transform:uppercase;letter-spacing:.06em}
.ann-pnl-tbtn:hover{background:rgba(138,180,248,.32);color:#fff}
@keyframes ann-pnl-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
`;

export default function AnnotationPanel({
  features,
  mode,
  onModeChange,
  canAnnotate,
  inProgress,
  onFinish,
  onUndoVertex,
  selectedId,
  onSelect,
  onLookAt,
  onLabelChange,
  onDelete,
  toast,
  onUndoDelete,
  onDismissToast,
  pendingLabelForId,
  onPendingLabelDone,
  measureActive,
  onMeasureToggle,
  heightActive,
  onHeightToggle,
  canMeasure,
  open,
  onOpenChange,
}: AnnotationPanelProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  /** Inline-edit session; `escCommits` distinguishes the label-after-finish
   * input (Esc accepts as-is, spec §Labels) from a manual row edit (Esc cancels). */
  const [editing, setEditing] = useState<{ id: string; escCommits: boolean } | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  /* Focus + select-all ONCE per edit session (typing replaces the auto-name).
   * Must not live in the input's ref callback: an inline ref gets a fresh
   * identity every render, so React re-invokes it after each keystroke and
   * select() re-selects the whole text — the next character replaces it
   * again and the input can never hold more than one character. */
  useEffect(() => {
    if (editing === null) return;
    const el = editInputRef.current;
    if (el !== null) {
      el.focus();
      el.select();
    }
  }, [editing]);

  /** Latest dismiss callback for the countdown timer (identity-stable effect). */
  const dismissRef = useRef(onDismissToast);
  dismissRef.current = onDismissToast;

  /* Toast countdown: 5 s auto-dismiss, keyed on the deleted feature id so a
   * replaced toast restarts the clock and re-renders (frequent — HUD updates)
   * never reset it. */
  const toastId = toast?.id ?? null;
  useEffect(() => {
    if (toastId === null) return;
    const t = setTimeout(() => dismissRef.current(), 5000);
    return () => clearTimeout(t);
  }, [toastId]);

  /* Label-after-finish: open the fresh entity's inline input (pre-filled with
   * the auto-name, select-all so typing replaces) and make sure the list
   * carrying it is visible. Runs only when a new pending id arrives. */
  useEffect(() => {
    if (pendingLabelForId === null) return;
    const f = features.find((x) => x.properties.id === pendingLabelForId);
    if (f === undefined) return;
    if (!open) onOpenChange(true);
    setEditing({ id: pendingLabelForId, escCommits: true });
    setEditValue(f.properties.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on arrival only
  }, [pendingLabelForId]);

  const startEdit = (id: string): void => {
    const f = features.find((x) => x.properties.id === id);
    if (f === undefined) return;
    setEditing({ id, escCommits: false });
    setEditValue(f.properties.label);
  };

  /** Commit the inline edit: only a non-empty, actually-changed label fires
   * `onLabelChange` (relabel bumps `updated` — don't fire it needlessly).
   * A pending-originated session (accept-as-is included) always reports its
   * close so App can clear `pendingLabelForId` and re-arm `l`. */
  const commitEdit = (): void => {
    if (editing === null) return;
    const id = editing.id;
    const wasPending = editing.escCommits;
    const next = editValue.trim();
    const current = features.find((x) => x.properties.id === id)?.properties.label;
    if (next !== "" && next !== current) onLabelChange(id, next);
    setEditing(null);
    if (wasPending) onPendingLabelDone();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Keep App's global draw keys (Space/Enter/u/…) away while typing.
    e.stopPropagation();
    // IME composition (CJK labels): Enter confirms the composition, not the edit.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (editing?.escCommits === true) commitEdit();
      else setEditing(null);
    }
  };

  const pickMode = (kind: AnnKind): void => onModeChange(mode === kind ? null : kind);

  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: features.filter((f) => f.properties.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="ann-pnl-root">
      <style>{CSS}</style>

      <div className="ann-pnl-rail" role="toolbar" aria-label="Annotation modes">
        {MODES.map(({ kind, name, icon }) => (
          <button
            key={kind}
            type="button"
            className={`ann-pnl-mbtn${mode === kind ? " ann-pnl-on" : ""}`}
            disabled={!canAnnotate}
            aria-pressed={mode === kind}
            title={
              canAnnotate
                ? `${name} mode — click again (or Esc) to exit`
                : "no position/altitude — annotation unavailable"
            }
            onClick={() => pickMode(kind)}
          >
            {icon}
          </button>
        ))}
        <button
          type="button"
          className={`ann-pnl-mbtn${measureActive ? " ann-pnl-on" : ""}`}
          disabled={!canMeasure}
          aria-pressed={measureActive}
          title={
            canMeasure
              ? "Measure mode — click again (or Esc) to exit"
              : "no position/altitude — measure unavailable"
          }
          onClick={onMeasureToggle}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <line
              x1="3.2"
              y1="12.8"
              x2="12.8"
              y2="3.2"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeDasharray="2.4 2"
              strokeLinecap="round"
            />
            <circle cx="3.2" cy="12.8" r="1.7" fill="currentColor" />
            <circle cx="12.8" cy="3.2" r="1.7" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className={`ann-pnl-mbtn${heightActive ? " ann-pnl-on" : ""}`}
          disabled={!canMeasure}
          aria-pressed={heightActive}
          title={
            canMeasure
              ? "Height mode — click again (or Esc) to exit"
              : "no position/altitude — height measurement unavailable"
          }
          onClick={onHeightToggle}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <line
              x1="8"
              y1="13.2"
              x2="8"
              y2="3.6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeDasharray="2.4 2"
              strokeLinecap="round"
            />
            <circle cx="8" cy="13.2" r="1.7" fill="currentColor" />
            <path
              d="M6.3 5.4 8 3.4 9.7 5.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="ann-pnl-rail-sep" />
        <button
          type="button"
          className={`ann-pnl-mbtn${helpOpen ? " ann-pnl-on" : ""}`}
          aria-pressed={helpOpen}
          title="Keyboard shortcuts"
          onClick={() => setHelpOpen((v) => !v)}
        >
          ?
        </button>
        <button
          type="button"
          className={`ann-pnl-mbtn${open ? " ann-pnl-on" : ""}`}
          aria-pressed={open}
          title="Entity list (e)"
          onClick={() => onOpenChange(!open)}
        >
          ☰
        </button>
      </div>

      {helpOpen && (
        <div className="ann-pnl-help" role="dialog" aria-label="Keyboard shortcuts">
          <div className="ann-pnl-help-title">
            Shortcuts
            <button type="button" className="ann-pnl-help-x" title="Close" onClick={() => setHelpOpen(false)}>
              ✕
            </button>
          </div>
          {SHORTCUTS.map(([keys, desc]) => (
            <div className="ann-pnl-help-row" key={keys}>
              <kbd>{keys}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <aside className="ann-pnl-panel" aria-label="Annotations">
          <div className="ann-pnl-head">
            <span className="ann-pnl-title">
              Annotations{features.length > 0 ? ` · ${features.length}` : ""}
            </span>
            <button type="button" className="ann-pnl-x" title="Close (e)" onClick={() => onOpenChange(false)}>
              ✕
            </button>
          </div>
          <div className="ann-pnl-body">
            {groups.length === 0 ? (
              <div className="ann-pnl-empty">
                No annotations on this photo yet.
                <br />
                Pick Point / Line / Polygon on the rail, then aim at the ground and press Space or click.
              </div>
            ) : (
              groups.map((g) => (
                <div className="ann-pnl-group" key={g.kind}>
                  <div className="ann-pnl-gtitle">
                    {g.kind} · {g.items.length}
                  </div>
                  {g.items.map((f) => {
                    const id = f.properties.id;
                    const kind = f.properties.kind;
                    return (
                      <div key={id} className={`ann-pnl-row${selectedId === id ? " ann-pnl-sel" : ""}`}>
                        {editing?.id === id ? (
                          <input
                            className="ann-pnl-input"
                            value={editValue}
                            spellCheck={false}
                            ref={editInputRef}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={onInputKeyDown}
                            onBlur={commitEdit}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="ann-pnl-label"
                              title="Click to select (camera swings) · double-click to rename"
                              onClick={() => onSelect(id)}
                              onDoubleClick={() => startEdit(id)}
                            >
                              <span className={`ann-pnl-kdot ann-pnl-k-${kind}`} />
                              <span className="ann-pnl-ltext">{f.properties.label}</span>
                            </button>
                            {kind !== "point" && (
                              <span className="ann-pnl-vc">{vertCount(f)}v</span>
                            )}
                            <span className="ann-pnl-acts">
                              <button
                                type="button"
                                className="ann-pnl-abtn"
                                title="Look at"
                                aria-label={`Look at ${f.properties.label}`}
                                onClick={() => onLookAt(id)}
                              >
                                ⌖
                              </button>
                              <button
                                type="button"
                                className="ann-pnl-abtn"
                                title="Rename (l)"
                                aria-label={`Rename ${f.properties.label}`}
                                onClick={() => startEdit(id)}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="ann-pnl-abtn ann-pnl-del"
                                title="Delete (Delete/d)"
                                aria-label={`Delete ${f.properties.label}`}
                                onClick={() => onDelete(id)}
                              >
                                ✕
                              </button>
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <div className="ann-pnl-bottom">
        {inProgress !== null && (
          <div className="ann-pnl-hint" role="status">
            <span>
              {inProgress.kind === "line" ? "LINE" : "POLYGON"} · {inProgress.vertexCount}{" "}
              vert{inProgress.vertexCount === 1 ? "" : "s"} · Space/click add · u undo · Enter
              finish · Esc cancel
            </span>
            <button
              type="button"
              className="ann-pnl-hbtn"
              title="Undo vertex (u / Backspace)"
              disabled={inProgress.vertexCount === 0}
              onClick={onUndoVertex}
            >
              ↩
            </button>
            <button
              type="button"
              className="ann-pnl-hbtn ann-pnl-hok"
              title="Finish (Enter)"
              disabled={inProgress.vertexCount < minVerts(inProgress.kind)}
              onClick={onFinish}
            >
              ✓
            </button>
          </div>
        )}
        {toast !== null && (
          <div className="ann-pnl-toast" role="status">
            <span>
              Deleted “{toast.label}”
            </span>
            <button type="button" className="ann-pnl-tbtn" onClick={() => onUndoDelete(toast.id)}>
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
