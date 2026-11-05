import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  parseYaml, extractBlock, matchesAny, globWithin, globsOverlap, splitShell,
  validateBrief, validateReport, checkToolCall, computeStats, doctor, loadTeam, findWarden,
  validateTeamConfig, initTeam, addWarden, migrate, teamRows, stripLegacyBlock, yamlScalar,
  CONFIG_PATH, BUILTIN_NEVER,
} from "../bin/warden.mjs";

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/warden.mjs");
const PLUGIN = resolve(dirname(BIN), "..");

const AGENT = (name, body = "") => `---\nname: ${name}\ndescription: test\ntools: Read, Edit, Write, Bash\n---\n# ${name}\n${body}`;
const PAY_PRIMER = `Primer anchors: \`services/payments/charge.ts:2\` and \`services/payments/gone.ts\`.
Tombstone: \`services/payments/legacy.ts\` was removed — do not recreate.
<!-- \`path/to/file.ext:1\` inside a comment is ignored -->
`;
const PAY_YAML = `version: 1
mode: enforce
wardens:
  pay-warden:
    kind: domain
    owns:
      - services/payments/**
    run:
      - npm test
`;

/** A project with pay-warden declared in .claude/wardens.yaml (override with `yaml`) and its agent file. */
function fixture({ yaml = PAY_YAML, agents = {}, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wardens-"));
  mkdirSync(join(root, ".claude/agents"), { recursive: true });
  mkdirSync(join(root, "services/payments"), { recursive: true });
  writeFileSync(join(root, "services/payments/charge.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".claude/agents/pay-warden.md"), AGENT("pay-warden", PAY_PRIMER));
  for (const [n, body] of Object.entries(agents)) writeFileSync(join(root, `.claude/agents/${n}.md`), body);
  if (yaml != null) writeFileSync(join(root, CONFIG_PATH), yaml);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
}

const runHook = (root, which, payload) => {
  const r = spawnSync("node", [BIN, "hook", which], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const cli = (root, ...args) => spawnSync("node", [BIN, ...args, "--root", root], { encoding: "utf8" });
const ledger = (root) => existsSync(join(root, ".wardens/ledger.jsonl")) ? readFileSync(join(root, ".wardens/ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const errors = (root, today = "2026-11-05") => doctor(root, { today }).findings.filter((f) => f.level === "error");

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
test("parseYaml handles maps, lists, flow lists, block + wrapped scalars, comments", () => {
  const y = parseYaml("a: 1\nb:\n  - x\n  - 'y z'\nc:\n  d: [p, \"q r\"]\n  e: >\n    hello\n    world\nf: long\n  wrapped\ng:\n- top\nh: v # comment\ni:   # just a comment\n  - \"**/*.sql\"   # trailing\n");
  assert.deepEqual(y, { a: 1, b: ["x", "y z"], c: { d: ["p", "q r"], e: "hello world" }, f: "long wrapped", g: ["top"], h: "v", i: ["**/*.sql"] });
});

test("extractBlock finds fenced and bare blocks, last occurrence by default", () => {
  assert.equal(extractBlock(BRIEF, "mission-brief", "first").task, "fix-rounding");
  const two = "upward-report:\n  status: failed\n\nlater\nupward-report:\n  status: completed\n";
  assert.equal(extractBlock(two, "upward-report").status, "completed");
  assert.equal(extractBlock("nothing here", "upward-report"), null);
});

// ── globs + shell ──
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
test("checkToolCall enforces owned globs, never-run, redirects, the run allowlist", () => {
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
  assert.equal(checkToolCall({ ...w, bash: null }, "Bash", { command: "anything goes" }, root, cfg), null);
});

// ── the one config file ──
test("loadTeam reads .claude/wardens.yaml: settings, built-in lists, wardens, agents", () => {
  const root = fixture({ yaml: PAY_YAML.replace("mode: enforce", "mode: warn\nconfidence-floor: 0.8\nnever-run:\n  - terraform apply") });
  const team = loadTeam(root);
  assert.deepEqual(team.problems, []);
  assert.equal(team.settings.mode, "warn");
  assert.equal(team.settings.confidenceFloor, 0.8);
  assert.deepEqual(team.settings.neverCommands, [...BUILTIN_NEVER, "terraform apply"]);
  const w = findWarden(team, "pay-warden");
  assert.deepEqual([w.kind, w.edit, w.bash, w.source], ["domain", ["services/payments/**"], ["npm test"], "project"]);
  assert.ok(w.agent.file.endsWith(".claude/agents/pay-warden.md"));
  assert.equal(findWarden(team, "wardens:pay-warden").name, "pay-warden"); // plugin-namespaced agent types
});

test("typos and bad values are reported with did-you-mean; valid parts still load", () => {
  const errs = validateTeamConfig(parseYaml("mood: warn\nmode: loud\nconfidence-floor: 7\nwardens:\n  Pay_Warden:\n    own:\n      - x/**\n  api-warden:\n    kind: domian\n    expires: soon\n"));
  const text = errs.join("\n");
  assert.match(text, /unknown key `mood` — did you mean `mode`\?/);
  assert.match(text, /`mode` must be enforce \| warn/);
  assert.match(text, /`confidence-floor` must be a number between 0 and 1/);
  assert.match(text, /`wardens.Pay_Warden`: warden names are kebab-case/);
  assert.match(text, /unknown key `own` — did you mean `owns`\?/);
  assert.match(text, /`wardens.api-warden.kind` must be domain \| specialist/);
  assert.match(text, /`wardens.api-warden.expires` must be a date/);
  const root = fixture({ yaml: PAY_YAML.replace("version: 1", "version: 1\nmood: warn") });
  const team = loadTeam(root);
  assert.equal(team.problems.length, 1);
  assert.ok(findWarden(team, "pay-warden"), "one typo never disables the rest of the guard");
});

test("the CLI is self-contained: run alone (as CI fetches it), bundled wardens still resolve", () => {
  const root = fixture({ yaml: PAY_YAML + "  evidence-warden:\n    owns:\n      - wiki/ablations/**\n" });
  const alone = mkdtempSync(join(tmpdir(), "wardens-cli-"));
  writeFileSync(join(alone, "warden.mjs"), readFileSync(BIN));
  const r = spawnSync("node", [join(alone, "warden.mjs"), "doctor", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 error\(s\)/);
});

test("bundled wardens have built-in defaults; the project file overrides per key", () => {
  const plain = loadTeam(fixture());
  assert.deepEqual(findWarden(plain, "debrief-scribe").edit, ["docs/debriefs/**"]);
  assert.equal(findWarden(plain, "debrief-scribe").source, "bundled");
  const root = fixture({ yaml: PAY_YAML + "  debrief-scribe:\n    owns:\n      - wiki/debriefs/**\n" });
  const w = findWarden(loadTeam(root), "debrief-scribe");
  assert.deepEqual([w.edit, w.bash, w.kind], [["wiki/debriefs/**"], ["git show", "git diff", "git log"], "specialist"]);
});

test("ownership-file supplies owned globs; null owners stay unowned; unknown owners are flagged", () => {
  const root = fixture({
    yaml: PAY_YAML.replace("version: 1", "version: 1\nownership-file: owners.json"),
    files: { "owners.json": JSON.stringify({ entries: [{ glob: "services/payments/api/**", owner: "pay-warden" }, { glob: "services/legacy/**", owner: null }, { glob: "services/auth/**", owner: "auth-warden" }] }) },
  });
  assert.deepEqual(findWarden(loadTeam(root), "pay-warden").edit, ["services/payments/**", "services/payments/api/**"]);
  assert.ok(doctor(root).findings.some((f) => /owner `auth-warden`, which isn't declared/.test(f.msg)));
  writeFileSync(join(root, "owners.json"), "{nope");
  assert.ok(loadTeam(root).problems.some((p) => /ownership-file owners.json/.test(p)));
});

test("the JSON schema and the validator know the same keys", () => {
  const schema = JSON.parse(readFileSync(join(PLUGIN, "schema/wardens.schema.json"), "utf8"));
  const top = Object.keys(schema.properties).sort();
  const wardenKeys = Object.keys(schema.properties.wardens.additionalProperties.oneOf[1].properties).sort();
  const sample = Object.fromEntries(top.map((k) => [k, k === "wardens" ? { "x-warden": Object.fromEntries(wardenKeys.map((w) => [w, w === "kind" ? "domain" : w === "expires" ? "2027-01-01" : ["a"]])) } : k === "version" ? 1 : k === "mode" ? "warn" : k === "confidence-floor" ? 0.5 : ["agent-dirs", "never-run", "always-run"].includes(k) ? ["a"] : "a"]));
  assert.deepEqual(validateTeamConfig(sample), []);
});

// ── init / new / team ──
test("init writes a commented, valid wardens.yaml and gitignores .wardens/ exactly once", () => {
  const root = fixture({ yaml: null });
  const { gitignored } = initTeam(root, { mode: "warn" });
  assert.ok(gitignored);
  const text = readFileSync(join(root, CONFIG_PATH), "utf8");
  assert.match(text, /^# yaml-language-server: \$schema=/);
  assert.deepEqual(validateTeamConfig(parseYaml(text)), []);
  assert.equal(loadTeam(root).settings.mode, "warn");
  assert.throws(() => initTeam(root), /already exists/);
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8").match(/\.wardens\//g).length, 1);
});

test("new appends to wardens.yaml, creates the agent from the template, quotes risky globs", () => {
  const root = fixture({ yaml: null });
  const r = addWarden(root, "sql-warden", { owns: ["**/*.sql"], run: ["make db-test"] });
  assert.ok(r.created && r.createdAgent);
  const text = readFileSync(join(root, CONFIG_PATH), "utf8");
  assert.match(text, /- "\*\*\/\*\.sql"/);
  const w = findWarden(loadTeam(root), "sql-warden");
  assert.deepEqual([w.edit, w.bash], [["**/*.sql"], ["make db-test"]]);
  const agent = readFileSync(r.agentFile, "utf8");
  assert.match(agent, /^---\nname: sql-warden\n/);
  assert.doesNotMatch(agent, /\{\{|^warden:/m);
  // registering an EXISTING agent as a warden keeps its file
  writeFileSync(join(root, ".claude/agents/ops-warden.md"), AGENT("ops-warden", "my primer"));
  const ops = addWarden(root, "ops-warden", { owns: ["ops/**"] });
  assert.equal(ops.createdAgent, false);
  assert.match(readFileSync(ops.agentFile, "utf8"), /my primer/);
  assert.throws(() => addWarden(root, "sql-warden", { owns: ["x/**"] }), /already declared/);
  assert.throws(() => addWarden(root, "Bad", { owns: ["x/**"] }), /kebab-case/);
  assert.throws(() => addWarden(root, "empty-warden", {}), /needs at least one --owns/);
  assert.deepEqual(errors(root).filter((e) => !/overlap/.test(e.msg)), []);
});

test("new refuses to append when `wardens:` is not the last section, leaving the file untouched", () => {
  const yaml = "version: 1\nwardens:\n  pay-warden:\n    owns:\n      - services/payments/**\nmode: warn\n";
  const root = fixture({ yaml });
  assert.throws(() => addWarden(root, "x-warden", { owns: ["x/**"] }), /isn't the last section/);
  assert.equal(readFileSync(join(root, CONFIG_PATH), "utf8"), yaml);
});

test("CLI: init → new → team → route → doctor round trip", () => {
  const root = fixture({ yaml: null });
  assert.equal(cli(root, "init").status, 0);
  assert.equal(cli(root, "new", "web-warden", "--owns", "apps/web/**", "--run", "npm test").status, 0);
  const team = cli(root, "team");
  assert.match(team.stdout, /web-warden\s+domain\s+apps\/web\/\*\*\s+1\s+0/);
  assert.match(team.stdout, /debrief-scribe .*plugin: agents\/debrief-scribe\.md/);
  assert.match(cli(root, "route", "apps/web/x.tsx").stdout, /→ web-warden/);
  const json = JSON.parse(cli(root, "team", "--json").stdout);
  assert.equal(json.config, CONFIG_PATH);
  assert.ok(json.wardens.some((w) => w.name === "web-warden" && w.agent === ".claude/agents/web-warden.md"));
  // pay-warden's agent exists but isn't declared → warning, not silence
  assert.match(cli(root, "doctor").stdout, /pay-warden\] looks like a warden but isn't declared/);
});

test("teamRows merges the ledger record into the roster", () => {
  const root = fixture();
  mkdirSync(join(root, ".wardens"), { recursive: true });
  writeFileSync(join(root, ".wardens/ledger.jsonl"), [
    { event: "dispatch", session_id: "s", warden: "pay-warden", attempt: 1 },
    { event: "report", session_id: "s", warden: "pay-warden", status: "completed", confidence: 0.9 },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const row = teamRows(loadTeam(root)).find((r) => r.name === "pay-warden");
  assert.deepEqual([row.missions, row.firstPass, row.agent], [1, 1, ".claude/agents/pay-warden.md"]);
});

// ── migrate from v0.2 ──
const V02_AGENT = `---
name: pay-warden
description: test
tools: Read, Edit, Write, Bash
warden:
  kind: domain   # comment
  edit:
    - services/payments/**
  bash:
    - npm test
  expires: 2027-01-31
---
# pay-warden
primer stays
`;

test("migrate folds v0.2 frontmatter + .wardens/config.json into one wardens.yaml", () => {
  const root = fixture({
    yaml: null,
    agents: { "pay-warden": V02_AGENT, "notes-scribe": AGENT("notes-scribe", "x").replace("tools:", "warden:\n  kind: specialist\n  edit: [notes/**]\ntools:") },
    files: {
      ".wardens/config.json": JSON.stringify({ mode: "warn", confidenceFloor: 0.8, ownershipFile: "owners.json", neverCommands: [...BUILTIN_NEVER, "terraform apply"], authority: { "debrief-scribe": { edit: ["wiki/debriefs/**"] } } }),
      "owners.json": "[]",
    },
  });
  assert.ok(errors(root).some((e) => /run `warden migrate`/.test(e.msg)));
  assert.throws(() => initTeam(root), /run `warden migrate`/);
  const dry = migrate(root, { dryRun: true });
  assert.ok(!existsSync(join(root, CONFIG_PATH)), "dry run writes nothing");
  assert.equal(dry.stripped.length, 2);
  migrate(root);
  const team = loadTeam(root);
  assert.deepEqual(team.problems, []);
  assert.equal(team.settings.mode, "warn");
  assert.equal(team.settings.confidenceFloor, 0.8);
  assert.equal(team.settings.ownershipFile, "owners.json");
  assert.ok(team.settings.neverCommands.includes("terraform apply"));
  const pay = findWarden(team, "pay-warden");
  assert.deepEqual([pay.kind, pay.edit, pay.bash, pay.expires], ["domain", ["services/payments/**"], ["npm test"], "2027-01-31"]);
  assert.deepEqual(findWarden(team, "notes-scribe").edit, ["notes/**"]);
  assert.deepEqual(findWarden(team, "debrief-scribe").edit, ["wiki/debriefs/**"]);
  const agent = readFileSync(join(root, ".claude/agents/pay-warden.md"), "utf8");
  assert.doesNotMatch(agent, /^warden:|^\s+edit:/m);
  assert.match(agent, /tools: Read, Edit, Write, Bash\n---\n# pay-warden\nprimer stays/);
  assert.ok(!existsSync(join(root, ".wardens/config.json")));
  assert.deepEqual(errors(root), []);
  assert.throws(() => migrate(root), /already exists/);
});

test("stripLegacyBlock removes only the warden block", () => {
  assert.equal(stripLegacyBlock("---\nname: a\nwarden:\n  edit:\n    - x\n\n  bash: [y]\ntools: Read\n---\nbody\n"), "---\nname: a\ntools: Read\n---\nbody\n");
  assert.equal(stripLegacyBlock("no frontmatter"), "no frontmatter");
});

test("yamlScalar quotes only what YAML would misread", () => {
  assert.equal(yamlScalar("services/api/**"), "services/api/**");
  assert.equal(yamlScalar("pytest services/api -q"), "pytest services/api -q");
  assert.equal(yamlScalar("bunx turbo run typecheck --filter=@reactive-agents/x"), "bunx turbo run typecheck --filter=@reactive-agents/x");
  assert.equal(yamlScalar("**/*.sql"), '"**/*.sql"');
  assert.equal(yamlScalar("--flag"), '"--flag"');
  assert.equal(yamlScalar("a: b"), '"a: b"');
  assert.equal(yamlScalar("true"), '"true"');
  for (const s of ["**/*.sql", "a: b", "x # y", "plain/path"]) assert.equal(parseYaml(`k: ${yamlScalar(s)}`).k, s);
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
  const warn = fixture({ yaml: PAY_YAML.replace("mode: enforce", "mode: warn") });
  assert.equal(runHook(warn, "pre-tool", { ...edit, tool_input: { file_path: join(warn, "services/auth/x.ts") }, agent_type: "pay-warden" }), null);
  assert.equal(ledger(warn)[0].enforced, false);
});

test("an agent is only guarded once it is declared in wardens.yaml", () => {
  const root = fixture({ yaml: "version: 1\nwardens:\n" });
  const edit = { agent_type: "pay-warden", tool_name: "Edit", tool_input: { file_path: join(root, "services/auth/x.ts") } };
  assert.equal(runHook(root, "pre-tool", edit), null);
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

test("doctor: stale anchors, overlaps, expiry, missing agents, undeclared wardens", () => {
  const root = fixture({
    yaml: PAY_YAML + "  ledger-warden:\n    owns:\n      - services/**\n    expires: 2020-01-01\n  ghost-warden:\n    owns:\n      - ghost/**\n",
    agents: { "ledger-warden": AGENT("ledger-warden"), "old-warden": AGENT("old-warden", "Returns an upward-report.\n"), helper: "---\nname: helper\ndescription: plain agent\n---\nnot a warden `does/not/exist.ts`\n" },
  });
  const msgs = doctor(root, { today: "2026-01-01" }).findings.map((f) => `${f.level} ${f.agent} ${f.msg}`);
  assert.ok(msgs.some((m) => /stale anchor: `services\/payments\/gone.ts`/.test(m)));
  assert.ok(!msgs.some((m) => /charge.ts|path\/to\/file|legacy.ts/.test(m)));
  assert.ok(msgs.some((m) => /^error .*× .* owned paths overlap/.test(m)));
  assert.ok(msgs.some((m) => /^error ledger-warden pilot expired/.test(m)));
  assert.ok(msgs.some((m) => /^error ghost-warden declared in .claude\/wardens.yaml but there is no agent file/.test(m)));
  assert.ok(msgs.some((m) => /^warn old-warden looks like a warden but isn't declared/.test(m)));
  assert.ok(!msgs.some((m) => /helper/.test(m)));
});

test("bundled plugin agents are valid wardens with their defaults", () => {
  assert.deepEqual(doctor(PLUGIN).findings.filter((f) => f.level === "error"), []);
  const team = loadTeam(PLUGIN);
  assert.deepEqual([...team.wardens.keys()].sort(), ["debrief-scribe", "evidence-warden"]);
  assert.ok([...team.wardens.values()].every((w) => w.agent?.bundled && w.kind === "specialist"));
});
