# Wardens

**Extreme-ownership agent teams for Claude Code.** Give each risky area of your codebase a bounded subagent, a *warden*, that owns changes there end to end. Wardens receive intent through a **MissionBrief**, report results through an **UpwardReport**, and hooks enforce their authority. Prompts alone don't.

```
parent ──MissionBrief──▶ warden ──(guarded tools)──▶ code
   ▲                                     │
   └──────────── UpwardReport ◀──────────┘
          deterministic FSM: verify · retry · re-route · escalate
```

Wardens came out of [reactive-agents-ts](https://github.com/tylerjrbuell/reactive-agents-ts), where ten of them ran for five months. This pack generalizes them and fixes what that run exposed. [docs/ORIGIN.md](docs/ORIGIN.md) has the evidence.

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

```bash
/plugin marketplace add tylerjrbuell/wardens
/plugin install wardens@wardens
```

The plugin ships three things. The hooks do nothing unless an agent declares a `warden:` block.

- **Hooks:** dispatch gate, authority guard, report gate, and ledger.
- **Skills:** `mission-brief`, `upward-report`, `dispatch` (the parent playbook), and `wardens` (admin).
- **Agents:** `debrief-scribe` and `evidence-warden`. Both are generic, and you can repoint their output directories in config.

Requires Node ≥ 18. The CLI has no dependencies.

## Quick start

```bash
W="node ~/.claude/plugins/…/wardens/bin/warden.mjs"   # or: npx github:tylerjrbuell/wardens
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
  edit: [services/payments/**] # enforced
  bash:                        # optional allowlist, prefix-matched per command segment
    - npm test -- services/payments
  expires: 2027-01-31          # optional pilot window; doctor fails once it has passed
---
# payments-warden
## Domain primer
Invariants and failure history the code does not make obvious, anchored as `path:line`.
```

## What is and isn't enforced

Hooks give you guardrails. They don't make a security boundary.

- **Enforced:** Edit/Write/MultiEdit/NotebookEdit paths; Bash never-commands, the optional allowlist, output redirects, and command substitution; brief validity, authority narrowing, and retry budget; report shape and the confidence-versus-verification rule.
- **Not enforced:** what a Bash command does inside an allowed prefix. An allowlisted `node script.js` can still write anywhere. Reads aren't restricted. The parent thread is never guarded, because it owns integration.
- **Fail-open:** if the hook script itself crashes, the tool call goes ahead and the ledger records a `hook-error`. A broken guard should never lock up a session.
- **Trial runs:** `"mode": "warn"` in `.wardens/config.json` logs would-be denials without blocking. Run it that way for a week to size authorities from real data.

## Configuration

See the [`wardens` skill](skills/wardens/SKILL.md). Everything lives in the optional `.wardens/config.json`: mode, ledger path, agent dirs, confidence floor, never/always command lists, and per-warden authority overrides.

## Designing a team

- **Start with 2–4 wardens**, in the areas where mistakes are expensive and the context isn't obvious. Unowned code stays with the main thread, and that's fine.
- **Grow from data.** Add a warden when `warden route` keeps returning UNOWNED for one hot area, or when one warden's stats show it's doing two jobs. Delete wardens that rarely get dispatched.
- **Primers hold non-obvious truth only**: invariants, incidents, "never X because Y". Anchor everything, and let `doctor` keep the anchors honest.
- **Specialists don't patch.** Evidence, release, and probe roles find problems and name the owning warden. Domain wardens make the fix.

## License

MIT
