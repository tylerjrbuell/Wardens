---
name: wardens
description: Set up and maintain a warden team — scaffold a new domain warden, check ownership of a path, lint warden definitions (overlaps, stale primer anchors, expired pilots, prose-only authority), and read outcome metrics from the ledger. Use when adopting wardens in a repo, adding or resizing a warden, or reviewing whether the team is earning its keep.
---

# Wardens — admin

The CLI is `bin/warden.mjs` at the plugin root, two directories above this skill's base directory. It has no dependencies; Node ≥ 18 is all it needs. Below, `warden` means `node <plugin-root>/bin/warden.mjs`.

| Command | Use |
|---|---|
| `warden new <name> --edit "<glob>" [--edit …] [--test "<cmd>"] [--kind domain\|specialist]` | Scaffold `.claude/agents/<name>.md` from the template. Then write its domain primer. |
| `warden route <path…>` | Who owns this path. Exits 1 for unowned or ambiguous paths. |
| `warden doctor [--strict] [--verbose]` | Lint every agent definition. Exits 1 on errors (or on warnings with `--strict`). Belongs in CI. |
| `warden stats [--json]` | Per-warden dispatches, first-pass completion, retries, rejected briefs, guard denials, malformed reports, and mean confidence. |
| `warden check brief --warden <name> < file` / `warden check report < file` | Validate a contract block by hand. |

## Adopting in a repo

1. Install the plugin (see README). The hooks act only on agents that declare a `warden:` frontmatter block, so nothing else is affected.
2. Map ownership. Pick the 2–4 areas where mistakes are costly and the context isn't obvious: invariants, past incidents, quirks. Don't give a warden a directory that the main thread handles fine on its own.
3. `warden new` for each. Write the **domain primer** with things that are true but not obvious from the code: invariants, failure history with anchors, and "never do X because Y". Keep it under ~80 lines. Anchors (`path/file.ts:123`) are checked by `doctor`, so a stale primer fails CI instead of quietly misleading the warden.
4. Optionally add `.wardens/config.json` (below), then commit `.claude/agents/` and the config. Add `.wardens/ledger.jsonl` to `.gitignore`, or commit it if you want team-wide stats.
5. Add `warden doctor` to CI.

## The `warden:` frontmatter block

```yaml
---
name: payments-warden
description: …
tools: Read, Edit, Write, Grep, Glob, Bash
warden:
  kind: domain              # domain (owns code) | specialist (owns an output dir, surfaces findings)
  edit:                     # enforced: Edit/Write/redirects outside these globs are denied
    - services/payments/**
  bash:                     # optional allowlist (prefix match per command segment); omit = only never-commands guarded
    - npm test -- services/payments
    - npx tsc -p services/payments
  expires: 2027-01-31       # optional pilot window; doctor fails after this date until you ratify or remove
---
```

## `.wardens/config.json` (all keys optional)

```json
{
  "mode": "enforce",
  "ledger": ".wardens/ledger.jsonl",
  "agentDirs": [".claude/agents"],
  "confidenceFloor": 0.7,
  "neverCommands": ["git commit", "git push", "git tag", "git rebase", "git reset --hard", "npm publish"],
  "alwaysCommands": ["ls", "cat", "grep", "rg", "git status", "git diff", "git log", "git show"],
  "authority": { "debrief-scribe": { "edit": ["docs/debriefs/**"] } }
}
```

- `mode: "warn"` records would-be denials in the ledger without blocking anything. Use it for the first week to size authorities from real data.
- `authority` overrides a warden's `edit`/`bash` without editing its file. Use it to point the bundled `debrief-scribe` and `evidence-warden` at your own directories.

## Reading `stats`

| Signal | Likely cause | Fix |
|---|---|---|
| Low first-pass rate | Vague briefs, or a stale primer | Tighten success criteria; run `doctor` |
| Many guard denials | Authority too narrow, or warden drifting | Look at the denied paths in the ledger. Widen (with user sign-off) or sharpen out-of-scope |
| Many rejected dispatches | Parent skipping the brief, or briefs widening authority | Use the mission-brief skill; split cross-owner missions |
| Mean confidence high but verification often fails | Confidence not tied to evidence | Re-read the upward-report rubric |
| A warden is rarely dispatched | Doesn't earn its slot | Delete it. A smaller roster is better. |
