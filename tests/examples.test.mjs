// Every example in examples/ must be valid and must enforce what its text claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeam, findWarden, doctor, checkToolCall, matchesAny, parseYaml, validateTeamConfig, CONFIG_PATH } from "../bin/warden.mjs";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../examples");
const AGENTS = readdirSync(join(EXAMPLES, "agents")).filter((f) => f.endsWith(".md"));
const VARIANTS = readdirSync(join(EXAMPLES, "variants")).filter((f) => f.endsWith(".yaml"));

/** A throwaway project with every example agent installed and `config` as its .claude/wardens.yaml. */
function project(config = "wardens.yaml") {
  const root = mkdtempSync(join(tmpdir(), "wardens-examples-"));
  mkdirSync(join(root, ".claude/agents"), { recursive: true });
  cpSync(join(EXAMPLES, "agents"), join(root, ".claude/agents"), { recursive: true });
  cpSync(join(EXAMPLES, config), join(root, CONFIG_PATH));
  mkdirSync(join(root, "examples/configs"), { recursive: true });
  cpSync(join(EXAMPLES, "configs/ownership.example.json"), join(root, "examples/configs/ownership.example.json"));
  return root;
}
const warden = (root, name) => {
  const w = findWarden(loadTeam(root), name);
  assert.ok(w, `${name} is declared`);
  return w;
};
const bash = (root, name, command) => checkToolCall(warden(root, name), "Bash", { command }, root, loadTeam(root).settings);
const edit = (root, name, path, tool = "Edit") => checkToolCall(warden(root, name), tool, { file_path: join(root, path) }, root, loadTeam(root).settings);

test("there are examples to test", () => {
  assert.ok(AGENTS.length >= 7);
  assert.ok(VARIANTS.length >= 3);
});

test("examples/wardens.yaml declares every example agent and passes doctor with no errors", () => {
  const root = project();
  const team = loadTeam(root);
  assert.deepEqual(team.problems, []);
  for (const f of AGENTS) assert.ok(team.wardens.has(f.replace(/\.md$/, "")), `${f} is declared in examples/wardens.yaml`);
  assert.deepEqual(doctor(root, { today: "2026-11-05" }).findings.filter((f) => f.level === "error"), []);
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

test("migrations-warden: its agent has Write but no Edit; cannot touch app code", () => {
  const root = project();
  const tools = String(warden(root, "migrations-warden").agent.data.tools);
  assert.match(tools, /\bWrite\b/);
  assert.doesNotMatch(tools, /\bEdit\b/);
  assert.equal(edit(root, "migrations-warden", "db/migrations/0042_add_index.sql", "Write"), null);
  assert.match(edit(root, "migrations-warden", "services/api/app/models.py", "Write"), /outside edit authority/);
  assert.match(bash(root, "migrations-warden", "psql -c 'DROP TABLE users'"), /not in this warden's bash allowlist/);
});

test("infra-warden: may plan, may not apply or destroy (team-wide never-run)", () => {
  const root = project();
  assert.equal(bash(root, "infra-warden", "terraform plan -out tf.plan"), null);
  assert.equal(bash(root, "infra-warden", "terraform fmt -check && terraform validate"), null);
  assert.match(bash(root, "infra-warden", "terraform apply -auto-approve"), /reserved for the parent/);
  assert.match(bash(root, "infra-warden", "terraform destroy"), /reserved for the parent/);
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

test("bundled agents are retargeted from the same file", () => {
  const root = project();
  assert.deepEqual(warden(root, "debrief-scribe").edit, ["docs/debriefs/**"]);
  assert.deepEqual(warden(root, "evidence-warden").edit, ["docs/experiments/**"]);
  assert.deepEqual(warden(root, "debrief-scribe").bash, ["git show", "git diff", "git log"], "unset keys keep the bundled defaults");
});

test("every variant is a valid wardens.yaml", () => {
  for (const f of VARIANTS) {
    const raw = parseYaml(readFileSync(join(EXAMPLES, "variants", f), "utf8"));
    assert.deepEqual(validateTeamConfig(raw), [], f);
    assert.deepEqual(loadTeam(project(`variants/${f}`)).problems, [], f);
  }
});

test("variants/trial-warn-mode: warn mode", () => {
  assert.equal(loadTeam(project("variants/trial-warn-mode.yaml")).settings.mode, "warn");
});

test("variants/strict: higher floor; never-run applies whatever a warden's run list says", () => {
  const root = project("variants/strict.yaml");
  assert.equal(loadTeam(root).settings.confidenceFloor, 0.8);
  assert.equal(bash(root, "infra-warden", "terraform plan"), null, "run: [\"*\"] allows anything not in never-run");
  assert.match(bash(root, "infra-warden", "terraform apply"), /reserved for the parent/);
  assert.match(bash(root, "api-warden", "pytest services/api && rm -rf services/api/.cache"), /reserved for the parent/);
});

test("variants/ownership-map: authority comes from the map; null owners stay unowned", () => {
  const root = project("variants/ownership-map.yaml");
  const wardens = [...loadTeam(root).wardens.values()];
  const owners = (p) => wardens.filter((w) => matchesAny(w.edit, p)).map((w) => w.name);
  assert.deepEqual(owners("services/api/app/main.py"), ["api-warden"]);
  assert.deepEqual(owners("scripts/deploy.sh"), []);
  assert.deepEqual(owners("apps/web/package.json"), []);
  assert.deepEqual(doctor(root, { today: "2026-11-05" }).findings.filter((f) => f.level === "error"), []);
});

test("README's api-warden snippet matches examples/wardens.yaml", () => {
  const readme = readFileSync(join(EXAMPLES, "../README.md"), "utf8");
  const snippet = readme.match(/```yaml\n(?:#[^\n]*\n)*version: 1\n[\s\S]*?\n  api-warden:\n([\s\S]*?)```/)?.[1];
  assert.ok(snippet, "README has a wardens.yaml block with api-warden");
  const strip = (l) => l.replace(/\s+#.*$/, "").trimEnd();
  const file = readFileSync(join(EXAMPLES, "wardens.yaml"), "utf8").split("\n").map(strip);
  for (const line of snippet.split("\n").map(strip).filter(Boolean))
    assert.ok(file.includes(line), `README line not in examples/wardens.yaml: ${JSON.stringify(line)}`);
});
