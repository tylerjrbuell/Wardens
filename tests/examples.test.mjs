// Every example in examples/ must be valid and must enforce what its text claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgents, loadConfig, doctor, checkToolCall, matchesAny } from "../bin/warden.mjs";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../examples");
const AGENTS = readdirSync(join(EXAMPLES, "agents")).filter((f) => f.endsWith(".md"));
const CONFIGS = readdirSync(join(EXAMPLES, "configs")).filter((f) => /^\d\d-.*\.json$/.test(f));

/** A throwaway project with every example warden installed and an optional config. */
function project(config) {
  const root = mkdtempSync(join(tmpdir(), "wardens-examples-"));
  mkdirSync(join(root, ".claude/agents"), { recursive: true });
  cpSync(join(EXAMPLES, "agents"), join(root, ".claude/agents"), { recursive: true });
  if (config) {
    mkdirSync(join(root, ".wardens"), { recursive: true });
    writeFileSync(join(root, ".wardens/config.json"), JSON.stringify(config));
  }
  return root;
}
const warden = (root, name, cfg = loadConfig(root)) => {
  const a = loadAgents(root, cfg).find((x) => x.name === name);
  assert.ok(a?.warden, `${name} is a warden`);
  return { ...a.warden, name };
};
const bash = (root, name, command) => checkToolCall(warden(root, name), "Bash", { command }, root, loadConfig(root));
const edit = (root, name, path, tool = "Edit") => checkToolCall(warden(root, name), tool, { file_path: join(root, path) }, root, loadConfig(root));

test("there are examples to test", () => {
  assert.ok(AGENTS.length >= 7);
  assert.ok(CONFIGS.length >= 4);
});

test("every example warden passes doctor with no errors and no ownership overlap", () => {
  const root = project();
  const { findings, wardens } = doctor(root, { today: "2026-11-05" });
  assert.equal(wardens, AGENTS.length);
  assert.deepEqual(findings.filter((f) => f.level === "error"), []);
});

test("api-warden: owns services/api only; runs its test/lint commands; never commits", () => {
  const root = project();
  assert.equal(edit(root, "api-warden", "services/api/app/routes/users.py"), null);
  assert.match(edit(root, "api-warden", "apps/web/src/App.tsx"), /outside edit authority/);
  assert.equal(bash(root, "api-warden", "pytest services/api -q"), null);
  assert.equal(bash(root, "api-warden", "ruff check services/api && mypy services/api"), null);
  assert.match(bash(root, "api-warden", "pytest services/api && git commit -am fix"), /reserved for the parent/);
});

test("web-warden: owns src and tests but not package.json", () => {
  const root = project();
  assert.equal(edit(root, "web-warden", "apps/web/src/components/Button.tsx"), null);
  assert.match(edit(root, "web-warden", "apps/web/package.json"), /outside edit authority/);
  assert.match(bash(root, "web-warden", "npm install left-pad --workspace apps/web"), /not in this warden's bash allowlist/);
});

test("migrations-warden: has Write but no Edit; cannot touch app code", () => {
  const root = project();
  const a = loadAgents(root).find((x) => x.name === "migrations-warden");
  assert.match(a.data.tools, /\bWrite\b/);
  assert.doesNotMatch(a.data.tools, /\bEdit\b/);
  assert.equal(edit(root, "migrations-warden", "db/migrations/0042_add_index.sql", "Write"), null);
  assert.match(edit(root, "migrations-warden", "services/api/app/models.py", "Write"), /outside edit authority/);
  assert.match(bash(root, "migrations-warden", "psql -c 'DROP TABLE users'"), /not in this warden's bash allowlist/);
});

test("infra-warden: may plan, may not apply or destroy", () => {
  const root = project();
  assert.equal(bash(root, "infra-warden", "terraform plan -out tf.plan"), null);
  assert.equal(bash(root, "infra-warden", "terraform fmt -check && terraform validate"), null);
  assert.match(bash(root, "infra-warden", "terraform apply -auto-approve"), /not in this warden's bash allowlist/);
  assert.match(bash(root, "infra-warden", "terraform destroy"), /not in this warden's bash allowlist/);
});

test("security-reviewer: writes only review reports, never product code", () => {
  const root = project();
  assert.equal(edit(root, "security-reviewer", "docs/security/reviews/2026-11-05-auth.md", "Write"), null);
  assert.match(edit(root, "security-reviewer", "services/api/app/auth.py", "Write"), /outside edit authority/);
  assert.equal(bash(root, "security-reviewer", "semgrep --config auto services/api"), null);
});

test("release-gate: audits but never tags, pushes, or publishes", () => {
  const root = project();
  assert.equal(bash(root, "release-gate", "npm ci && npm run build && npm test"), null);
  assert.match(bash(root, "release-gate", "git tag v1.2.0"), /reserved for the parent/);
  assert.match(bash(root, "release-gate", "npm publish"), /reserved for the parent/);
});

test("docs-warden: the pilot window fails doctor once it has passed", () => {
  const root = project();
  const before = doctor(root, { today: "2027-03-30" }).findings;
  const after = doctor(root, { today: "2027-04-01" }).findings;
  assert.ok(!before.some((f) => f.agent === "docs-warden" && f.level === "error"));
  assert.ok(after.some((f) => f.agent === "docs-warden" && /pilot expired 2027-03-31/.test(f.msg)));
});

test("every example config parses and loads", () => {
  for (const f of CONFIGS) {
    const cfg = JSON.parse(readFileSync(join(EXAMPLES, "configs", f), "utf8"));
    const root = project(cfg);
    const loaded = loadConfig(root);
    assert.equal(loaded._error, undefined, f);
    assert.ok(["warn", "enforce"].includes(loaded.mode), f);
  }
});

test("02-strict: neverCommands apply to every warden regardless of its allowlist", () => {
  const cfg = JSON.parse(readFileSync(join(EXAMPLES, "configs/02-strict.json"), "utf8"));
  const root = project(cfg);
  assert.match(bash(root, "infra-warden", "terraform apply"), /reserved for the parent/);
  assert.match(bash(root, "api-warden", "pytest services/api && rm -rf services/api/.cache"), /reserved for the parent/);
});

test("03-ownership-map: authority comes from the map; null owners stay unowned", () => {
  const cfg = JSON.parse(readFileSync(join(EXAMPLES, "configs/03-ownership-map.json"), "utf8"));
  const root = project(cfg);
  mkdirSync(join(root, "examples/configs"), { recursive: true });
  cpSync(join(EXAMPLES, "configs/ownership.example.json"), join(root, "examples/configs/ownership.example.json"));
  const wardens = loadAgents(root).filter((a) => a.warden);
  const owners = (p) => wardens.filter((a) => matchesAny(a.warden.edit, p)).map((a) => a.name);
  assert.deepEqual(owners("services/api/app/main.py"), ["api-warden"]);
  assert.deepEqual(owners("scripts/deploy.sh"), []);
  assert.deepEqual(owners("apps/web/package.json"), []);
  assert.deepEqual(doctor(root, { today: "2026-11-05" }).findings.filter((f) => f.level === "error"), []);
});

test("04-retarget-bundled: overrides edit dirs and swaps a warden's commands", () => {
  const cfg = JSON.parse(readFileSync(join(EXAMPLES, "configs/04-retarget-bundled.json"), "utf8"));
  const root = project(cfg);
  assert.deepEqual(warden(root, "debrief-scribe").edit, ["docs/debriefs/**"]);
  assert.equal(bash(root, "web-warden", "pnpm --filter web test"), null);
  assert.match(bash(root, "web-warden", "npm test --workspace apps/web"), /not in this warden's bash allowlist/);
});
