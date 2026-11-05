<p align="center"><img src="assets/icon.png" width="120" alt="Wardens shield"></p>

<h1 align="center">Wardens</h1>

<p align="center"><b>Extreme-ownership agent teams for Claude Code.</b><br>
Bounded subagents that own a slice of your codebase, take a typed mission, stay inside their authority, and report the truth back.</p>

<p align="center">
<img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-e07a1f">
<img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-2ea44f">
<img alt="node 18+" src="https://img.shields.io/badge/node-18%2B-339933">
<img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

Subagents are powerful and unaccountable. You hand one a task string, it edits whatever it likes, maybe commits, and comes back with confident prose. **Wardens** turns them into a team with a chain of command:

- **Every warden owns specific paths**, and hooks *deny* tool calls outside them. This isn't a prompt asking nicely.
- **Every dispatch carries a MissionBrief**: end-state, why, bounds, success criteria, and retry budget. A vague or authority-widening brief never reaches the warden.
- **Every result is an UpwardReport** with a typed status, and confidence has to be backed by verification. "Done! 0.95 confident" with no evidence gets sent back.
- **Every mission is recorded**, so `warden stats` tells you which wardens earn their keep.

```
parent --MissionBrief--> warden --guarded tools--> code
  ^                        |
  +------ UpwardReport <---+
     deterministic FSM: verify / retry / re-route / escalate
```

## See it work

This is real hook output for a `payments-warden` that owns `services/payments/**`:

```text
▸ parent dispatches with a bare task string
MissionBrief rejected for payments-warden:
- no `mission-brief:` block found in the dispatch prompt

▸ warden drifts into another team's code
denied-by-authority (payments-warden): Edit services/auth/session.ts is outside
edit authority [services/payments/**]. Do not work around this.

▸ warden tries to ship its own work
denied-by-authority (payments-warden): `git commit` is reserved for the parent
(wardens never integrate or release).

▸ warden claims victory without evidence
Your UpwardReport is invalid:
- confidence ≥ 0.7 requires `verification` (commands you ran + result)
```

Wardens came out of [reactive-agents-ts](https://github.com/tylerjrbuell/reactive-agents-ts), where ten of them handled **166 logged missions** between May and November 2026. This pack generalizes the system and fixes what that run exposed: authority that existed only in prose, a lift evaluation that never ran, and primers that went stale. [docs/ORIGIN.md](docs/ORIGIN.md) has the evidence.

> **Status: v0.2, alpha.** The contracts, CLI and hook logic are covered by tests. The hook payload fields come from the Claude Code hooks documentation, and their first live run is happening in reactive-agents-ts in `warn` mode. Expect sharp edges, and please report them.

## Why

Plain subagents are a work crew: you give them a task string, they edit whatever they like, and you get prose back. Wardens make that crew a team:

| Doctrine | Mechanism | Enforced by |
|---|---|---|
| Commander's intent | MissionBrief: end-state, why, key tasks, bounds, success criteria | Dispatch hook rejects missing, vague, or over-budget briefs |
| Decentralized command | Each warden owns a set of globs, and a brief can only narrow it | Guard hook denies edits and redirects outside them, plus commit/push/tag/publish |
| Report truth upward | Typed status, with confidence tied to verification | Stop hook sends a warden back once if its report is missing or invalid |
| Own the outcome | Deterministic parent FSM; no "review your own work" loops | `dispatch` skill |
| After-action review | `debrief-scribe` turns missions into playbook changes | — |
| Check the ego | `evidence-warden` vetoes "it's better" claims that lack a pre-stated A/B rule | — |
| Measure, don't assume | Ledger of dispatches, reports, and denials | `warden stats` |
| Keep the primer true | Primer anchors (`path:line`) are checked against the repo | `warden doctor` in CI |

## Install

**For yourself:**

```bash
/plugin marketplace add tylerjrbuell/wardens
/plugin install wardens@wardens
```

**For everyone working in a repo:** commit this to `.claude/settings.json`. Claude Code prompts each contributor to trust the marketplace the first time.

```json
{
  "extraKnownMarketplaces": { "wardens": { "source": { "source": "github", "repo": "tylerjrbuell/wardens" } } },
  "enabledPlugins": { "wardens@wardens": true }
}
```

The plugin ships three things. The hooks do nothing unless an agent declares a `warden:` block, so they never touch your other subagents.

- **Hooks:** dispatch gate, authority guard, report gate, and ledger.
- **Skills:** `mission-brief`, `upward-report`, `dispatch` (the parent playbook), and `wardens` (admin).
- **Agents:** `debrief-scribe` and `evidence-warden`. Both are generic, and you can repoint their output directories in config.

Requires Node ≥ 18. The CLI is one file with no dependencies.

## Quick start

```bash
W="node ~/.claude/plugins/…/wardens/bin/warden.mjs"   # or any copy of bin/warden.mjs
$W new payments-warden --edit "services/payments/**" --test "npm test -- services/payments"
$EDITOR .claude/agents/payments-warden.md               # write the domain primer
$W doctor                                               # lint definitions
$W route services/payments/charge.ts                    # → payments-warden
```

Then ask Claude for a change in `services/payments/`. The `dispatch` skill routes the change to the warden with a brief. Later, `warden stats` shows whether the team is earning its keep:

```
warden                disp  1st-pass  retry  rejected  guard-deny  malformed  avg-conf  outcomes
payments-warden         12       83%      2         1           3          0      0.84  completed:11 failed:1
```

## A warden definition

```yaml
---
name: payments-warden
description: Bounded warden for services/payments/**. …
tools: Read, Edit, Write, Grep, Glob, Bash
warden:
  kind: domain                 # or specialist: writes only its own outputs, never product code
  edit: [services/payments/**] # enforced (or supplied by ownershipFile, below)
  bash:                        # optional allowlist, prefix-matched per command segment
    - npm test -- services/payments
  expires: 2027-01-31          # optional pilot window; doctor fails once it has passed
---
# payments-warden
## Domain primer
Invariants and failure history the code does not make obvious, anchored as `path:line`.
```

### Already have an ownership map?

Don't copy it into frontmatter, where it would drift. Point Wardens at it:

```json
// .wardens/config.json
{ "ownershipFile": "tools/ownership.json" }
```

The file can be `[{ "glob": "...", "owner": "..." }]` or `{ "entries": [...] }`. Rows with a `null` owner mean unowned. A warden's authority is its frontmatter `edit` plus every glob the file assigns to it. `doctor` warns when the file names an owner that has no warden definition.

## What is and isn't enforced

Hooks give you guardrails. They don't make a security boundary.

- **Enforced:** Edit/Write/MultiEdit/NotebookEdit paths; Bash never-commands, the optional allowlist, output redirects, and command substitution; brief validity, authority narrowing, and retry budget; report shape and the confidence-versus-verification rule.
- **Not enforced:** what a Bash command does inside an allowed prefix. An allowlisted `node script.js` can still write anywhere. Reads aren't restricted. The parent thread is never guarded, because it owns integration.
- **Fail-open:** if the hook script itself crashes, the tool call goes ahead and the ledger records a `hook-error`. A broken guard should never lock up a session.
- **Trial runs:** `"mode": "warn"` in `.wardens/config.json` logs would-be denials without blocking. Run it that way for a week to size authorities from real data, then switch to `"enforce"`.

## CI

Run `doctor` so stale primers, ownership overlaps and expired pilots fail the build. Fetch the single CLI file pinned to a commit:

```bash
curl -fsSL "https://raw.githubusercontent.com/tylerjrbuell/wardens/<sha>/bin/warden.mjs" -o warden.mjs
node warden.mjs doctor --strict
```

(`npx github:tylerjrbuell/wardens` currently fails on an npm bug, `GitFetcher requires an Arborist constructor`.)

## Configuration

Everything lives in the optional `.wardens/config.json`: mode, ledger path, agent dirs, ownership file, confidence floor, never/always command lists, and per-warden authority overrides. See the [`wardens` skill](skills/wardens/SKILL.md).

## Designing a team

- **Start with 2–4 wardens**, in the areas where mistakes are expensive and the context isn't obvious. Unowned code stays with the main thread, and that's fine.
- **Grow from data, prune from data.** Add a warden when `warden route` keeps returning UNOWNED for one hot area. Delete wardens that rarely get dispatched: in the origin repo, 3 of 10 wardens went five months without a single dispatch.
- **Primers hold non-obvious truth only**: invariants, incidents, "never X because Y". Anchor everything, and let `doctor` keep the anchors honest.
- **Specialists don't patch.** Evidence, release, and probe roles find problems and name the owning warden. Domain wardens make the fix.

## License

MIT
