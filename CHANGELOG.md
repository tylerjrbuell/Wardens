# Changelog

## 0.1.1 — unreleased

- Fix: bash allowlist prefixes now match path continuations (`bun test pkg` allows `bun test pkg/src/x.test.ts`).

## 0.1.0

Initial extraction from reactive-agents-ts (see docs/ORIGIN.md).

- Claude Code plugin: dispatch gate, authority guard, report gate, outcome ledger (hooks)
- Skills: mission-brief, upward-report, dispatch, wardens
- Agents: debrief-scribe, evidence-warden
- Templates: domain, specialist
- Zero-dependency CLI: `warden new | route | doctor | stats | check`
