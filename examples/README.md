# Examples

Ready-to-copy warden definitions and configs. Copy an agent into your repo's `.claude/agents/`, adjust its globs and commands to your layout, and rewrite the domain primer with *your* invariants and incidents. The primers here only show the shape. `warden doctor` checks the result.

Every example is tested in `tests/examples.test.mjs`: each one must pass `doctor`, and its guard must allow and deny what its text claims.

## Wardens

| Example | Kind | Shows |
|---|---|---|
| [`api-warden`](agents/api-warden.md) | domain | A typical service owner: one directory, test/lint/type commands, and a public-contract invariant that triggers `needs-approval` |
| [`web-warden`](agents/web-warden.md) | domain | **Partial ownership**: owns `src/` and `tests/` but *not* `package.json`/build config, so dependency churn stays with the parent. Routes generated-code fixes to another warden |
| [`migrations-warden`](agents/migrations-warden.md) | domain | **Tightest box**: `Write` but no `Edit` (new migrations only), a narrow glob, and every destructive change gated behind `needs-approval` |
| [`infra-warden`](agents/infra-warden.md) | domain | **Allowlist as safety rail**: may `fmt`/`validate`/`plan`; `terraform apply` isn't listed, so the guard denies it |
| [`docs-warden`](agents/docs-warden.md) | domain | **Time-boxed pilot**: `expires` makes `doctor` fail once the date passes, until you ratify or delete it |
| [`security-reviewer`](agents/security-reviewer.md) | specialist | **Finds, doesn't fix**: writes only review reports; each finding names its owning warden for the parent to dispatch |
| [`release-gate`](agents/release-gate.md) | specialist | **Audits, doesn't ship**: runs the release gates and returns `needs-approval` with the exact tag commands for a human |

Plus the two bundled with the plugin: [`debrief-scribe`](../agents/debrief-scribe.md) and [`evidence-warden`](../agents/evidence-warden.md).

## Configs (`.wardens/config.json`)

| Example | Use when |
|---|---|
| [`01-trial-warn-mode.json`](configs/01-trial-warn-mode.json) | **Week one.** Record would-be denials without blocking, then size authorities from `warden stats` |
| [`02-strict.json`](configs/02-strict.json) | Mature team: `enforce`, a higher confidence floor, and a longer `neverCommands` list (`terraform apply`, `kubectl delete`, `rm -rf`) that applies to every warden whatever its allowlist says |
| [`03-ownership-map.json`](configs/03-ownership-map.json) + [`ownership.example.json`](configs/ownership.example.json) | You already map paths → owners. Point `ownershipFile` at it instead of duplicating globs in frontmatter. `null` owners mean "the parent owns it" |
| [`04-retarget-bundled.json`](configs/04-retarget-bundled.json) | Repoint the bundled agents' output dirs, override one warden's commands (e.g. npm → pnpm) without editing its file, and load agents from an extra directory |

## Patterns worth copying

- **Narrow beats broad.** Give a warden the smallest glob that covers its job. If `warden stats` shows frequent guard denials on one adjacent path, widen deliberately.
- **Leave risky commands off the allowlist.** `apply`, `publish`, `delete`, `migrate up` against a shared DB: if a human should run it, don't list it. `neverCommands` covers the ones no warden should ever run.
- **Turn "ask first" into a status.** Write the high-impact cases into the primer as explicit `needs-approval` triggers, as in migrations-warden and infra-warden.
- **Specialists route, domain wardens fix.** Reviewers and gates write only their own reports and name the owner for each finding.
- **Pilot new wardens with `expires`.** Ratify from data or delete. Don't let them accumulate.
