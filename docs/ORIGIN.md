# Origin: what five months of wardens taught us

Wardens were piloted in [reactive-agents-ts](https://github.com/tylerjrbuell/reactive-agents-ts) from 2026-05-23 to 2026-06-15 and ratified as permanent on 2026-09-03. The roster had 10 agents: 6 domain wardens (kernel, provider, tools, memory, runtime, compose) and 4 specialists (harness, ablation, release, debrief-scribe). The MissionBrief/UpwardReport contract and the dispatcher FSM came from *Extreme Ownership* (Willink/Babin), *Turn the Ship Around!* (Marquet), and MCDP-1 commander's intent.

As of 2026-11-05, the pilot log on the project's `dev` branch has **166 entries**: May 17, June 8, September 13, October 128. Missions by warden:

| Warden | Missions |
|---|---|
| kernel-warden | 56 |
| runtime-warden | 51 |
| provider-warden | 18 |
| harness-warden | 12 |
| tools-warden | 9 |
| ablation-warden | 3 |
| release-warden | 1 |
| **memory-warden, compose-warden, debrief-scribe** | **0** |
| main thread / unowned (`none`, `main`, `controller-inline`) | 17 |

Recorded outcomes were overwhelmingly `completed` (100+), with one `denied-by-authority`, one `interrupted`, and a handful of free-text variants ("completed-with-caveats", "family", "all"). Two signals stand out. Nearly every self-reported outcome is a success, which says more about the reporting than about the work. And three wardens never got a mission at all.

On `dev`, the project also grew its own repo tooling alongside the wardens: an ownership manifest (`tools/repo/ownership.json`), a report validator with a next-action FSM, and manifest-expiry checks. That is independent confirmation that these pieces need to be mechanical. It's also why Wardens can read an existing ownership file (`ownershipFile`) instead of asking for a second copy.

## What worked (kept as-is)

- **Bounded authority plus a domain primer.** Wardens caught real regressions from their primers. One example: runtime-warden rejected a MissionBrief whose pseudocode contradicted a memory-gating policy.
- **MissionBrief → UpwardReport.** Status, confidence, blockers, and anchors gave the parent something to route on mechanically.
- **No self-review loops.** The FSM never re-prompts a warden to check its own work. This came from a project precedent: an LLM verify-retry loop measured no lift and was removed.
- **Parent integrates.** Wardens don't commit. The parent commits once per concern.

## What the record exposed, and what this pack changes

| # | Finding (evidence) | Change in this pack |
|---|---|---|
| 1 | **Authority was prose.** The agents had `Edit` and unrestricted `Bash`. Their "hard limits" were Markdown that nothing enforced. | Authority is declared in one file, `.claude/wardens.yaml` (`owns`, `run`), and a PreToolUse guard denies out-of-authority edits, redirects, and commit/push/tag/publish inside wardens. (v0.2 put it in each agent's frontmatter. Splitting the team across ten files plus a config hid overlaps and made "what do we commit?" a three-file answer, so v0.3 consolidated it.) |
| 2 | **The lift evaluation never ran.** The pilot's kill/lift criteria needed token and first-pass data. The measurement tool was removed before anyone collected it, and the ratification says plainly that it rests on "continued use", not evidence. | Hooks write every dispatch, report, rejection, and denial to `.wardens/ledger.jsonl`. `warden stats` computes first-pass rate, retries, denials, and confidence without anyone having to remember to measure. |
| 3 | **The log drifted.** Hand-written entries changed shape partway through (`routed/commits/agent-spawns` became `result/outcome/escalation`), so they couldn't be aggregated. | The ledger is written by machine. Free-text notes go to `debrief-scribe`. |
| 4 | **Primers rotted.** Checking the original 10 wardens found anchors to deleted or moved files: `packages/core/src/services/llm-service.ts`, `…/tool-service.ts`, `core/services/compose-bridge.ts` (the real path is `core/src/services/`), and a memory-warden invariant about `context-manager.ts`, which was deleted in July. Hook counts and line counts were stale too. | `warden doctor` resolves every backticked `path[:line]` anchor and flags the ones that miss. Lines that document a deliberate deletion ("removed — do not recreate") are treated as tombstones and skipped. |
| 5 | **Misrouting was found after the spawn.** One warden returned `denied-by-authority` only after it was spawned (prototype work outside its manifest). | The dispatch gate checks at dispatch time that the brief's paths sit inside the warden's authority, and `warden route` names the owner. |
| 6 | **`denied-by-authority` always escalated to the user**, but in practice the right move was to re-route to the warden that owns the path. | FSM: denied → `warden route` → dispatch the owner. Escalate only when nobody owns it. |
| 7 | **Retry budget relied on the honor system.** "Never silent retry" was prose, and the brief had no attempt counter. | `attempt` field. The gate denies dispatches past `1 + retries-allowed`. |
| 8 | **Confidence was self-reported with no rule.** The FSM routes on confidence, but nothing tied it to evidence. | `verification` field (commands run, with results). Confidence ≥ floor without verification is rejected. |
| 9 | **The contract contradicted itself.** One warden said "invalid brief → `denied-by-authority`" in its workflow and "→ `failed`" in its I/O section. The scribe required a commit sha that wardens never produce. Approval was a "preliminary report" convention rather than a status. | One status enum with defined meanings, `needs-approval` added as a real status, and `approved-actions` in the brief. |
| 10 | **The roster grew without its gate.** The plan said "start with one warden, expand on evidence". The roster reached 10 with no evaluation, and three of the ten never received a mission. | Guidance plus `stats`: grow from UNOWNED route misses and per-warden numbers, and delete wardens that rarely get dispatched. `warden team` shows missions per warden next to its authority. Pilot `expires` lives in `wardens.yaml`, and `doctor` fails once it has passed. This generalizes the original repo's `check-no-expired-pilots.sh`. |
| 12 | **Parallel agents clobbered each other's uncommitted work.** The repo banned `git stash` because its working tree is shared with concurrent agents. Wardens' own first examples had recommended stash-and-rerun baselines. | `git stash`, `git clean`, `git reset --hard`, `git checkout --` and `git restore` are built-in `never-run` for every warden. Baselines come from a separate worktree; "this test pins the fix" comes from cutting the fix in source and restoring it. |
| 11 | **Unowned work was ambiguous.** Log entries said `warden: none` or `routed: main` without a rule. | Explicit: unowned paths belong to the parent, and repeated misses justify a new warden. |

## What stayed project-specific (not in the pack)

Model-tier sets, ablation thresholds, release pipelines, and probe tooling are project-specific. The pack ships `evidence-warden` with a generic pre-stated-rule A/B, plus a specialist template for release and probe roles.

## Known limits

- The guard works on paths and command prefixes. It's a guardrail against drift, not a sandbox.
- Pairing dispatches with reports in `stats` is FIFO per session and warden, so parallel dispatches of the same warden in one session can mispair.
- Anchor checks need a `/` in the path. A bare `file.ts:12` isn't checked, so write anchors repo-relative.
