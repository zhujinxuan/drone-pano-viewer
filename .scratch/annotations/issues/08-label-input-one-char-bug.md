# 08 — Label input captures only one character (per-render select-all bug)

Status: done
Blocked by: —

User report 2026-08-26: typing a POI label in the inline input keeps only ~one character.

## Cause

`AnnotationPanel.tsx` focused + select-all'd the label input from an **inline `ref` callback**:

```tsx
ref={(el) => { if (el !== null) { el.focus(); el.select(); } }}
```

An inline ref gets a fresh function identity on every render, so React re-invokes it after each render (old ref with `null`, new with the node). Sequence: keystroke → `setEditValue` → re-render → ref re-runs → `select()` re-selects the whole text → next keystroke replaces everything. The input can never hold more than one character; App's 10 Hz HUD re-renders re-select even between keystrokes.

Introduced by ticket 05's "focus + select-all on mount" requirement — correct intent, wrong mechanism.

## Fix

Stable `useRef` (`editInputRef`) + focus/select in a `useEffect` keyed on `editing`, so it fires exactly once per edit session. `app/src/components/AnnotationPanel.tsx` only.

## Verification

- `tsc --noEmit` clean; 111 vitest tests pass.
- Live browser smoke on real pano `wzbjv3bu` (temp `--annotations` override, user data untouched): point mode → ground click → typed `ABC` → `ABC`; typed `xyz` → `ABCxyz`; Enter → row label `ABCxyz`, persisted through to the GeoJSON outbox.
