#!/usr/bin/env node
// wardens — deterministic enforcement + measurement for bounded Claude Code subagents.
//
// Zero dependencies. Node >= 18. The whole team lives in ONE file: .claude/wardens.yaml
//
//   warden init [--mode warn|enforce]   create .claude/wardens.yaml (and ignore .wardens/)
//   warden new <name> --owns <glob> [--owns <glob>] [--run "<cmd>"] [--kind domain|specialist]
//                                       add a warden to wardens.yaml (+ its agent file if missing)
//   warden team [--json]                the roster: who owns what, may run what, and how they're doing
//   warden route <path...>              which warden owns a path
//   warden doctor [--strict]            lint wardens.yaml + agents (typos, overlaps, stale anchors, expiry)
//   warden stats [--json]               outcome metrics from the ledger
//   warden check brief|report           validate a MissionBrief / UpwardReport read from stdin
//   warden migrate [--dry-run]          convert v0.2 `warden:` frontmatter + .wardens/config.json into wardens.yaml
//   warden hook pre-tool|subagent-stop  the plugin's hooks (dispatch gate, authority guard, report gate, ledger)
//
// Exit codes: 0 ok, 1 findings/invalid, 2 usage error.
// Hooks fail OPEN on internal errors (a broken guard must never brick a session) but record the error.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, relative, dirname, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Mini YAML (restricted subset) ───────────────────────────────────────────
// Supports: nested maps by indentation, block lists (`- x`), flow lists (`[a, b]`),
// quoted/plain scalars, `|` / `>` block scalars, wrapped plain scalars, `#` comments.
// Not supported (by design): anchors, tags, lists of maps (items stay strings), multi-doc.

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

export function parseYaml(src) {
  const lines = String(src).replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const isBlank = (l) => /^\s*(#.*)?$/.test(l);
  const skipBlank = () => { while (i < lines.length && isBlank(lines[i])) i++; };
  const isItem = (t) => t === "-" || t.startsWith("- ");

  function continuation(ind) {
    const parts = [];
    while (i < lines.length && !isBlank(lines[i]) && indentOf(lines[i]) > ind) {
      const t = lines[i].trim();
      if (isItem(t) || KEY_RE.test(t)) break;
      parts.push(t); i++;
    }
    return parts;
  }

  function blockScalar(ind, folded) {
    const out = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > ind)) { out.push(lines[i]); i++; }
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    const min = Math.min(...out.filter((l) => l.trim()).map(indentOf), Infinity);
    const body = out.map((l) => l.slice(Number.isFinite(min) ? min : 0));
    return folded ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n");
  }

  function node(minIndent) {
    skipBlank();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    return isItem(lines[i].trim()) ? list(ind) : map(ind);
  }

  function list(ind) {
    const out = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length || indentOf(lines[i]) !== ind) break;
      const t = lines[i].trim();
      if (!isItem(t)) break;
      i++;
      const rest = t === "-" ? "" : t.slice(2).trim();
      if (rest === "") out.push(node(ind + 1));
      else {
        const more = continuation(ind);
        out.push(more.length ? [stripComment(rest), ...more].join(" ") : scalar(rest));
      }
    }
    return out;
  }

  function map(ind) {
    const out = {};
    for (;;) {
      skipBlank();
      if (i >= lines.length || indentOf(lines[i]) !== ind) break;
      const m = lines[i].trim().match(KEY_RE);
      if (!m) break;
      i++;
      const key = m[1];
      const rest = (m[2] ?? "").trim();
      if (rest === "" || rest.startsWith("#")) {
        skipBlank();
        if (i < lines.length && indentOf(lines[i]) > ind) out[key] = node(ind + 1);
        else if (i < lines.length && indentOf(lines[i]) === ind && isItem(lines[i].trim())) out[key] = list(ind);
        else out[key] = null;
      } else if (/^[|>][-+]?$/.test(rest)) {
        out[key] = blockScalar(ind, rest[0] === ">");
      } else {
        const more = continuation(ind);
        out[key] = more.length ? [stripComment(rest), ...more].join(" ") : scalar(rest);
      }
    }
    return out;
  }

  const result = node(0);
  return result ?? {};
}

function stripComment(s) {
  // A quoted scalar ends at its closing quote; anything after it may only be a comment.
  const q = s.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(#.*)?$/);
  if (q) return q[1];
  if (/^["']/.test(s)) return s;
  return s.replace(/\s+#.*$/, "");
}

function scalar(raw) {
  const s = stripComment(raw.trim());
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return (inner.match(/("[^"]*"|'[^']*'|[^,]+)/g) || []).map((x) => scalar(x.trim()));
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// ─── Markdown helpers ────────────────────────────────────────────────────────

export function parseFrontmatter(text) {
  const m = String(text).replace(/\r/g, "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(text) };
  return { data: parseYaml(m[1]), body: m[2] };
}

/** Extract a top-level YAML block (`mission-brief:` / `upward-report:`) from free text.
 *  `which` = "first" | "last" occurrence. Returns the parsed inner object, or null. */
export function extractBlock(text, rootKey, which = "last") {
  const lines = String(text ?? "").replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
  const re = new RegExp(`^(\\s*)${rootKey.replace(/[-]/g, "\\-")}:\\s*$`);
  const hits = lines.map((l, idx) => (re.test(l) ? idx : -1)).filter((x) => x >= 0);
  if (!hits.length) return null;
  const start = which === "first" ? hits[0] : hits[hits.length - 1];
  const baseIndent = lines[start].match(/^ */)[0].length;
  const block = [lines[start]];
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*```/.test(l)) break;
    if (l.trim() !== "" && l.match(/^ */)[0].length <= baseIndent) break;
    block.push(l);
  }
  const dedented = block.map((l) => l.slice(Math.min(baseIndent, l.match(/^ */)[0].length))).join("\n");
  const parsed = parseYaml(dedented);
  const value = parsed?.[rootKey];
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// ─── Globs ───────────────────────────────────────────────────────────────────

export function globToRegExp(glob) {
  let re = "";
  const g = glob.replace(/^\.\//, "");
  for (let k = 0; k < g.length; k++) {
    const c = g[k];
    if (c === "*") {
      if (g[k + 1] === "*") {
        k++;
        if (g[k + 1] === "/") { k++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", k);
      if (end < 0) { re += "\\{"; continue; }
      re += "(?:" + g.slice(k + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      k = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // `dir/**` also covers `dir` itself
  if (g.endsWith("/**")) re = re.replace(/\/\.\*$/, "(?:/.*)?");
  return new RegExp("^" + re + "$");
}

export const matchesAny = (globs, p) => (globs || []).some((g) => globToRegExp(String(g)).test(p));

const literalPrefix = (glob) => String(glob).replace(/^\.\//, "").split(/[*?{[]/)[0];

/** True when every path `inner` can match is (approximately) covered by `outer` globs.
 *  Exact for literal paths; prefix-based for wildcard globs. */
export function globWithin(inner, outerGlobs) {
  const s = String(inner).replace(/^\.\//, "");
  if (!/[*?{[]/.test(s)) return matchesAny(outerGlobs, s);
  const probe = literalPrefix(s) + "__warden_probe__/x";
  return matchesAny(outerGlobs, probe);
}

/** Approximate overlap test between two globs (used by doctor). */
export function globsOverlap(a, b) {
  if (globToRegExp(a).test(literalPrefix(b).replace(/\/$/, "")) || globToRegExp(b).test(literalPrefix(a).replace(/\/$/, ""))) return true;
  const pa = literalPrefix(a), pb = literalPrefix(b);
  const aWild = pa !== a, bWild = pb !== b;
  if (aWild && pb.startsWith(pa)) return true;
  if (bWild && pa.startsWith(pb)) return true;
  return a === b;
}

// ─── Project + config + warden registry ──────────────────────────────────────

export function projectDir(payload) {
  return resolve(process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd());
}

// The team is ONE committed file. Runtime state (the ledger) lives in .wardens/, which is gitignored.
export const CONFIG_PATH = ".claude/wardens.yaml";
export const SCHEMA_URL = "https://raw.githubusercontent.com/tylerjrbuell/wardens/main/schema/wardens.schema.json";

// Integration + release belong to the parent thread: no warden ever runs these. `never-run` adds to this list.
export const BUILTIN_NEVER = ["git commit", "git push", "git tag", "git rebase", "git reset --hard", "npm publish", "pnpm publish", "yarn publish", "bun publish"];
// Read-only commands every warden may run whatever its `run` allowlist says. `always-run` adds to this list.
export const BUILTIN_ALWAYS = ["cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "git status", "git diff", "git log", "git show", "git ls-files", "git blame"];

const TOP_KEYS = ["version", "mode", "confidence-floor", "ledger", "agent-dirs", "ownership-file", "never-run", "always-run", "wardens"];
const WARDEN_KEYS = ["kind", "owns", "run", "expires"];
const KINDS = ["domain", "specialist"];

/** Settings with every default filled in. Used when there is no wardens.yaml at all. */
export function defaultSettings() {
  return { mode: "enforce", confidenceFloor: 0.7, ledger: ".wardens/ledger.jsonl", agentDirs: [".claude/agents"], ownershipFile: null, neverCommands: [...BUILTIN_NEVER], alwaysCommands: [...BUILTIN_ALWAYS] };
}

const toList =(v) => (v == null ? [] : Array.isArray(v) ? v.filter((x) => x != null).map(String) : [String(v)]);
const isMap = (v) => v != null && typeof v === "object" && !Array.isArray(v);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** " — did you mean `owns`?" when a key is a near-miss of a known one. */
export function didYouMean(word, options) {
  const best = options.map((o) => [o, editDistance(word, o)]).sort((x, y) => x[1] - y[1])[0];
  const limit = word.length <= 3 ? 1 : Math.max(2, Math.floor(word.length / 4)); // mood→mode yes; web-warden→api-warden no
  return best && best[1] <= limit ? ` — did you mean \`${best[0]}\`?` : "";
}

/** Validate the parsed wardens.yaml. Returns problems as strings, each naming the key path. */
export function validateTeamConfig(raw) {
  const errs = [];
  if (!isMap(raw)) return ["the file must be a YAML mapping (`key: value` lines)"];
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errs.push(`unknown key \`${k}\`${didYouMean(k, TOP_KEYS)}`);
  if (raw.version != null && raw.version !== 1) errs.push(`\`version\` must be 1 (got ${JSON.stringify(raw.version)})`);
  if (raw.mode != null && !["enforce", "warn"].includes(raw.mode)) errs.push(`\`mode\` must be enforce | warn (got ${JSON.stringify(raw.mode)})`);
  if (raw["confidence-floor"] != null && !(typeof raw["confidence-floor"] === "number" && raw["confidence-floor"] >= 0 && raw["confidence-floor"] <= 1))
    errs.push("`confidence-floor` must be a number between 0 and 1");
  for (const k of ["ledger", "ownership-file"]) if (raw[k] != null && typeof raw[k] !== "string") errs.push(`\`${k}\` must be a path`);
  for (const k of ["agent-dirs", "never-run", "always-run"]) if (raw[k] != null && !Array.isArray(raw[k])) errs.push(`\`${k}\` must be a list`);
  if (raw.wardens != null && !isMap(raw.wardens)) errs.push("`wardens` must map warden names to their settings");
  for (const [name, w] of Object.entries(isMap(raw.wardens) ? raw.wardens : {})) {
    const at = `wardens.${name}`;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) errs.push(`\`${at}\`: warden names are kebab-case (they must match the agent's \`name\`)`);
    if (w == null) continue; // `name:` with nothing under it inherits defaults (bundled agents)
    if (!isMap(w)) { errs.push(`\`${at}\` must be a mapping with ${WARDEN_KEYS.join(", ")}`); continue; }
    for (const k of Object.keys(w)) if (!WARDEN_KEYS.includes(k)) errs.push(`\`${at}\`: unknown key \`${k}\`${didYouMean(k, WARDEN_KEYS)}`);
    if (w.kind != null && !KINDS.includes(w.kind)) errs.push(`\`${at}.kind\` must be ${KINDS.join(" | ")} (got ${JSON.stringify(w.kind)})`);
    for (const k of ["owns", "run"]) if (w[k] != null && !Array.isArray(w[k]) && typeof w[k] !== "string") errs.push(`\`${at}.${k}\` must be a list`);
    for (const g of toList(w.owns)) if (!g.trim()) errs.push(`\`${at}.owns\` has an empty glob`);
    if (w.expires != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(w.expires))) errs.push(`\`${at}.expires\` must be a date, YYYY-MM-DD`);
  }
  return errs;
}

/** Globs per owner from `ownership-file`, so a repo that already maps paths → owners keeps ONE source of truth. */
export function loadOwnership(root, settings) {
  const owned = new Map();
  if (!settings.ownershipFile) return owned;
  let data;
  try { data = JSON.parse(readFileSync(resolve(root, settings.ownershipFile), "utf8")); }
  catch (e) { throw new Error(`ownership-file ${settings.ownershipFile}: ${e.message}`); }
  const rows = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(rows)) throw new Error(`ownership-file ${settings.ownershipFile}: expected an array or {entries: [...]}`);
  for (const r of rows) {
    if (!r || typeof r.glob !== "string" || typeof r.owner !== "string" || !r.owner) continue; // null owner = unowned
    (owned.get(r.owner) || owned.set(r.owner, []).get(r.owner)).push(r.glob);
  }
  return owned;
}

function readAgents(root, agentDirs) {
  const dirs = [...agentDirs.map((d) => join(root, d)), join(PLUGIN_ROOT, "agents")];
  const seen = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      const file = join(dir, f);
      let parsed;
      try { parsed = parseFrontmatter(readFileSync(file, "utf8")); }
      catch (e) { parsed = { data: {}, body: "", error: e.message }; }
      const name = String(parsed.data.name || basename(f, ".md"));
      if (seen.has(name)) continue; // project definitions shadow plugin ones
      seen.set(name, { name, file, data: parsed.data, body: parsed.body, error: parsed.error, bundled: dir === join(PLUGIN_ROOT, "agents"), legacyWarden: isMap(parsed.data.warden) });
    }
  }
  return [...seen.values()];
}

/**
 * Load the team: `.claude/wardens.yaml` merged over the plugin's bundled defaults (`defaults.yaml`), plus
 * `ownership-file` globs, plus every agent file. Never throws: problems are collected for `doctor`/`team`,
 * and the valid parts still load, so one typo never silently disables the whole guard.
 */
export function loadTeam(root) {
  const problems = [];
  const file = join(root, CONFIG_PATH);
  let raw = {};
  const exists = existsSync(file);
  if (exists) {
    try { raw = parseYaml(readFileSync(file, "utf8")) ?? {}; }
    catch (e) { problems.push(`cannot parse ${CONFIG_PATH}: ${e.message}`); }
    problems.push(...validateTeamConfig(raw));
  }
  if (!isMap(raw)) raw = {};
  const settings = defaultSettings();
  if (["enforce", "warn"].includes(raw.mode)) settings.mode = raw.mode;
  if (typeof raw["confidence-floor"] === "number") settings.confidenceFloor = raw["confidence-floor"];
  if (typeof raw.ledger === "string") settings.ledger = raw.ledger;
  if (typeof raw["ownership-file"] === "string") settings.ownershipFile = raw["ownership-file"];
  if (Array.isArray(raw["agent-dirs"])) settings.agentDirs = toList(raw["agent-dirs"]);
  settings.neverCommands = [...new Set([...BUILTIN_NEVER, ...toList(raw["never-run"])])];
  settings.alwaysCommands = [...new Set([...BUILTIN_ALWAYS, ...toList(raw["always-run"])])];

  let owned = new Map();
  try { owned = loadOwnership(root, settings); } catch (e) { problems.push(e.message); }

  const defaultsFile = join(PLUGIN_ROOT, "defaults.yaml");
  const bundled = existsSync(defaultsFile) ? parseYaml(readFileSync(defaultsFile, "utf8"))?.wardens ?? {} : {};
  const declared = isMap(raw.wardens) ? raw.wardens : {};
  const agents = readAgents(root, settings.agentDirs);
  const wardens = new Map();
  for (const name of new Set([...Object.keys(bundled), ...Object.keys(declared)])) {
    const mine = isMap(declared[name]) ? declared[name] : {};
    const entry = { ...(isMap(bundled[name]) ? bundled[name] : {}), ...mine };
    wardens.set(name, {
      name,
      kind: KINDS.includes(entry.kind) ? entry.kind : "domain",
      edit: [...new Set([...toList(entry.owns), ...(owned.get(name) || [])])],
      bash: entry.run == null ? null : toList(entry.run),
      expires: entry.expires == null ? null : String(entry.expires),
      source: name in declared ? "project" : "bundled",
      agent: agents.find((a) => a.name === name) || null,
    });
  }
  return { root, file, exists, raw, settings, wardens, agents, owned, problems };
}

/** Resolve an agent type (possibly plugin-namespaced, e.g. `wardens:debrief-scribe`) to a warden. */
export function findWarden(team, type) {
  if (!type) return null;
  return team.wardens.get(String(type)) || team.wardens.get(String(type).split(":").pop()) || null;
}

// ─── Authority guard ─────────────────────────────────────────────────────────

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function startsWithCommand(segment, prefix) {
  if (prefix === "*") return true;
  if (!segment.startsWith(prefix)) return false;
  // Word boundary: end, space, or a path continuation (`bun test pkg` allows `bun test pkg/src/x.test.ts`).
  const next = segment[prefix.length];
  return next === undefined || next === " " || next === "/" || prefix.endsWith("/");
}

export function splitShell(cmd) {
  // Split on control operators outside quotes. Good enough for allowlisting; not a shell parser.
  const segs = [];
  let cur = "", q = null;
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k], n = cmd[k + 1];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if ((c === "&" && n === "&") || (c === "|" && (n === "|" || n === "&"))) { segs.push(cur); cur = ""; k++; continue; }
    if (c === "|" || c === ";" || c === "\n") { segs.push(cur); cur = ""; continue; }
    if (c === "&") {
      // `2>&1`, `&>file` are redirections, not the background operator.
      if (/[<>]$/.test(cur) || n === ">") { cur += c; continue; }
      segs.push(cur); cur = ""; continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
}

/** Decide whether a tool call by warden `w` is inside its authority. Returns null (allow) or a reason. */
export function checkToolCall(w, toolName, input, root, config) {
  if (EDIT_TOOLS.has(toolName)) {
    const p = input?.file_path || input?.notebook_path;
    if (!p) return null;
    const abs = isAbsolute(p) ? p : resolve(root, p);
    const rel = relative(root, abs).split("\\").join("/");
    if (rel.startsWith("..")) return `${toolName} ${p} is outside the project`;
    if (!matchesAny(w.edit, rel)) return `${toolName} ${rel} is outside edit authority [${w.edit.join(", ") || "none"}]`;
    return null;
  }
  if (toolName === "Bash") {
    const cmd = String(input?.command || "");
    if (/`|\$\(/.test(cmd)) return "command substitution is not allowed inside a warden (state the command explicitly)";
    for (const seg of splitShell(cmd)) {
      for (const never of config.neverCommands) {
        if (startsWithCommand(seg, never)) return `\`${never}\` is reserved for the parent (wardens never integrate or release)`;
      }
      // Output redirection writes files: the target must be inside edit authority.
      const cleaned = seg.replace(/\d?>&\d/g, "").replace(/&?\d?>>?\s*\/dev\/null/g, "");
      for (const m of cleaned.matchAll(/(?:^|[^<])>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
        const target = m[1].replace(/^["']|["']$/g, "");
        const rel = relative(root, resolve(root, target)).split("\\").join("/");
        if (!matchesAny(w.edit, rel)) return `redirect to ${target} is outside edit authority`;
      }
      if (w.bash == null) continue; // no allowlist declared → only never/redirect rules apply
      const base = seg.replace(/\s*\d?>>?.*$/, "").trim();
      const ok = [...w.bash, ...config.alwaysCommands].some((pfx) => startsWithCommand(base, pfx));
      if (!ok) return `\`${base}\` is not in this warden's bash allowlist`;
    }
  }
  return null;
}

// ─── Contracts ───────────────────────────────────────────────────────────────

const VAGUE = /\b(TBD|TODO|FIXME|XXX)\b|\?\?\?/i;
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const vague = (v) => VAGUE.test(Array.isArray(v) ? v.join(" ") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? ""));

export const STATUSES = ["completed", "failed", "blocked", "denied-by-authority", "needs-approval"];

/** Validate a MissionBrief against an optional warden. Returns a list of problems (empty = valid). */
export function validateBrief(brief, w) {
  if (!brief) return ["no `mission-brief:` block found in the dispatch prompt"];
  const errs = [];
  for (const f of ["end-state", "why", "success-criteria"]) {
    if (blank(brief[f])) errs.push(`missing \`${f}\``);
    else if (vague(brief[f])) errs.push(`\`${f}\` is vague (TBD/TODO)`);
  }
  const ab = brief["authority-bounds"];
  const paths = toList(ab?.paths);
  if (!paths.length) errs.push("missing `authority-bounds.paths`");
  if (w && paths.length) {
    for (const p of paths) if (!globWithin(p, w.edit)) errs.push(`authority-bounds.paths \`${p}\` widens ${w.name}'s authority [${w.edit.join(", ") || "none"}] — a brief may only narrow it; route to the owning warden (\`warden route ${literalPrefix(p) || p}\`)`);
  }
  const tasks = toList(brief["key-tasks"]);
  if (tasks.length > 5) errs.push(`\`key-tasks\` has ${tasks.length} items (max 5 — split the mission)`);
  const attempt = Number(brief.attempt ?? 1), retries = Number(brief["retries-allowed"] ?? 2);
  if (!Number.isInteger(attempt) || attempt < 1) errs.push("`attempt` must be an integer ≥ 1");
  if (!Number.isInteger(retries) || retries < 0) errs.push("`retries-allowed` must be an integer ≥ 0");
  if (attempt > retries + 1) errs.push(`retry budget exhausted (attempt ${attempt} > 1 + retries-allowed ${retries}) — escalate to the user instead of re-dispatching`);
  return errs;
}

/** Validate an UpwardReport. Returns a list of problems (empty = valid). */
export function validateReport(r, config = defaultSettings()) {
  if (!r) return ["no `upward-report:` block found as the last content of the response"];
  const errs = [];
  if (!STATUSES.includes(r.status)) errs.push(`\`status\` must be one of ${STATUSES.join(" | ")}`);
  const c = r.confidence;
  if (typeof c !== "number" || c < 0 || c > 1) errs.push("`confidence` must be a number in [0, 1]");
  const anchors = toList(r["evidence-anchors"]), verification = toList(r.verification), blockers = toList(r.blockers);
  if (r.status === "completed") {
    if (!anchors.length) errs.push("`completed` requires `evidence-anchors` (file:line, test id, command output)");
    if (typeof c === "number" && c >= config.confidenceFloor && !verification.length)
      errs.push(`confidence ≥ ${config.confidenceFloor} requires \`verification\` (commands you ran + result); unverified work caps confidence below the floor`);
  }
  if (["failed", "blocked", "denied-by-authority"].includes(r.status) && !blockers.length) errs.push(`\`${r.status}\` requires concrete \`blockers\``);
  if (r.status === "needs-approval" && !toList(r["planned-actions"]).length) errs.push("`needs-approval` requires `planned-actions`");
  if (r["escalation-required"] === true && blank(r["escalation-reason"])) errs.push("`escalation-required: true` requires `escalation-reason`");
  return errs;
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

function record(root, config, event) {
  try {
    const file = resolve(root, config.ledger);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch { /* the ledger must never break a session */ }
}

export function readLedger(root, config) {
  const file = resolve(root, config.ledger);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function computeStats(events) {
  const by = new Map();
  const get = (w) => by.get(w) || by.set(w, { warden: w, dispatches: 0, firstAttempts: 0, firstAttemptCompleted: 0, retries: 0, rejectedDispatches: 0, reports: {}, malformed: 0, guardDenials: 0, confidence: [] }).get(w);
  const queues = new Map(); // session|warden -> pending dispatches (FIFO pairing)
  for (const e of events) {
    if (!e.warden) continue;
    const s = get(e.warden);
    const key = `${e.session_id}|${e.warden}`;
    if (e.event === "dispatch") {
      s.dispatches++;
      if ((e.attempt ?? 1) === 1) s.firstAttempts++; else s.retries++;
      (queues.get(key) || queues.set(key, []).get(key)).push(e);
    } else if (e.event === "dispatch-rejected") s.rejectedDispatches++;
    else if (e.event === "deny") s.guardDenials++;
    else if (e.event === "report") {
      const status = e.valid === false ? "malformed" : e.status;
      if (e.valid === false) s.malformed++;
      s.reports[status] = (s.reports[status] || 0) + 1;
      if (typeof e.confidence === "number") s.confidence.push(e.confidence);
      const d = queues.get(key)?.shift();
      if (d && (d.attempt ?? 1) === 1 && status === "completed") s.firstAttemptCompleted++;
    }
  }
  return [...by.values()].map((s) => ({
    ...s,
    firstAttemptRate: s.firstAttempts ? s.firstAttemptCompleted / s.firstAttempts : null,
    meanConfidence: s.confidence.length ? s.confidence.reduce((a, b) => a + b, 0) / s.confidence.length : null,
    confidence: undefined,
  }));
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

const readStdin = () => { try { return readFileSync(0, "utf8"); } catch { return ""; } };

function lastAssistantText(payload) {
  if (typeof payload.last_assistant_message === "string") return payload.last_assistant_message;
  const t = payload.agent_transcript_path || payload.transcript_path;
  if (!t || !existsSync(t)) return "";
  const lines = readFileSync(t, "utf8").split("\n").filter(Boolean);
  for (let k = lines.length - 1; k >= 0; k--) {
    try {
      const m = JSON.parse(lines[k]);
      const msg = m.message || m;
      if ((m.type === "assistant" || msg.role === "assistant") && msg.content) {
        const text = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : String(msg.content);
        if (text.trim()) return text;
      }
    } catch { /* skip */ }
  }
  return "";
}

const deny = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));

function hookPreTool(payload) {
  const root = projectDir(payload);
  const team = loadTeam(root);
  const config = team.settings;
  const base = { session_id: payload.session_id, agent_id: payload.agent_id };

  // 1) Dispatch gate — a warden may only be spawned with a valid, authority-narrowing MissionBrief.
  if (payload.tool_name === "Agent" || payload.tool_name === "Task") {
    const w = findWarden(team, payload.tool_input?.subagent_type);
    if (!w) return;
    const brief = extractBlock(payload.tool_input?.prompt, "mission-brief", "first");
    const errs = validateBrief(brief, w);
    if (errs.length) {
      record(root, config, { ...base, event: "dispatch-rejected", warden: w.name, problems: errs });
      if (config.mode === "enforce") deny(`MissionBrief rejected for ${w.name}:\n- ${errs.join("\n- ")}\nFix the brief (see the mission-brief skill) and re-dispatch.`);
      return;
    }
    record(root, config, { ...base, event: "dispatch", warden: w.name, task: brief.task || payload.tool_input?.description || null, attempt: Number(brief.attempt ?? 1) });
    return;
  }

  // 2) Authority guard — tool calls made inside a warden.
  const w = findWarden(team, payload.agent_type);
  if (!w) return;
  const reason = checkToolCall(w, payload.tool_name, payload.tool_input, root, config);
  if (!reason) return;
  record(root, config, { ...base, event: "deny", warden: w.name, tool: payload.tool_name, reason, enforced: config.mode === "enforce" });
  if (config.mode === "enforce") deny(`denied-by-authority (${w.name}): ${reason}. Do not work around this. Finish with an upward-report: status: denied-by-authority, naming the out-of-scope path/command in blockers.`);
}

function hookSubagentStop(payload) {
  const root = projectDir(payload);
  const team = loadTeam(root);
  const config = team.settings;
  const w = findWarden(team, payload.agent_type);
  if (!w) return;
  const report = extractBlock(lastAssistantText(payload), "upward-report", "last");
  const errs = validateReport(report, config);
  const base = { session_id: payload.session_id, agent_id: payload.agent_id, warden: w.name };
  if (errs.length && !payload.stop_hook_active && config.mode === "enforce") {
    record(root, config, { ...base, event: "report-rejected", problems: errs });
    process.stdout.write(JSON.stringify({ decision: "block", reason: `Your UpwardReport is invalid:\n- ${errs.join("\n- ")}\nEnd your response with a corrected \`upward-report:\` YAML block (see the upward-report skill). Do not redo the work.` }));
    return;
  }
  record(root, config, {
    ...base, event: "report", valid: errs.length === 0,
    status: report?.status ?? null, confidence: typeof report?.confidence === "number" ? report.confidence : null,
    escalation: report?.["escalation-required"] === true, anchors: toList(report?.["evidence-anchors"]).length,
  });
}

// ─── Doctor ──────────────────────────────────────────────────────────────────

function trackedFiles(root) {
  try { return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); }
  catch { return null; }
}

/** True when the repo still carries v0.2 config (frontmatter `warden:` blocks or .wardens/config.json). */
export function hasLegacyConfig(root, team = loadTeam(root)) {
  return existsSync(join(root, ".wardens", "config.json")) || team.agents.some((a) => !a.bundled && a.legacyWarden);
}

export function doctor(root, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const team = loadTeam(root);
  const lintPlugin = resolve(root) === resolve(PLUGIN_ROOT);
  // Lint the project's own definitions; bundled plugin agents are linted in the plugin's own CI (root === plugin root).
  const agents = team.agents.filter((a) => lintPlugin || !a.bundled);
  const findings = [];
  const add = (level, agent, msg) => findings.push({ level, agent, msg });
  for (const p of team.problems) add("error", CONFIG_PATH, p);
  if (existsSync(join(root, ".wardens", "config.json")))
    add("error", ".wardens/config.json", `superseded by ${CONFIG_PATH} — run \`warden migrate\``);
  if (!team.exists && !lintPlugin)
    add(hasLegacyConfig(root, team) ? "error" : "info", CONFIG_PATH, hasLegacyConfig(root, team) ? "missing, but v0.2 warden config was found — run `warden migrate`" : "missing — run `warden init` to start a team");
  const files = trackedFiles(root);
  const lineCount = new Map();

  const exists = (p) => {
    if (existsSync(join(root, p))) return join(root, p);
    if (files) { const hit = files.find((f) => f === p || f.endsWith("/" + p)); return hit ? join(root, hit) : null; }
    return null;
  };

  const wardens = [...team.wardens.values()].filter((w) => lintPlugin || w.source === "project" || (w.agent && !w.agent.bundled));
  const agentNames = team.agents.map((a) => a.name);
  for (const w of wardens) {
    if (!w.agent) { add("error", w.name, `declared in ${CONFIG_PATH} but there is no agent file .claude/agents/${w.name}.md${didYouMean(w.name, agentNames)}`); continue; }
    if (w.kind === "domain" && !w.edit.length) add("error", w.name, "domain warden owns nothing — add `owns` globs (or an ownership-file row)");
    const tools = String(w.agent.data.tools || "");
    if (tools && w.edit.length && !/\b(Edit|Write|MultiEdit)\b/.test(tools)) add("warn", w.name, "owns paths but its agent has no Edit/Write tool");
    if (tools && !w.edit.length && /\b(Edit|Write|MultiEdit)\b/.test(tools)) add("warn", w.name, "its agent has Edit/Write but the warden owns nothing (every edit will be denied)");
    if (w.expires && w.expires < today) add("error", w.name, `pilot expired ${w.expires} — ratify (remove \`expires\`) or remove the warden`);
    if (w.bash == null) add("info", w.name, "no `run` allowlist — only never-run commands and redirects are guarded");
  }
  for (const a of agents) {
    if (a.error) { add("error", a.name, `cannot parse: ${a.error}`); continue; }
    if (a.legacyWarden) add("error", a.name, `has a v0.2 \`warden:\` frontmatter block — authority now lives in ${CONFIG_PATH}; run \`warden migrate\``);
    const isWarden = team.wardens.has(a.name);
    const looksLikeWarden = /-warden$|scribe$/.test(a.name) || /upward-report|mission-brief/i.test(a.body);
    if (!isWarden && looksLikeWarden && !a.legacyWarden) add("warn", a.name, `looks like a warden but isn't declared in ${CONFIG_PATH} — its authority is not enforced`);
    if (!isWarden && !looksLikeWarden) continue;
    // Stale anchors: backticked repo paths (optionally :line) mentioned in the primer.
    const seen = new Set();
    // Lines that document a deliberate deletion ("removed in W25 — do not recreate") are tombstones, not anchors.
    const TOMBSTONE = /\b(removed|deleted|do not recreate|no longer exists)\b/i;
    const scanned = a.body.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !TOMBSTONE.test(l)).join("\n");
    for (const m of scanned.matchAll(/`([\w@.\-]+(?:\/[\w@.\-]+)+\.[A-Za-z]{1,6})(?::(\d+))?(?:-\d+)?`/g)) {
      const [, p, line] = m;
      if (seen.has(p + line)) continue; seen.add(p + line);
      if (p.startsWith(".wardens/") || p === CONFIG_PATH) continue; // runtime state / the team file (validated separately)
      const hit = exists(p);
      if (!hit) { add("warn", a.name, `stale anchor: \`${p}\` not found`); continue; }
      if (line) {
        if (!lineCount.has(hit)) { try { lineCount.set(hit, statSync(hit).isFile() ? readFileSync(hit, "utf8").split("\n").length : Infinity); } catch { lineCount.set(hit, Infinity); } }
        if (Number(line) > lineCount.get(hit)) add("warn", a.name, `stale anchor: \`${p}:${line}\` is past end of file (${lineCount.get(hit)} lines)`);
      }
    }
  }
  for (const owner of team.owned.keys())
    if (!team.wardens.has(owner)) add("warn", "ownership-file", `names owner \`${owner}\`, which isn't declared in ${CONFIG_PATH} — its paths are unenforced`);
  // Ownership overlap between domain wardens → ambiguous routing.
  const domain = wardens.filter((w) => w.kind === "domain");
  for (let x = 0; x < domain.length; x++) for (let y = x + 1; y < domain.length; y++)
    for (const ga of domain[x].edit) for (const gb of domain[y].edit)
      if (globsOverlap(ga, gb)) add("error", `${domain[x].name} × ${domain[y].name}`, `owned paths overlap (${ga} ∩ ${gb}) — routing is ambiguous`);
  return { findings, wardens: wardens.length, agents: agents.length };
}

// ─── wardens.yaml writing (init / new / migrate) ─────────────────────────────

/** A YAML scalar: plain when safe, JSON-quoted otherwise (globs starting with `*`, `: `, ` #`, ...). */
export function yamlScalar(s) {
  s = String(s);
  const plainSafe = /^[A-Za-z0-9_./~+=$-]/.test(s) && !/^-|: |\s#|^\s|\s$/.test(s) && !/^(true|false|null|~|yes|no|on|off|-?\d+(\.\d+)?)$/i.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

/** The YAML lines for one warden entry under `wardens:`. */
export function emitWarden(name, { kind = "domain", owns = [], run = null, expires = null } = {}) {
  const lines = [`  ${name}:`, `    kind: ${kind}`];
  const list = (key, xs) => (xs.length ? [`    ${key}:`, ...xs.map((x) => `      - ${yamlScalar(x)}`)] : [`    ${key}: []`]);
  if (owns.length) lines.push(...list("owns", owns)); // empty = globs come from ownership-file (doctor flags a domain warden that owns nothing)
  if (run != null) lines.push(...list("run", run));
  if (expires) lines.push(`    expires: ${expires}`);
  return lines.join("\n") + "\n";
}

/** The canonical wardens.yaml text. `wardens` is always the last section, so `warden new` can append to it. */
export function renderConfig({ mode = "warn", confidenceFloor = null, ledger = null, ownershipFile = null, agentDirs = null, neverRun = [], alwaysRun = [] } = {}, wardens = {}) {
  const out = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "#",
    "# The warden team for this repo: who owns what, and what each may run. One file, committed.",
    "# Agent prompts (domain primers) live in .claude/agents/<name>.md. Runtime state lives in .wardens/ (gitignored).",
    "# Docs: https://github.com/tylerjrbuell/wardens",
    "version: 1",
    "",
    "# enforce: deny out-of-authority tool calls and invalid briefs/reports.  warn: record them only (start here).",
    `mode: ${mode}`,
    "",
  ];
  const opt = (comment, key, sample, value) => {
    out.push(`# ${comment}`);
    out.push(value == null ? `# ${key}: ${sample}` : `${key}: ${typeof value === "number" ? value : yamlScalar(value)}`, "");
  };
  opt("Confidence at or above this must be backed by `verification` in the UpwardReport (default 0.7).", "confidence-floor", "0.7", confidenceFloor);
  opt("Read owned globs from an existing [{glob, owner}] map instead of listing them here.", "ownership-file", "tools/ownership.json", ownershipFile);
  if (ledger) opt("Where the hooks write the outcome ledger.", "ledger", "", ledger);
  if (agentDirs) { out.push("# Where agent files live (the plugin's bundled agents are always available).", "agent-dirs:", ...agentDirs.map((d) => `  - ${yamlScalar(d)}`), ""); }
  out.push("# Commands no warden may run, on top of the built-ins (git commit/push/tag/rebase/reset --hard, *publish).");
  out.push(...(neverRun.length ? ["never-run:", ...neverRun.map((c) => `  - ${yamlScalar(c)}`)] : ["# never-run:", "#   - terraform apply"]), "");
  if (alwaysRun.length) out.push("# Read-only commands every warden may run, on top of the built-ins (ls, cat, grep, git diff/log/show...).", "always-run:", ...alwaysRun.map((c) => `  - ${yamlScalar(c)}`), "");
  out.push("wardens:");
  const names = Object.keys(wardens);
  if (!names.length) {
    out.push(
      "  # api-warden:",
      "  #   kind: domain             # domain: owns code | specialist: writes only its own reports",
      "  #   owns:                    # paths it may edit (enforced)",
      "  #     - services/api/**",
      "  #   run:                     # commands it may run, prefix-matched (omit: only never-run is guarded)",
      "  #     - pytest services/api",
      "  #   expires: 2027-03-31      # optional pilot window; `warden doctor` fails after it",
      "",
    );
  }
  return out.join("\n") + (names.length ? "\n" + names.map((n) => emitWarden(n, wardens[n])).join("\n") : "");
}

function ensureGitignored(root) {
  const gi = join(root, ".gitignore");
  const text = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (/^\/?\.wardens\/?\s*$/m.test(text)) return false;
  writeFileSync(gi, text + (text && !text.endsWith("\n") ? "\n" : "") + "\n# wardens runtime state (outcome ledger)\n.wardens/\n");
  return true;
}

/** `warden init`: write a commented starter wardens.yaml and gitignore .wardens/. */
export function initTeam(root, { mode = "warn" } = {}) {
  const file = join(root, CONFIG_PATH);
  if (existsSync(file)) throw new Error(`${CONFIG_PATH} already exists`);
  if (hasLegacyConfig(root)) throw new Error("this repo has v0.2 warden config — run `warden migrate` instead of `init`");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderConfig({ mode }));
  return { file, gitignored: ensureGitignored(root) };
}

/** `warden new`: append a warden to wardens.yaml and create its agent file if there isn't one. */
export function addWarden(root, name, { kind = "domain", owns = [], run = null } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("warden names are kebab-case, e.g. api-warden");
  if (!KINDS.includes(kind)) throw new Error(`--kind must be ${KINDS.join(" | ")}`);
  if (kind === "domain" && !owns.length) throw new Error("a domain warden needs at least one --owns glob");
  const file = join(root, CONFIG_PATH);
  let created = false;
  if (!existsSync(file)) { initTeam(root, {}); created = true; }
  const before = loadTeam(root);
  if (isMap(before.raw.wardens) && name in before.raw.wardens) throw new Error(`${name} is already declared in ${CONFIG_PATH}`);
  const entry = emitWarden(name, { kind, owns, run });
  const original = readFileSync(file, "utf8");
  let text = original;
  const tops = [...text.matchAll(/^([A-Za-z][\w-]*):/gm)].map((m) => m[1]);
  if (!tops.includes("wardens")) text = text.trimEnd() + "\n\nwardens:\n";
  else if (tops.at(-1) !== "wardens") throw new Error(`\`wardens:\` isn't the last section of ${CONFIG_PATH}, so it can't be appended to safely. Add this under \`wardens:\` yourself:\n\n${entry}`);
  text = text.replace(/^wardens:[ \t]*\{\s*\}[ \t]*$/m, "wardens:");
  writeFileSync(file, text.trimEnd() + "\n" + (text.trimEnd().endsWith("wardens:") ? "" : "\n") + entry);
  const after = loadTeam(root);
  const w = after.wardens.get(name);
  if (!w || w.source !== "project" || owns.some((g) => !w.edit.includes(g))) {
    writeFileSync(file, original); // roll back the append
    throw new Error(`appending ${name} did not parse back cleanly; add it by hand:\n\n${entry}`);
  }
  let agentFile = w.agent && !w.agent.bundled ? w.agent.file : null;
  let createdAgent = false;
  if (!agentFile) {
    const tpl = join(PLUGIN_ROOT, "templates", `${kind}.md`);
    agentFile = join(root, after.settings.agentDirs[0] || ".claude/agents", `${name}.md`);
    const scope = owns.map((g) => `\`${g}\``).join(", ") || "its reports";
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, readFileSync(tpl, "utf8").replaceAll("{{name}}", name).replaceAll("{{owns}}", scope));
    createdAgent = true;
  }
  return { file, created, agentFile, createdAgent };
}

/** Remove a top-level `warden:` block from an agent file's frontmatter (v0.2 → v0.3). */
export function stripLegacyBlock(text) {
  const m = text.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return text;
  const lines = m[2].split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^warden:\s*(#.*)?$/.test(lines[i])) {
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return m[1] + out.join("\n") + m[3] + text.slice(m[0].length);
}

/** `warden migrate`: v0.2 frontmatter blocks + .wardens/config.json → one .claude/wardens.yaml. */
export function migrate(root, { dryRun = false } = {}) {
  const file = join(root, CONFIG_PATH);
  if (existsSync(file)) throw new Error(`${CONFIG_PATH} already exists — nothing to migrate into`);
  const cfgFile = join(root, ".wardens", "config.json");
  let legacy = {};
  if (existsSync(cfgFile)) legacy = JSON.parse(readFileSync(cfgFile, "utf8"));
  const agentDirs = Array.isArray(legacy.agentDirs) ? legacy.agentDirs : [".claude/agents"];
  const agents = readAgents(root, agentDirs).filter((a) => !a.bundled);
  const wardens = {};
  for (const a of agents.filter((x) => x.legacyWarden)) {
    const w = a.data.warden;
    wardens[a.name] = { kind: KINDS.includes(w.kind) ? w.kind : "domain", owns: toList(w.edit), run: w.bash == null ? null : toList(w.bash), expires: w.expires ? String(w.expires) : null };
  }
  for (const [name, o] of Object.entries(isMap(legacy.authority) ? legacy.authority : {})) {
    const w = (wardens[name] ||= { kind: "specialist", owns: [], run: null, expires: null });
    if (o.edit) w.owns = toList(o.edit);
    if (o.bash) w.run = toList(o.bash);
  }
  const notes = [];
  const extra = (list, builtins, label) => {
    if (!Array.isArray(list)) return [];
    const dropped = builtins.filter((b) => !list.includes(b));
    if (dropped.length) notes.push(`${label}: v0.3 always includes the built-ins; your config had dropped ${dropped.join(", ")}`);
    return list.filter((c) => !builtins.includes(c));
  };
  const text = renderConfig({
    mode: legacy.mode === "warn" ? "warn" : "enforce",
    confidenceFloor: typeof legacy.confidenceFloor === "number" && legacy.confidenceFloor !== 0.7 ? legacy.confidenceFloor : null,
    ledger: legacy.ledger && legacy.ledger !== ".wardens/ledger.jsonl" ? legacy.ledger : null,
    ownershipFile: legacy.ownershipFile || null,
    agentDirs: Array.isArray(legacy.agentDirs) && JSON.stringify(legacy.agentDirs) !== JSON.stringify([".claude/agents"]) ? legacy.agentDirs : null,
    neverRun: extra(legacy.neverCommands, BUILTIN_NEVER, "never-run"),
    alwaysRun: extra(legacy.alwaysCommands, BUILTIN_ALWAYS, "always-run"),
  }, wardens);
  const stripped = agents.filter((a) => a.legacyWarden).map((a) => a.file);
  if (dryRun) return { text, stripped, removedConfig: existsSync(cfgFile), notes, dryRun };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  for (const f of stripped) writeFileSync(f, stripLegacyBlock(readFileSync(f, "utf8")));
  const removedConfig = existsSync(cfgFile);
  if (removedConfig) unlinkSync(cfgFile);
  const gitignored = ensureGitignored(root);
  return { text, file, stripped, removedConfig, notes, gitignored };
}

// ─── Team view ───────────────────────────────────────────────────────────────

/** Rows for `warden team`: one per warden with its authority and (when the ledger has data) its record. */
export function teamRows(team) {
  const stats = new Map(computeStats(readLedger(team.root, team.settings)).map((s) => [s.warden, s]));
  return [...team.wardens.values()].map((w) => ({
    name: w.name, kind: w.kind, owns: w.edit, run: w.bash, expires: w.expires, source: w.source,
    agent: !w.agent ? null : w.agent.bundled ? `plugin: agents/${basename(w.agent.file)}` : relative(team.root, w.agent.file),
    missions: stats.get(w.name)?.dispatches ?? 0, firstPass: stats.get(w.name)?.firstAttemptRate ?? null,
  }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function flags(argv) {
  const out = { _: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("--")) {
      const key = a.slice(2), val = argv[k + 1] && !argv[k + 1].startsWith("--") ? argv[++k] : true;
      out[key] = key in out ? [].concat(out[key], val) : val;
    } else out._.push(a);
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const root = resolve(f.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  switch (cmd) {
    case "hook": {
      let payload = {};
      try { payload = JSON.parse(readStdin() || "{}"); } catch { return 0; }
      try {
        if (f._[0] === "pre-tool") hookPreTool(payload);
        else if (f._[0] === "subagent-stop") hookSubagentStop(payload);
      } catch (e) {
        record(projectDir(payload), loadTeam(projectDir(payload)).settings, { event: "hook-error", hook: f._[0], error: String(e?.stack || e) });
      }
      return 0; // fail open
    }
    case "init": {
      try {
        const mode = f.mode === "enforce" ? "enforce" : "warn";
        const { file, gitignored } = initTeam(root, { mode });
        console.log(`created ${relative(root, file)} (mode: ${mode})${gitignored ? "\nadded .wardens/ to .gitignore" : ""}`);
        console.log(`next: warden new <name> --owns "<glob>" --run "<test command>"`);
        return 0;
      } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    case "new": {
      const name = f._[0];
      if (!name) { console.error('usage: warden new <name> --owns "<glob>" [--owns "<glob>"] [--run "<cmd>"] [--kind domain|specialist]'); return 2; }
      const owns = [].concat(f.owns ?? f.edit ?? []);
      const run = f.run ?? f.test;
      try {
        const r = addWarden(root, name, { kind: f.kind || "domain", owns, run: run == null ? null : [].concat(run) });
        if (r.created) console.log(`created ${CONFIG_PATH}`);
        console.log(`added ${name} to ${CONFIG_PATH}`);
        console.log(r.createdAgent ? `created ${relative(root, r.agentFile)}: write its domain primer, then run \`warden doctor\`` : `using existing agent ${relative(root, r.agentFile)}`);
        return 0;
      } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    case "team": {
      const team = loadTeam(root);
      const rows = teamRows(team);
      if (f.json) { console.log(JSON.stringify({ config: team.exists ? CONFIG_PATH : null, settings: team.settings, wardens: rows, problems: team.problems }, null, 2)); return 0; }
      const s = team.settings;
      console.log(`${team.exists ? CONFIG_PATH : "(no wardens.yaml; bundled defaults only)"} · mode: ${s.mode} · confidence floor: ${s.confidenceFloor}${s.ownershipFile ? ` · ownership-file: ${s.ownershipFile}` : ""}\n`);
      const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
      const owns = (r) => (r.owns.length ? r.owns[0] + (r.owns.length > 1 ? ` +${r.owns.length - 1}` : "") : "—");
      const width = Math.max(14, ...rows.map((r) => r.name.length)) + 2;
      const ownsWidth = Math.max(8, ...rows.map((r) => owns(r).length)) + 2;
      console.log("warden".padEnd(width) + "kind".padEnd(12) + "owns".padEnd(ownsWidth) + "run".padEnd(6) + "missions".padEnd(10) + "1st-pass".padEnd(10) + "agent");
      for (const r of rows)
        console.log(r.name.padEnd(width) + r.kind.padEnd(12) + owns(r).padEnd(ownsWidth) + (r.run == null ? "any" : String(r.run.length)).padEnd(6) + String(r.missions).padEnd(10) + pct(r.firstPass).padEnd(10) + (r.agent ?? "✗ missing agent file") + (r.expires ? `  · pilot until ${r.expires}` : ""));
      console.log(`\nnever-run: ${s.neverCommands.join(", ")}`);
      if (team.problems.length || !team.exists) console.log(`\n${team.problems.length ? `${team.problems.length} config problem(s)` : `no ${CONFIG_PATH}`}: run \`warden doctor\``);
      return 0;
    }
    case "migrate": {
      try {
        const r = migrate(root, { dryRun: !!f["dry-run"] });
        if (r.dryRun) { process.stdout.write(r.text); console.error(`\n(dry run) would write ${CONFIG_PATH}, strip \`warden:\` from ${r.stripped.length} agent file(s)${r.removedConfig ? ", and delete .wardens/config.json" : ""}`); }
        else {
          console.log(`wrote ${CONFIG_PATH}`);
          for (const s of r.stripped) console.log(`moved authority out of ${relative(root, s)}`);
          if (r.removedConfig) console.log("deleted .wardens/config.json (folded into wardens.yaml)");
          if (r.gitignored) console.log("added .wardens/ to .gitignore");
          console.log("next: warden doctor");
        }
        for (const n of r.notes) console.error(`note: ${n}`);
        return 0;
      } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    case "check": {
      const text = readStdin();
      const kind = f._[0];
      if (kind !== "brief" && kind !== "report") { console.error("usage: warden check brief|report < file"); return 2; }
      const team = loadTeam(root);
      let w = null;
      if (kind === "brief" && f.warden) { w = findWarden(team, f.warden); if (!w) { console.error(`unknown warden ${f.warden}${didYouMean(String(f.warden), [...team.wardens.keys()])}`); return 2; } }
      const errs = kind === "brief" ? validateBrief(extractBlock(text, "mission-brief", "first"), w) : validateReport(extractBlock(text, "upward-report", "last"), team.settings);
      if (!errs.length) { console.log(`✓ valid ${kind}`); return 0; }
      for (const e of errs) console.log(`✗ ${e}`);
      return 1;
    }
    case "doctor": {
      const { findings, wardens, agents } = doctor(root, { today: f.today });
      const icon = { error: "✗", warn: "!", info: "·" };
      for (const x of findings.filter((x) => f.verbose || x.level !== "info")) console.log(`${icon[x.level]} [${x.agent}] ${x.msg}`);
      const errors = findings.filter((x) => x.level === "error").length;
      const warns = findings.filter((x) => x.level === "warn").length;
      console.log(`\n${wardens} warden(s), ${agents} agent file(s) checked — ${errors} error(s), ${warns} warning(s)`);
      return errors || (f.strict && warns) ? 1 : 0;
    }
    case "stats": {
      const stats = computeStats(readLedger(root, loadTeam(root).settings));
      if (f.json) { console.log(JSON.stringify(stats, null, 2)); return 0; }
      if (!stats.length) { console.log("ledger is empty — no warden dispatches recorded yet"); return 0; }
      const pct = (x) => (x == null ? "  —" : `${Math.round(x * 100)}%`.padStart(4));
      console.log("warden".padEnd(22) + "disp  1st-pass  retry  rejected  guard-deny  malformed  avg-conf  outcomes");
      for (const s of stats.sort((a, b) => b.dispatches - a.dispatches))
        console.log(s.warden.padEnd(22) + String(s.dispatches).padStart(4) + pct(s.firstAttemptRate).padStart(10) + String(s.retries).padStart(7) + String(s.rejectedDispatches).padStart(10) + String(s.guardDenials).padStart(12) + String(s.malformed).padStart(11) + (s.meanConfidence == null ? "—" : s.meanConfidence.toFixed(2)).padStart(10) + "  " + Object.entries(s.reports).map(([k, v]) => `${k}:${v}`).join(" "));
      return 0;
    }
    case "route": {
      if (!f._.length) { console.error("usage: warden route <path...>"); return 2; }
      const wardens = [...loadTeam(root).wardens.values()];
      let bad = 0;
      for (const p of f._) {
        const owners = wardens.filter((w) => matchesAny(w.edit, p.replace(/^\.\//, ""))).map((w) => w.name);
        if (owners.length !== 1) bad++;
        console.log(`${p} → ${owners.length ? owners.join(", ") : "UNOWNED (parent owns it, or scaffold a warden)"}${owners.length > 1 ? "  ✗ ambiguous" : ""}`);
      }
      return bad ? 1 : 0;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
