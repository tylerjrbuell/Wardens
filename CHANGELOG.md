# Changelog

## 0.3.0 — unreleased

**Breaking: the whole team now lives in one file, `.claude/wardens.yaml`.** Run `warden migrate` to convert a v0.2 setup.

- `.claude/wardens.yaml` replaces per-agent `warden:` frontmatter blocks and `.wardens/config.json`. Keys: `mode`, `confidence-floor`, `never-run`/`always-run` (added to the built-ins instead of replacing them), `ownership-file`, `ledger`, `agent-dirs`, and `wardens.<name>.{kind, owns, run, expires}`. Agent files hold only the prompt. `.wardens/` holds only runtime state and is gitignored, so the rule is: commit `.claude/`, ignore `.wardens/`.
- `schema/wardens.schema.json` for editor autocomplete and validation (the `yaml-language-server` comment that `init` writes).
- Validation with did-you-mean for typos (`own` → `owns`, `mood` → `mode`). One bad key never disables the rest of the guard.
- New commands: `warden init` (commented starter file, gitignores `.wardens/`), `warden team` (the roster with owned globs, allowed commands, missions and first-pass rate), `warden migrate [--dry-run]`.
- `warden new` now appends to `wardens.yaml`, takes `--owns`/`--run`, and **promotes an existing agent** (keeps its file) as well as scaffolding new ones.
- The bundled agents' defaults are built into the CLI, which stays a single self-contained file that CI can fetch on its own. They can be overridden per key from `wardens.yaml`. Their default output dirs move from `.wardens/` to `docs/debriefs/` and `docs/evidence/`.
- `doctor` adds: declared wardens with no agent file, agents that look like wardens but aren't declared, and leftover v0.2 config.
- Examples: one complete `examples/wardens.yaml` plus `examples/variants/` (trial, strict, ownership map) replace `examples/configs/*.json`.
- Fix: a quoted YAML value followed by a `# comment` kept the comment in the value.
- Built-in `never-run` now also covers `git stash`, `git clean`, `git checkout --` and `git restore`: parallel wardens share one working tree, and each of these takes or destroys another agent's uncommitted work. The examples no longer recommend stash-and-rerun baselines.

## 0.2.0

- `examples/`: 7 tested warden definitions (api, web, migrations, infra, docs pilot, security reviewer, release gate) and 4 config variants (warn-mode trial, strict, ownership map, retarget bundled agents). `tests/examples.test.mjs` checks that each passes `doctor` and that the guard allows and denies what its text claims.
- Fix: `doctor` no longer prints git's "not a git repository" stderr when run outside a repo.
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
