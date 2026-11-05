# Changelog

## 0.2.0 — unreleased

- `ownershipFile` config: read an existing `[{glob, owner}]` ownership map instead of duplicating it in frontmatter. `doctor` reports unreadable files and owners that have no warden definition.
- README: team install via `.claude/settings.json`, ownership maps, CI recipe, alpha status.
- docs/ORIGIN.md: updated with the full 166-mission record.

## 0.1.1

- Fix: bash allowlist prefixes now match path continuations (`bun test pkg` allows `bun test pkg/src/x.test.ts`).

## 0.1.0

Initial extraction from reactive-agents-ts (see docs/ORIGIN.md).

- Claude Code plugin: dispatch gate, authority guard, report gate, outcome ledger (hooks)
- Skills: mission-brief, upward-report, dispatch, wardens
- Agents: debrief-scribe, evidence-warden
- Templates: domain, specialist
- Zero-dependency CLI: `warden new | route | doctor | stats | check`
