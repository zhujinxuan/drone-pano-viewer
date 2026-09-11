# 06 — Docs: CONTEXT.md glossary + SKILL.md contract + ADR-0003

**What to build:** The paper trail matches the shipped behavior. CONTEXT.md gains **reference layer** (external, read-only, file-backed GeoJSON overlay; changed from outside, propagated by file-watch; viewer never writes it) and **measure** (ephemeral two-point distance/bearing readout, never persisted), and the existing **layer** entry explicitly notes it stays an annotation-only concept (filter by photo). SKILL.md gains a "Reference layers" section (CLI flag syntax, palette, label precedence, 1 km-union prefilter, watch semantics, toolbar, click-inspect) and measure-mode UI contract, mirroring the Annotations section's tone. ADR-0003 records the decision: watch-push, no CRUD API, geojson-only, server-side prefilter — noting it further revises ADR-0001's "State: none" after ADR-0002.

**Blocked by:** 01, 02, 04, 05.

**Status:** ready-for-agent

- [ ] CONTEXT.md: `reference layer` + `measure` terms added; `layer` entry disambiguated (annotation-only)
- [ ] SKILL.md: Reference layers section (CLI contract, prefilter, watch semantics, toolbar, inspect) + measure mode UI contract
- [ ] `docs/adr/0003-reference-layers.md` in ADR-0002's format
- [ ] Docs match the final implemented behavior exactly (no aspirational drift)

## Comments

Spec: `.scratch/reference-layers/spec.md`. Written last so the docs describe reality, not intent.
