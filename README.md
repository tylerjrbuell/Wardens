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

This is real hook output for [`api-warden`](examples/agents/api-warden.md), which owns `services/api/**`:

```text
▸ parent dispatches with a bare task string
MissionBrief rejected for api-warden:
- no `mission-brief:` block found in the dispatch prompt

▸ parent tries to widen the warden's authority in the brief
MissionBrief rejected for api-warden:
- authority-bounds.paths `services/**` widens api-warden's authority [services/api/**]
  — a brief may only narrow it; route to the owning warden

▸ warden drifts into another team's code
denied-by-authority (api-warden): Edit apps/web/src/App.tsx is outside edit
authority [services/api/**]. Do not work around this.

▸ warden runs something off its allowlist
denied-by-authority (api-warden): `pip install requests` is not in this
warden's bash allowlist.

▸ warden tries to ship its own work
denied-by-authority (api-warden): `git commit` is reserved for the parent
(wardens never integrate or release).

▸ warden claims victory without evidence
Your UpwardReport is invalid:
- confidence ≥ 0.7 requires `verification` (commands you ran + result)
```

Wardens came out of [reactive-agents-ts](https://github.com/tylerjrbuell/reactive-agents-ts), where ten of them handled **166 logged missions** between May and November 2026. This pack generalizes the system and fixes what that run exposed: authority that existed only in prose, a lift evaluation that never ran, and primers that went stale. [docs/ORIGIN.md](docs/ORIGIN.md) has the evidence.

> **Status: v0.3, alpha.** The contracts, CLI and hook logic are covered by tests. The hook payload fields come from the Claude Code hooks documentation, and their first live run is happening in reactive-agents-ts in `warn` mode. Expect sharp edges, and please report them.

## Why

Plain subagents are a work crew: you give them a task string, they edit whatever they like, and you get prose back. Wardens make that crew a team:

| Doctrine | Mechanism | Enforced by |
|---|---|---|
| Commander's intent | MissionBrief: end-state, why, key tasks, bounds, success criteria | Dispatch hook rejects missing, vague, or over-budget briefs |
| Decentralized command | Each warden owns a set of globs, and a brief can only narrow it | Guard hook denies edits and redirects outside them, plus `never-run` commands |
| Report truth upward | Typed status, with confidence tied to verification | Stop hook sends a warden back once if its report is missing or invalid |
| Own the outcome | Deterministic parent FSM; no "review your own work" loops | `dispatch` skill |
| After-action review | `debrief-scribe` turns missions into playbook changes | — |
| Check the ego | `evidence-warden` vetoes "it's better" claims that lack a pre-stated A/B rule | — |
| Measure, don't assume | Ledger of dispatches, reports, and denials | `warden stats`, `warden team` |
| Keep the primer true | Primer anchors (`path:line`) are checked against the repo | `warden doctor` in CI |

## The whole team in one file

```
.claude/
  wardens.yaml        ← the team: who owns what, what each may run, team-wide rules   (commit)
  agents/
    api-warden.md     ← each warden's prompt: its domain primer                       (commit)
.wardens/
  ledger.jsonl        ← what actually happened: dispatches, reports, denials          (gitignored)
```

**Commit `.claude/`; ignore `.wardens/`.** Authority (machine-enforced) lives in `wardens.yaml`. Knowledge (prose for the model) lives in the agent files. One diff shows every change to who may do what, and `warden doctor` flags overlaps in that one place.

```yaml
# .claude/wardens.yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/tylerjrbuell/wardens/main/schema/wardens.schema.json
version: 1

mode: enforce          # start new teams with `warn` for a week, then switch

never-run:             # on top of the built-ins (git commit/push/tag/rebase, git stash/clean/reset --hard/restore, *publish)
  - terraform apply
  - terraform destroy
  - kubectl delete

wardens:
  api-warden:
    kind: domain
    owns:
      - services/api/**
    run:
      - pytest services/api
      - ruff check services/api
      - ruff format services/api
      - mypy services/api
```

That excerpt is from [`examples/wardens.yaml`](examples/wardens.yaml), a full nine-warden team. The schema comment on the second line gives you autocomplete and inline validation in any editor running the YAML language server.

| Key | What it does |
|---|---|
| `mode` | `enforce` denies out-of-authority tool calls and invalid briefs/reports. `warn` records them in the ledger without blocking. Default: `enforce`; `warden init` starts you in `warn` |
| `confidence-floor` | A report claiming at least this confidence must list `verification`. Default `0.7` |
| `never-run` | Commands no warden may run, whatever its own `run` says. Adds to the built-ins |
| `always-run` | Read-only commands every warden may run. Adds to the built-ins (`ls`, `cat`, `grep`, `git diff/log/show`...) |
| `ownership-file` | Read owned globs from an existing `[{glob, owner}]` map instead of listing them here ([example](examples/variants/ownership-map.yaml)) |
| `ledger`, `agent-dirs` | Where the ledger goes (default `.wardens/ledger.jsonl`) and where agent files live (default `.claude/agents`) |
| `wardens.<name>.kind` | `domain` owns code and fixes it. `specialist` writes only its own reports and routes findings to owners |
| `wardens.<name>.owns` | Globs the warden may edit. Enforced on Edit/Write and on shell redirects. Quote globs that start with `*` |
| `wardens.<name>.run` | Commands it may run, prefix-matched per shell segment. Omit it to guard only `never-run`; use `["*"]` for anything not in `never-run` |
| `wardens.<name>.expires` | A pilot window. `warden doctor` fails after the date until you ratify the warden (delete the line) or remove it |

Typos don't fail silently. Each problem is reported and the rest of the file still loads:

```text
$ warden doctor
✗ [.claude/wardens.yaml] `wardens.api-warden`: unknown key `own` — did you mean `owns`?
```

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

The plugin ships:

- **Hooks:** dispatch gate, authority guard, report gate, and ledger. They act only on agents declared in `wardens.yaml`, so your other subagents are untouched.
- **Skills:** `mission-brief`, `upward-report`, `dispatch` (the parent playbook), and `wardens` (admin).
- **Agents:** `debrief-scribe` and `evidence-warden`, with defaults you can override in `wardens.yaml`.
- **The `warden` CLI:** `bin/warden.mjs`, one file with no dependencies. It needs Node 18+.

## Quick start

```bash
alias warden="node /path/to/wardens/bin/warden.mjs"   # the plugin's directory, or a clone of this repo
```

```text
$ warden init
created .claude/wardens.yaml (mode: warn)
added .wardens/ to .gitignore

$ warden new api-warden --owns "services/api/**" --run "pytest services/api" --run "ruff check services/api"
added api-warden to .claude/wardens.yaml
created .claude/agents/api-warden.md: write its domain primer, then run `warden doctor`

$ warden team
.claude/wardens.yaml · mode: warn · confidence floor: 0.7

warden           kind        owns              run   missions  1st-pass  agent
debrief-scribe   specialist  docs/debriefs/**  3     0         —         plugin: agents/debrief-scribe.md
evidence-warden  specialist  docs/evidence/**  any   0         —         plugin: agents/evidence-warden.md
api-warden       domain      services/api/**   2     0         —         .claude/agents/api-warden.md

$ warden route services/api/app/routes/users.py scripts/deploy.sh
services/api/app/routes/users.py → api-warden
scripts/deploy.sh → UNOWNED (parent owns it, or scaffold a warden)
```

Write the primer in `.claude/agents/api-warden.md`: invariants, failure history, and "never X because Y", anchored as `path:line` so `warden doctor` catches the anchors that go stale. Or copy a tested one from [`examples/agents/`](examples/agents/). Then ask Claude for a change in `services/api/`. The `dispatch` skill routes it to the warden with a brief, and the hooks record what happens. After two missions (the first passed, the second failed once and passed on retry), with the rejected briefs and guard denials from the demo above included:

```text
$ warden stats
warden                disp  1st-pass  retry  rejected  guard-deny  malformed  avg-conf  outcomes
api-warden               3       50%      1         2           3          0      0.68  completed:2 failed:1
```

Already have a subagent you want to turn into a warden? `warden new <its-name> --owns ...` adds it to `wardens.yaml` and keeps its existing agent file.

## A mission, end to end

The parent opens the Agent prompt with a **MissionBrief**:

```yaml
mission-brief:
  task: users-pagination
  end-state: "GET /users paginates with limit/cursor; pytest services/api green."
  why: "Unbounded /users responses time out for large tenants (INC-118)."
  key-tasks:
    - Write a failing test for limit/cursor
    - Add pagination to the users route and service
  authority-bounds:
    paths:
      - services/api/**
  success-criteria:
    - "pytest services/api -> 0 failures"
  attempt: 1
  retries-allowed: 1
```

The warden ends its response with an **UpwardReport**. This one passes the stop hook and `warden check report`:

```yaml
upward-report:
  status: completed
  confidence: 0.9
  files-changed:
    - services/api/app/routes/users.py
    - services/api/tests/test_users.py
  verification:
    - "pytest services/api -> 212 passed"
    - "ruff check services/api -> clean"
  evidence-anchors:
    - services/api/app/routes/users.py:41
  escalation-required: false
```

The parent then follows the [`dispatch`](skills/dispatch/SKILL.md) FSM: it re-runs `pytest services/api` itself, checks that `git diff --name-only` stays inside `services/api/**`, and commits. Wardens never commit.

## Examples

[`examples/`](examples/) has a tested, complete team ([`wardens.yaml`](examples/wardens.yaml) plus seven agent files) and three variants:

| Warden | Pattern |
|---|---|
| [`api-warden`](examples/agents/api-warden.md) | A service owner, with a public-contract invariant that triggers `needs-approval` |
| [`web-warden`](examples/agents/web-warden.md) | Partial ownership: `src/` and `tests/`, not `package.json` |
| [`migrations-warden`](examples/agents/migrations-warden.md) | The tightest box: `Write` but no `Edit`; destructive changes need approval |
| [`infra-warden`](examples/agents/infra-warden.md) | May `terraform plan`, never `apply`, enforced by team-wide `never-run` |
| [`docs-warden`](examples/agents/docs-warden.md) | A time-boxed pilot with `expires` |
| [`security-reviewer`](examples/agents/security-reviewer.md) | A specialist that finds problems and routes each one to its owner |
| [`release-gate`](examples/agents/release-gate.md) | A specialist that audits a release and hands a human the tag commands |

| Variant | Use when |
|---|---|
| [`trial-warn-mode.yaml`](examples/variants/trial-warn-mode.yaml) | Week one: record, don't block |
| [`strict.yaml`](examples/variants/strict.yaml) | A mature team: higher confidence floor, longer `never-run` |
| [`ownership-map.yaml`](examples/variants/ownership-map.yaml) | You already keep a path → owner map |

Each example is tested: the team must pass `doctor`, and the guard must allow and deny what each file's text claims.

## Upgrading from v0.2

v0.2 kept authority in a `warden:` block in each agent's frontmatter, plus `.wardens/config.json`. One command folds both into `.claude/wardens.yaml`, removes the old blocks (the primers are untouched), and deletes the old config:

```text
$ warden migrate --dry-run     # print the wardens.yaml it would write
$ warden migrate
wrote .claude/wardens.yaml
moved authority out of .claude/agents/api-warden.md
deleted .wardens/config.json (folded into wardens.yaml)
```

Until you migrate, `warden doctor` fails and tells you to run it, and v0.2 blocks are not enforced.

## What is and isn't enforced

Hooks give you guardrails. They don't make a security boundary.

- **Enforced:** Edit/Write/MultiEdit/NotebookEdit paths; Bash `never-run`, the `run` allowlist, output redirects, and command substitution; brief validity, authority narrowing, and retry budget; report shape and the confidence-versus-verification rule.
- **Not enforced:** what a Bash command does inside an allowed prefix. An allowlisted `node script.js` can still write anywhere. Reads aren't restricted. The parent thread is never guarded, because it owns integration.
- **Fail-open:** if the hook script itself crashes, the tool call goes ahead and the ledger records a `hook-error`. A broken guard should never lock up a session.
- **Trial runs:** `mode: warn` logs would-be denials without blocking. Run it that way for a week, size authorities from `warden stats`, then switch to `enforce`.

## CI

Run `doctor` so typos, stale primers, ownership overlaps and expired pilots fail the build. Fetch the single CLI file pinned to a commit:

```bash
curl -fsSL "https://raw.githubusercontent.com/tylerjrbuell/wardens/<sha>/bin/warden.mjs" -o warden.mjs
node warden.mjs doctor --strict
```

(`npx github:tylerjrbuell/wardens` currently fails on an npm bug, `GitFetcher requires an Arborist constructor`.)

## Designing a team

- **Start with 2–4 wardens**, in the areas where mistakes are expensive and the context isn't obvious. Unowned code stays with the main thread, and that's fine.
- **Grow from data, prune from data.** Add a warden when `warden route` keeps returning UNOWNED for one hot area. Delete wardens that rarely get dispatched: in the origin repo, 3 of 10 wardens went five months without a single dispatch. `warden team` shows missions per warden next to its authority.
- **Pilot new wardens with `expires`.** Ratify from data or delete. Don't let them accumulate.
- **Primers hold non-obvious truth only**: invariants, incidents, "never X because Y". Anchor everything, and let `doctor` keep the anchors honest.
- **Specialists don't patch.** Evidence, release, and probe roles find problems and name the owning warden. Domain wardens make the fix.
- **Parallel wardens share one working tree.** That is why `git stash`, `git clean`, `git reset --hard`, `git checkout --` and `git restore` are built-in `never-run`: each silently takes or destroys someone else's uncommitted work. To prove a failure is pre-existing, run the check on the base branch in a separate worktree. To prove a test pins a fix, cut the fix in source, watch the test fail, and restore it.

## License

MIT
