---
name: dispatch
description: Parent-thread playbook for working with wardens — route work to the owning warden, dispatch with a MissionBrief, act on the UpwardReport with a deterministic state machine, verify, and integrate. Use whenever an edit falls inside a warden's authority, or when a warden returns.
---

# Dispatch — the parent's side of the contract

You're the commander. Wardens own their domains; you own the mission as a whole. That covers routing, verifying, integrating, and escalating.

## 1. Route

```bash
node <plugin>/bin/warden.mjs route <path> [<path>...]
```

- **One owner:** dispatch that warden.
- **Several paths with different owners:** split the mission, one brief per warden. Dispatch independent ones in parallel.
- **UNOWNED:** you do it directly. If the same unowned area keeps coming up, scaffold a warden (`warden new`).
- **Ambiguous (two owners):** fix the overlap first (`warden doctor` flags it). Ambiguous ownership is how nobody ends up owning anything.

## 2. Dispatch

Write the brief with the **mission-brief** skill and put it at the top of the Agent prompt. The dispatch hook denies invalid briefs and records valid ones in the ledger.

## 3. Act on the UpwardReport (deterministic — no extra LLM review)

| Report | Your action |
|---|---|
| `completed`, confidence ≥ 0.7 | **Verify:** re-run the brief's success criteria yourself, and check that `git diff --name-only` is inside the brief's paths. Pass → integrate. |
| `completed`, confidence < 0.7 | Verify as above. If the change adds a mechanism or a default-on behavior, send it to `evidence-warden` before you integrate. Otherwise accept with the low confidence disclosed. **Never** re-prompt the warden for self-review. |
| `failed`, retries remain | Re-dispatch the same mission: `attempt + 1`, the report's `blockers` copied into `prior-blockers`, and `key-tasks` adjusted. |
| `failed`, retries exhausted, or `escalation-required` | Escalate to the user with the blockers. Don't retry silently. |
| `denied-by-authority` | Run `warden route` on the blocked path. Owner exists → dispatch that owner with the out-of-scope part. No owner → escalate. Widening a warden's authority is the user's decision. |
| `blocked` | Show the blocker to the user. Don't re-dispatch. |
| `needs-approval` | Put `planned-actions` in front of the user. If approved, re-dispatch with them under `approved-actions`. |
| Malformed (hook already sent it back once) | Treat it as `failed` with confidence 0. Verify everything yourself. |

## 4. Integrate

Wardens don't commit. You do: one concern per commit, with the warden's `evidence-anchors` in the message body. If a mission produced two concerns, make two commits.

## 5. Close the loop

- After a non-trivial mission, or any surprise, dispatch `debrief-scribe` with the report and the commit sha.
- Check the team's numbers now and then: `warden stats`. A warden with a low first-pass rate, frequent guard denials, or many `denied-by-authority` reports has a badly sized authority or a stale primer. Fix the definition, not the symptom.
- Run `warden doctor` in CI so stale anchors, overlaps, and expired pilots fail the build instead of sitting unnoticed.

## Anti-patterns

- ❌ Asking a warden to review its own work. It recreates a verify-retry loop with no new signal.
- ❌ Re-dispatching past `retries-allowed`. The hook blocks it; don't work around it with a new `task` slug.
- ❌ Widening authority in the brief. The hook blocks it. Edit the warden definition, and only with user sign-off.
- ❌ Adding a new warden without evidence that the team needs it. Grow the roster from `stats` and `route` misses, not by intuition.
- ❌ Specialists (evidence, release, probe roles) editing source. They surface findings, and domain wardens fix them.
