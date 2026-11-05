---
name: wardens
description: Set up and maintain a warden team — the one-file config (.claude/wardens.yaml), adding or promoting wardens, checking who owns a path, linting the team (typos, overlaps, stale primer anchors, expired pilots), reading outcome metrics, and migrating from v0.2. Use when adopting wardens in a repo, adding or resizing a warden, or reviewing whether the team is earning its keep.
---

# Wardens — admin

The CLI is `bin/warden.mjs` at the plugin root, two directories above this skill's base directory. It's one file with no dependencies and needs Node 18+. Below, `warden` means `node <plugin-root>/bin/warden.mjs`.

## Where things live

| Path | Holds | Git |
|---|---|---|
| `.claude/wardens.yaml` | **The team**: every warden's `kind`, `owns`, `run`, `expires`, plus team settings | commit |
| `.claude/agents/<name>.md` | Each warden's prompt: name, description, tools, and its domain primer | commit |
| `.wardens/` | Runtime state: the outcome ledger | gitignored |

Authority (what the hooks enforce) is only ever in `wardens.yaml`. Agent files hold prose for the model.

## Commands

| Command | Use |
|---|---|
| `warden init [--mode warn\|enforce]` | Create a commented `.claude/wardens.yaml` (default `warn`) and gitignore `.wardens/` |
| `warden new <name> --owns "<glob>" [--owns …] [--run "<cmd>" …] [--kind domain\|specialist]` | Append a warden to `wardens.yaml`. Creates `.claude/agents/<name>.md` from a template, or **keeps an existing agent file**, so promoting a subagent you already have is one command |
| `warden team [--json]` | The roster: kind, owned globs, number of allowed commands, missions and first-pass rate from the ledger, agent file |
| `warden route <path…>` | Who owns a path. Exits 1 for unowned or ambiguous paths |
| `warden doctor [--strict]` | Lint the team: unknown keys (with did-you-mean), bad values, declared wardens without agent files, agents that look like wardens but aren't declared, owned-path overlaps, expired pilots, stale primer anchors. Exits 1 on errors (or warnings with `--strict`). Put it in CI |
| `warden stats [--json]` | Per-warden dispatches, first-pass completion, retries, rejected briefs, guard denials, malformed reports, mean confidence |
| `warden check brief --warden <name> < file` / `warden check report < file` | Validate a contract block by hand |
| `warden migrate [--dry-run]` | v0.2 → v0.3: fold `warden:` frontmatter blocks and `.wardens/config.json` into `wardens.yaml` |

## `.claude/wardens.yaml`

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/tylerjrbuell/wardens/main/schema/wardens.schema.json
version: 1
mode: warn                      # enforce | warn
# confidence-floor: 0.7         # reports at/above this need `verification`
# ownership-file: tools/ownership.json   # read owned globs from an existing [{glob, owner}] map
never-run:                      # added to the built-ins (git commit/push/tag/rebase/reset --hard, *publish)
  - terraform apply
# always-run: []                # added to the built-in read-only commands
# ledger: .wardens/ledger.jsonl
# agent-dirs: [.claude/agents]

wardens:                        # keep this section last so `warden new` can append to it
  payments-warden:
    kind: domain                # domain: owns code | specialist: writes only its own reports
    owns:
      - services/payments/**
    run:                        # prefix-matched per shell segment; omit to guard only never-run; ["*"] = anything not in never-run
      - npm test -- services/payments
    expires: 2027-01-31         # optional pilot window
  debrief-scribe:               # bundled agents: override only the keys you need
    owns:
      - docs/debriefs/**
```

- **Bundled agents** (`debrief-scribe`, `evidence-warden`) are wardens out of the box, with defaults built into the CLI (`debrief-scribe` owns `docs/debriefs/**`, `evidence-warden` owns `docs/evidence/**`). Declaring them here overrides key by key.
- **`ownership-file`** keeps an existing path → owner map as the single source: a warden's authority is its `owns` plus every glob the map assigns to it, and `owner: null` rows stay unowned.
- **Problems don't disable the guard.** An invalid key is reported by `doctor`, and the rest of the file still loads.

## Adopting in a repo

1. Install the plugin (see README) and run `warden init`. You start in `warn` mode: the hooks record what they would deny, and block nothing.
2. Map ownership. Pick the 2–4 areas where mistakes are costly and the context isn't obvious: invariants, past incidents, quirks. Don't give a warden a directory that the main thread handles fine on its own.
3. `warden new` for each, or copy the closest tested example from `examples/` at the plugin root. Write each **domain primer** with things that are true but not obvious from the code: invariants, failure history with anchors, and "never X because Y". Keep it under ~80 lines. `doctor` checks anchors (`path/file.ts:123`), so a stale primer fails CI instead of quietly misleading the warden.
4. Commit `.claude/wardens.yaml` and `.claude/agents/`. Add `warden doctor` to CI.
5. After a week, read `warden team` and `warden stats`, resize `owns`/`run` where the guard denied legitimate work, then set `mode: enforce`.

## Reading the numbers

| Signal | Likely cause | Fix |
|---|---|---|
| Low first-pass rate | Vague briefs, or a stale primer | Tighten success criteria; run `doctor` |
| Many guard denials | Authority too narrow, or warden drifting | Look at the denied paths in the ledger. Widen in `wardens.yaml` (with user sign-off) or sharpen out-of-scope |
| Many rejected dispatches | Parent skipping the brief, or briefs widening authority | Use the mission-brief skill; split cross-owner missions |
| Mean confidence high but verification often fails | Confidence not tied to evidence | Re-read the upward-report rubric |
| `missions: 0` for weeks in `warden team` | Doesn't earn its slot | Remove it from `wardens.yaml`. A smaller roster is better |
