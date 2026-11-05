# Examples

A complete, tested team: [`wardens.yaml`](wardens.yaml) declares all of it, and [`agents/`](agents/) holds each warden's prompt. To adopt one, copy its entry from `wardens.yaml` into your `.claude/wardens.yaml` and its agent file into `.claude/agents/`. Adjust the globs and commands to your layout, and rewrite the domain primer with *your* invariants and incidents. The primers here only show the shape. `warden doctor` checks the result.

Every example is tested in `tests/examples.test.mjs`: the team must pass `doctor`, and the guard must allow and deny what each file's text claims.

## Wardens

| Example | Kind | Shows |
|---|---|---|
| [`api-warden`](agents/api-warden.md) | domain | A typical service owner: one directory, test/lint/type commands, and a public-contract invariant that triggers `needs-approval` |
| [`web-warden`](agents/web-warden.md) | domain | **Partial ownership**: owns `src/` and `tests/` but *not* `package.json`/build config, so dependency churn stays with the parent. Routes generated-code fixes to another warden |
| [`migrations-warden`](agents/migrations-warden.md) | domain | **Tightest box**: its agent has `Write` but no `Edit` (new migrations only), a narrow glob, and every destructive change gated behind `needs-approval` |
| [`infra-warden`](agents/infra-warden.md) | domain | **Never-run as a safety rail**: may `fmt`/`validate`/`plan`; `terraform apply` is in the team-wide `never-run`, so no warden can run it |
| [`docs-warden`](agents/docs-warden.md) | domain | **Time-boxed pilot**: `expires` makes `doctor` fail once the date passes, until you ratify or delete it |
| [`security-reviewer`](agents/security-reviewer.md) | specialist | **Finds, doesn't fix**: writes only review reports; each finding names its owning warden for the parent to dispatch |
| [`release-gate`](agents/release-gate.md) | specialist | **Audits, doesn't ship**: runs the release gates and returns `needs-approval` with the exact tag commands for a human |

`wardens.yaml` also retargets the two bundled agents, [`debrief-scribe`](../agents/debrief-scribe.md) and [`evidence-warden`](../agents/evidence-warden.md), by overriding just their `owns`.

## Variants

Each is a complete `.claude/wardens.yaml`:

| Variant | Use when |
|---|---|
| [`trial-warn-mode.yaml`](variants/trial-warn-mode.yaml) | **Week one.** Record would-be denials without blocking, then size authorities from `warden stats` |
| [`strict.yaml`](variants/strict.yaml) | A mature team: `enforce`, a higher confidence floor, a longer `never-run` (`terraform apply`, `kubectl delete`, `rm -rf`) that applies to every warden, and `run: ["*"]` for a warden trusted with anything else |
| [`ownership-map.yaml`](variants/ownership-map.yaml) + [`configs/ownership.example.json`](configs/ownership.example.json) | You already map paths → owners. Point `ownership-file` at it instead of duplicating globs. `null` owners mean "the parent owns it" |

## Patterns worth copying

- **Narrow beats broad.** Give a warden the smallest glob that covers its job. If `warden stats` shows frequent guard denials on one adjacent path, widen deliberately.
- **Leave risky commands off `run`; put the dangerous ones in `never-run`.** If a human should run it (`apply`, `publish`, `delete`, `migrate up` against a shared DB), don't list it. If no warden should ever run it, add it to `never-run`, which overrides every warden's `run`.
- **Turn "ask first" into a status.** Write the high-impact cases into the primer as explicit `needs-approval` triggers, as in migrations-warden and infra-warden.
- **Specialists route, domain wardens fix.** Reviewers and gates write only their own reports and name the owner for each finding.
- **Pilot new wardens with `expires`.** Ratify from data or delete. Don't let them accumulate.
