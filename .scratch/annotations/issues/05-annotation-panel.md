# 05 — Annotation panel: top-left rail, mode buttons, shortcuts dropdown, entity list

Status: done
Blocked by: — (code against the spec's contracts; tickets 01/03/04 implement the modules you consume — do NOT edit their files; import `AnnFeature` from `../lib/annotations` per the spec schema even if that file doesn't exist yet)

Read `.scratch/annotations/spec.md` first — "Capture & interaction" and "Selection, labels, deletion" sections are binding. UI precedent: `app/src/components/MetadataPanel.tsx` (collapsible panel + own CSS block) and `NavStrip.tsx`.

## Target

New files only: `app/src/components/AnnotationPanel.tsx` (+ CSS). Do NOT edit App.tsx (ticket 07 wires you in).

## Change

One component `AnnotationPanel` exposing the panel UI; you own the exact prop/callback shape (document in file header + your report for ticket 07):

1. **Top-left rail** (always visible): three mode buttons — Point / Line / Polygon — with active-state styling; disabled (greyed + tooltip "no position/altitude — annotation unavailable") when the `canAnnotate` prop is false. A `?` chip unfolds a **collapsible shortcuts dropdown** listing the keymap (Space/click add vertex, Enter finish, u/Backspace undo vertex, Esc cancel/exit, Delete/d delete selected, l relabel, Tab cycle, e toggle panel, [/] photo nav). Help only — no rebinding.
2. **Entity list panel** (`e` toggles; current photo's entities passed in as props, grouped Point/Line/Polygon, file order): each row = label (click-to-select), a small "look at" affordance, inline label edit (click label text or edit icon → input, Enter/blur commits, Esc cancels), delete button.
3. **Drawing hint bar**: while `inProgress` is active, show the hint line (`LINE · 3 verts · Space/click add · u undo · Enter finish · Esc cancel`) + a ✓ finish button + an undo-vertex button.
4. **Undo-delete toast**: 5-second "deleted — undo" toast; the component renders it from a prop and fires `onUndoDelete` (the store logic — same-id restore — lives in lib, ticket 01/07).
5. **Label-after-finish input**: when a `pendingLabelForId` prop is set, focus an inline label input for that entity (auto-name pre-filled, select-all so typing replaces).
6. All interaction is via props/callbacks — the component holds only local UI state (input focus, toast countdown).

## Acceptance

`npx tsc --noEmit` clean for new files. No tests (browser-smoked by integrator). Report the exact props interface. Do NOT run the full suite, do NOT edit App.tsx or other tickets' files, do NOT run formatters/linters.

## Result

`app/src/components/AnnotationPanel.tsx` created (self-contained CSS block, MetadataPanel precedent; no App.tsx / other-ticket files touched). `npx tsc --noEmit` clean for it (only remaining project error is ticket 03's in-flight red test `ground-capture.test.ts`). Props contract for ticket 07 (default export, no other exports beyond the two prop helper interfaces):

```ts
export interface AnnotationHint { kind: "line" | "polygon"; vertexCount: number }
export interface AnnotationToast { id: string; label: string }
export interface AnnotationPanelProps {
  features: AnnFeature[];              // current photo, file order (grouping is local)
  mode: AnnKind | null;                // active draw mode, null = idle
  onModeChange: (mode: AnnKind | null) => void;  // null = exit (active button re-click; Esc is App's)
  canAnnotate: boolean;                // false greys mode buttons + tooltip
  inProgress: AnnotationHint | null;   // non-null shows hint bar; gates ✓/↩ disabled states
  onFinish: () => void;                // ✓ (enabled at line ≥ 2 / polygon ≥ 3)
  onUndoVertex: () => void;            // ↩ (enabled at ≥ 1 vertex)
  selectedId: string | null;
  onSelect: (id: string) => void;      // row click → select + camera swing
  onLookAt: (id: string) => void;      // row ⌖
  onLabelChange: (id: string, label: string) => void;  // fires only on real non-empty change
  onDelete: (id: string) => void;      // instant; App shows the toast
  toast: AnnotationToast | null;       // rendered 5 s, then onDismissToast fires
  onUndoDelete: (id: string) => void;  // same-id restore
  onDismissToast: () => void;
  pendingLabelForId: string | null;    // opens focused select-all inline input (forces panel open)
  open: boolean;
  onOpenChange: (open: boolean) => void;  // `e` key + rail ☰ chip + panel ✕
}
```

Notes for 07: inline input `stopPropagation`s keydown (draw keys can't leak while typing) and guards IME composition on Enter; toast countdown is keyed on `toast.id` so re-renders never reset the 5 s; `import type { AnnFeature, AnnKind } from "../lib/annotations"` (ticket 01's landed module).
