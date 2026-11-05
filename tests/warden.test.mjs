import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseYaml, extractBlock, matchesAny, globWithin, globsOverlap, splitShell,
  validateBrief, validateReport, checkToolCall, computeStats, doctor, loadAgents,
} from "../bin/warden.mjs";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/warden.mjs");

const WARDEN = `---
name: pay-warden
description: test
tools: Read, Edit, Write, Bash
warden:
  kind: domain
  edit:
    - services/payments/**
  bash:
    - npm test
---
# pay-warden
Primer anchors: \`services/payments/charge.ts:2\` and \`services/payments/gone.ts\`.
Tombstone: \`services/payments/legacy.ts\` was removed — do not recreate.
<!-- \`path/to/file.ext:1\` inside a comment is ignored -->
`;

function fixture({ extraAgents = {}, config } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wardens-"));
  mkdirSync(join(root, ".claude/agents"), { recursive: true });
  mkdirSync(join(root, "services/payments"), { recursive: true });
  writeFileSync(join(root, "services/payments/charge.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".claude/agents/pay-warden.md"), WARDEN);
  for (const [n, body] of Object.entries(extraAgents)) writeFileSync(join(root, `.claude/agents/${n}.md`), body);
  if (config) { mkdirSync(join(root, ".wardens"), { recursive: true }); writeFileSync(join(root, ".wardens/config.json"), JSON.stringify(config)); }
  return root;
}

const runHook = (root, which, payload) => {
  const r = spawnSync("node", [BIN, "hook", which], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const ledger = (root) => existsSync(join(root, ".wardens/ledger.jsonl")) ? readFileSync(join(root, ".wardens/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

const BRIEF = `\`\`\`yaml
mission-brief:
  task: fix-rounding
  end-state: "Charges round half-even; payments suite green."
  why: "Half-up rounding drifted ledgers by a cent (INC-42)."
  key-tasks:
    - Write failing test
    - Fix rounding
  authority-bounds:
    paths:
      - services/payments/**
  success-criteria:
    - "npm test -- services/payments → 0 failures"
  attempt: 1
  retries-allowed: 1
\`\`\`
Go.`;

const REPORT = `Done.

upward-report:
  status: completed
  confidence: 0.9
  files-changed:
    - services/payments/charge.ts
  verification:
    - "npm test -- services/payments → 41 pass / 0 fail"
  evidence-anchors:
    - services/payments/charge.ts:12
  escalation-required: false
`;

// ── parsing ──
test("parseYaml handles maps, lists, flow lists, block + wrapped scalars", () => {
  const y = parseYaml("a: 1\nb:\n  - x\n  - 'y z'\nc:\n  d: [p, \"q r\"]\n  e: >\n    hello\n    world\nf: long\n  wrapped\ng:\n- top\nh: v # comment\n");
  assert.deepEqual(y, { a: 1, b: ["x", "y z"], c: { d: ["p", "q r"], e: "hello world" }, f: "long wrapped", g: ["top"], h: "v" });
});

test("extractBlock finds fenced and bare blocks, last occurrence by default", () => {
  assert.equal(extractBlock(BRIEF, "mission-brief", "first").task, "fix-rounding");
  const two = "upward-report:\n  status: failed\n\nlater\nupward-report:\n  status: completed\n";
  assert.equal(extractBlock(two, "upward-report").status, "completed");
  assert.equal(extractBlock("nothing here", "upward-report"), null);
});

// ── globs ──
test("glob matching, narrowing, overlap", () => {
  assert.ok(matchesAny(["services/payments/**"], "services/payments"));
  assert.ok(matchesAny(["services/payments/**"], "services/payments/a/b.ts"));
  assert.ok(!matchesAny(["services/payments/**"], "services/paymentsX/a.ts"));
  assert.ok(matchesAny(["src/*.{ts,js}"], "src/a.js"));
  assert.ok(!matchesAny(["src/*.ts"], "src/deep/a.ts"));
  assert.ok(globWithin("services/payments/src/**", ["services/payments/**"]));
  assert.ok(!globWithin("services/**", ["services/payments/**"]));
  assert.ok(globsOverlap("packages/reasoning/**", "packages/reasoning/src/kernel/**"));
  assert.ok(!globsOverlap("packages/memory/**", "packages/tools/**"));
});

test("splitShell splits on operators outside quotes, keeps redirections", () => {
  assert.deepEqual(splitShell('A=1 npm test && git commit -m "a; b" | head 2>&1; echo x > f &'), ["npm test", 'git commit -m "a; b"', "head 2>&1", "echo x > f"]);
});

// ── contracts ──
test("validateBrief accepts a good brief and rejects widening, vagueness, exhausted retries", () => {
  const w = { name: "pay-warden", edit: ["services/payments/**"] };
  assert.deepEqual(validateBrief(extractBlock(BRIEF, "mission-brief", "first"), w), []);
  const widen = validateBrief({ "end-state": "x", why: "y", "success-criteria": "z", "authority-bounds": { paths: ["services/**"] } }, w);
  assert.match(widen.join(), /widens pay-warden/);
  assert.match(validateBrief({ "end-state": "TBD", why: "y", "success-criteria": "z", "authority-bounds": { paths: ["services/payments/a.ts"] } }, w).join(), /vague/);
  assert.match(validateBrief({ "end-state": "x", why: "y", "success-criteria": "z", "authority-bounds": { paths: ["services/payments/a.ts"] }, attempt: 3, "retries-allowed": 1 }, w).join(), /retry budget exhausted/);
  assert.match(validateBrief(null).join(), /no `mission-brief:`/);
});

test("validateReport ties confidence to verification and status to required fields", () => {
  assert.deepEqual(validateReport(extractBlock(REPORT, "upward-report")), []);
  assert.match(validateReport({ status: "completed", confidence: 0.95, "evidence-anchors": ["a:1"] }).join(), /requires `verification`/);
  assert.deepEqual(validateReport({ status: "completed", confidence: 0.5, "evidence-anchors": ["a:1"] }), []);
  assert.match(validateReport({ status: "failed", confidence: 0.2 }).join(), /requires concrete `blockers`/);
  assert.match(validateReport({ status: "needs-approval", confidence: 0.8 }).join(), /planned-actions/);
  assert.match(validateReport({ status: "done", confidence: 2 }).join(), /status.*confidence/s);
  assert.match(validateReport({ status: "blocked", confidence: 0, blockers: ["x"], "escalation-required": true }).join(), /escalation-reason/);
});

// ── guard ──
test("checkToolCall enforces edit globs, never-commands, redirects, bash allowlist", () => {
  const root = "/repo";
  const cfg = { neverCommands: ["git commit", "npm publish"], alwaysCommands: ["ls", "git diff"] };
  const w = { name: "pay-warden", edit: ["services/payments/**"], bash: ["npm test"] };
  assert.equal(checkToolCall(w, "Edit", { file_path: "/repo/services/payments/a.ts" }, root, cfg), null);
  assert.match(checkToolCall(w, "Write", { file_path: "/repo/services/auth/a.ts" }, root, cfg), /outside edit authority/);
  assert.match(checkToolCall(w, "Edit", { file_path: "/etc/passwd" }, root, cfg), /outside the project/);
  assert.equal(checkToolCall(w, "Bash", { command: "npm test -- services/payments 2>&1 | ls" }, root, cfg), null);
  assert.match(checkToolCall(w, "Bash", { command: "npm test && git commit -m x" }, root, cfg), /reserved for the parent/);
  assert.match(checkToolCall(w, "Bash", { command: "rm -rf services" }, root, cfg), /not in this warden's bash allowlist/);
  assert.equal(checkToolCall(w, "Bash", { command: "npm test/payments/a.test.ts" }, root, cfg), null);
  assert.match(checkToolCall(w, "Bash", { command: "npm testx" }, root, cfg), /not in this warden's bash allowlist/);
  assert.match(checkToolCall(w, "Bash", { command: "git commit/x" }, root, cfg), /reserved for the parent/);
  assert.match(checkToolCall(w, "Bash", { command: "ls > services/auth/x" }, root, cfg), /redirect/);
  assert.equal(checkToolCall(w, "Bash", { command: "ls > services/payments/out.txt" }, root, cfg), null);
  assert.match(checkToolCall(w, "Bash", { command: "ls $(cat x)" }, root, cfg), /substitution/);
  assert.equal(checkToolCall({ ...w, bash: undefined }, "Bash", { command: "anything goes" }, root, cfg), null);
});

// ── hooks end-to-end ──
test("pre-tool hook: dispatch gate denies bad briefs, records good ones", () => {
  const root = fixture();
  const bad = runHook(root, "pre-tool", { session_id: "s", tool_name: "Agent", tool_input: { subagent_type: "pay-warden", prompt: "just fix it" } });
  assert.equal(bad.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(runHook(root, "pre-tool", { session_id: "s", tool_name: "Agent", tool_input: { subagent_type: "pay-warden", prompt: BRIEF } }), null);
  assert.equal(runHook(root, "pre-tool", { session_id: "s", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "x" } }), null);
  assert.deepEqual(ledger(root).map((e) => e.event), ["dispatch-rejected", "dispatch"]);
});

test("pre-tool hook: guard only applies inside wardens; warn mode records without denying", () => {
  const root = fixture();
  const edit = { tool_name: "Edit", tool_input: { file_path: join(root, "services/auth/x.ts") } };
  assert.equal(runHook(root, "pre-tool", { ...edit }), null); // main thread: untouched
  assert.equal(runHook(root, "pre-tool", { ...edit, agent_type: "general-purpose" }), null);
  assert.equal(runHook(root, "pre-tool", { ...edit, agent_type: "pay-warden" }).hookSpecificOutput.permissionDecision, "deny");
  const warn = fixture({ config: { mode: "warn" } });
  assert.equal(runHook(warn, "pre-tool", { ...edit, tool_input: { file_path: join(warn, "services/auth/x.ts") }, agent_type: "pay-warden" }), null);
  assert.equal(ledger(warn)[0].enforced, false);
});

test("subagent-stop hook: blocks once on a bad report, then records", () => {
  const root = fixture();
  const blocked = runHook(root, "subagent-stop", { session_id: "s", agent_type: "pay-warden", last_assistant_message: "all done!" });
  assert.equal(blocked.decision, "block");
  assert.equal(runHook(root, "subagent-stop", { session_id: "s", agent_type: "pay-warden", last_assistant_message: "all done!", stop_hook_active: true }), null);
  assert.equal(runHook(root, "subagent-stop", { session_id: "s", agent_type: "pay-warden", last_assistant_message: REPORT }), null);
  const reports = ledger(root).filter((e) => e.event === "report");
  assert.deepEqual(reports.map((r) => [r.valid, r.status]), [[false, null], [true, "completed"]]);
});

test("hooks fail open on garbage input", () => {
  const root = fixture();
  const r = spawnSync("node", [BIN, "hook", "pre-tool"], { input: "{not json", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

// ── stats + doctor ──
test("computeStats pairs dispatches with reports for first-pass rate", () => {
  const ev = [
    { event: "dispatch", session_id: "s", warden: "a", attempt: 1 },
    { event: "report", session_id: "s", warden: "a", status: "failed", confidence: 0.3 },
    { event: "dispatch", session_id: "s", warden: "a", attempt: 2 },
    { event: "report", session_id: "s", warden: "a", status: "completed", confidence: 0.9 },
    { event: "dispatch", session_id: "s", warden: "a", attempt: 1 },
    { event: "report", session_id: "s", warden: "a", status: "completed", confidence: 0.8 },
    { event: "deny", session_id: "s", warden: "a" },
  ];
  const [s] = computeStats(ev);
  assert.equal(s.dispatches, 3); assert.equal(s.retries, 1); assert.equal(s.guardDenials, 1);
  assert.equal(s.firstAttemptRate, 0.5);
  assert.ok(Math.abs(s.meanConfidence - 2 / 3) < 1e-9);
});

test("doctor flags stale anchors, overlaps, expiry, legacy prose-only wardens", () => {
  const root = fixture({
    extraAgents: {
      "ledger-warden": "---\nname: ledger-warden\ndescription: x\ntools: Read, Edit\nwarden:\n  edit:\n    - services/**\n  expires: 2020-01-01\n---\nbody\n",
      "old-warden": "---\nname: old-warden\ndescription: x\n---\nReturns an upward-report.\n",
      "helper": "---\nname: helper\ndescription: plain agent\n---\nnot a warden `does/not/exist.ts`\n",
    },
  });
  const msgs = doctor(root, { today: "2026-01-01" }).findings.map((f) => `${f.level} ${f.agent} ${f.msg}`);
  assert.ok(msgs.some((m) => /stale anchor: `services\/payments\/gone.ts`/.test(m)));
  assert.ok(!msgs.some((m) => /charge.ts/.test(m)));
  assert.ok(!msgs.some((m) => /path\/to\/file/.test(m)));
  assert.ok(!msgs.some((m) => /legacy.ts/.test(m)));
  assert.ok(msgs.some((m) => /^error .*× .* edit authority overlaps/.test(m)));
  assert.ok(msgs.some((m) => /^error ledger-warden pilot expired/.test(m)));
  assert.ok(msgs.some((m) => /^warn old-warden authority is prose-only/.test(m)));
  assert.ok(!msgs.some((m) => /helper/.test(m)));
});

test("config authority override retargets a warden", () => {
  const root = fixture({ config: { authority: { "pay-warden": { edit: ["docs/**"] } } } });
  const w = loadAgents(root).find((a) => a.name === "pay-warden");
  assert.deepEqual(w.warden.edit, ["docs/**"]);
});

test("new scaffolds a valid warden that doctor accepts", () => {
  const root = fixture();
  const r = spawnSync("node", [BIN, "new", "auth-warden", "--edit", "services/auth/**", "--test", "npm test -- services/auth", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const w = loadAgents(root).find((a) => a.name === "auth-warden");
  assert.deepEqual(w.warden.edit, ["services/auth/**"]);
  assert.deepEqual(w.warden.bash, ["npm test -- services/auth"]);
  assert.ok(!doctor(root).findings.some((f) => f.agent.includes("auth-warden") && f.level === "error"));
});

test("bundled plugin agents are valid wardens", () => {
  const pluginRoot = resolve(dirname(BIN), "..");
  const { findings } = doctor(pluginRoot);
  assert.deepEqual(findings.filter((f) => f.level === "error"), []);
  const names = loadAgents(pluginRoot).filter((a) => a.warden).map((a) => a.name).sort();
  assert.deepEqual(names, ["debrief-scribe", "evidence-warden"]);
});
