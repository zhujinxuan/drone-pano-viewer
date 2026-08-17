# drone-pano-viewer

Skill repo for a local drone-panorama viewer: `app/` holds the Vite + React app, `SKILL.md` is the skill's user-facing contract, `CONTEXT.md` is the domain glossary.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label string equal to role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
