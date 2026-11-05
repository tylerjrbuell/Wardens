---
name: upward-report
description: Mandatory closing block for every warden response, and the input the parent routes on. Use when you are a warden finishing (or stopping) a mission, or when you are the parent reading a warden's result. The wardens SubagentStop hook sends the warden back once if the block is missing or invalid.
---

# UpwardReport — truth out

The warden owns the outcome, including a bad one. The report says what happened in a form the parent can route on without having to interpret it. Make it the **last content** of the response.

## Format

```yaml
upward-report:
  status: completed | failed | blocked | denied-by-authority | needs-approval
  confidence: 0.0-1.0
  files-changed:
    - <path>
  verification:                     # commands YOU ran this session, with their result
    - "<command> → <result>"
  evidence-anchors:                 # where the parent can check your claims
    - <file:line | test id | command output excerpt>
  blockers:                         # concrete: file:line, error string, missing dependency, out-of-scope path
    - <blocker>
  planned-actions:                  # needs-approval only: "I intend to …"
    - <action>
  escalation-required: false
  escalation-reason: <required when escalation-required is true>
  notes: <one line, optional>
```

## Status: pick exactly one

| Status | Meaning | Required |
|---|---|---|
| `completed` | End-state met, inside authority | `evidence-anchors`; `verification` if confidence ≥ floor (0.7) |
| `failed` | Tried, end-state not met, and you know why | `blockers` |
| `blocked` | Something outside any warden's reach: credentials, broken infra, a decision only a human can make | `blockers` |
| `denied-by-authority` | The work needs a path or command outside your authority (or the guard denied one) | `blockers` naming the path/command |
| `needs-approval` | You have a plan, and part of it is high-impact (delete, cross-caller rename, schema/API change). You stopped before doing it | `planned-actions` |

## Confidence is tied to evidence

| Confidence | Means |
|---|---|
| ≥ 0.9 | Every success criterion verified by a command you ran; no known open edge |
| 0.7 – 0.9 | Verified, but there's a known untested edge or the mechanism is new |
| 0.4 – 0.7 | Partially verified |
| < 0.4 | Not verified |

The hook rejects confidence ≥ 0.7 with an empty `verification`. If you don't have the evidence, don't claim the confidence.

## Rules for the warden

- **Own it.** No "the model was flaky" or "pre-existing issue" without an anchor that proves it, such as a stash-and-rerun baseline.
- **Don't work around the guard.** A denied tool call means your report is `denied-by-authority`. Don't try another route to the same edit.
- **Don't commit, push, tag, or publish.** Integration belongs to the parent, and the guard blocks those commands.
- **Report surprises in `notes`.** They feed the debrief.

## For the parent

Route the report with the **dispatch** skill's FSM. Never answer a report by asking the same warden to "double-check its work". That self-review loop costs tokens and adds no signal. Re-run the deterministic gates yourself.

Validate by hand: `warden check report < response.md`.
