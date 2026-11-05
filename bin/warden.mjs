#!/usr/bin/env node
// wardens — deterministic enforcement + measurement for bounded Claude Code subagents.
//
// Zero dependencies. Node >= 18.
//
//   warden hook pre-tool        PreToolUse hook: authority guard (inside wardens) + dispatch gate (Agent tool)
//   warden hook subagent-stop   SubagentStop hook: UpwardReport gate + ledger
//   warden doctor               lint warden definitions (overlap, stale anchors, expiry, legacy prose-only authority)
//   warden stats [--json]       outcome metrics from the ledger
//   warden route <path...>      which warden owns a path
//   warden new <name> --edit <glob> [--edit <glob>] [--kind domain|specialist] [--test "<cmd>"]
//   warden check brief|report   validate a MissionBrief / UpwardReport read from stdin
//
// Exit codes: 0 ok, 1 findings/invalid, 2 usage error.
// Hooks fail OPEN on internal errors (a broken guard must never brick a session) but record the error.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, statSync } from "node:fs";
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

const DEFAULT_CONFIG = {
  mode: "enforce", // enforce | warn
  ledger: ".wardens/ledger.jsonl",
  agentDirs: [".claude/agents"],
  // Integration + release belong to the parent thread. Wardens never run these.
  neverCommands: ["git commit", "git push", "git tag", "git rebase", "git reset --hard", "npm publish", "pnpm publish", "yarn publish", "bun publish"],
  // Read-only commands every warden may run regardless of its `bash:` allowlist.
  alwaysCommands: ["cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "echo", "git status", "git diff", "git log", "git show", "git ls-files", "git blame"],
  confidenceFloor: 0.7,
  authority: {}, // per-warden overrides: { "<name>": { edit: [...], bash: [...] } }
  ownershipFile: null, // optional existing ownership map: JSON `[{glob, owner}]` or `{entries: [{glob, owner}]}`
};

export function loadConfig(root) {
  const file = join(root, ".wardens", "config.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) }; }
  catch (e) { return { ...DEFAULT_CONFIG, _error: `invalid .wardens/config.json: ${e.message}` }; }
}

/** Globs per owner from `config.ownershipFile`, so a repo that already maps paths → owners keeps ONE source of truth. */
export function loadOwnership(root, config) {
  const owned = new Map();
  if (!config.ownershipFile) return owned;
  let data;
  try { data = JSON.parse(readFileSync(resolve(root, config.ownershipFile), "utf8")); }
  catch (e) { throw new Error(`ownershipFile ${config.ownershipFile}: ${e.message}`); }
  const rows = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(rows)) throw new Error(`ownershipFile ${config.ownershipFile}: expected an array or {entries: [...]}`);
  for (const r of rows) {
    if (!r || typeof r.glob !== "string" || typeof r.owner !== "string" || !r.owner) continue; // null owner = unowned
    (owned.get(r.owner) || owned.set(r.owner, []).get(r.owner)).push(r.glob);
  }
  return owned;
}

/** Load every agent definition; wardens are the ones with a `warden:` frontmatter block. */
export function loadAgents(root, config = loadConfig(root)) {
  const owned = loadOwnership(root, config);
  const dirs = [...config.agentDirs.map((d) => join(root, d)), join(PLUGIN_ROOT, "agents")];
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
      const w = parsed.data.warden && typeof parsed.data.warden === "object" ? { ...parsed.data.warden } : null;
      if (w) {
        const o = config.authority?.[name] || {};
        w.kind = w.kind || "domain";
        w.edit = [...new Set([...toList(o.edit ?? w.edit), ...(owned.get(name) || [])])];
        w.bash = o.bash ?? w.bash;
        if (w.bash != null) w.bash = toList(w.bash);
      }
      seen.set(name, { name, file, data: parsed.data, body: parsed.body, warden: w, error: parsed.error });
    }
  }
  return [...seen.values()];
}

const toList = (v) => (v == null ? [] : Array.isArray(v) ? v.filter((x) => x != null).map(String) : [String(v)]);

export function findWarden(agents, type) {
  if (!type) return null;
  const short = String(type).split(":").pop();
  return agents.find((a) => a.warden && (a.name === type || a.name === short)) || null;
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
export function validateReport(r, config = DEFAULT_CONFIG) {
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
  const config = loadConfig(root);
  const agents = loadAgents(root, config);
  const base = { session_id: payload.session_id, agent_id: payload.agent_id };

  // 1) Dispatch gate — a warden may only be spawned with a valid, authority-narrowing MissionBrief.
  if (payload.tool_name === "Agent" || payload.tool_name === "Task") {
    const w = findWarden(agents, payload.tool_input?.subagent_type);
    if (!w) return;
    const brief = extractBlock(payload.tool_input?.prompt, "mission-brief", "first");
    const errs = validateBrief(brief, w.warden && { ...w.warden, name: w.name });
    if (errs.length) {
      record(root, config, { ...base, event: "dispatch-rejected", warden: w.name, problems: errs });
      if (config.mode === "enforce") deny(`MissionBrief rejected for ${w.name}:\n- ${errs.join("\n- ")}\nFix the brief (see the mission-brief skill) and re-dispatch.`);
      return;
    }
    record(root, config, { ...base, event: "dispatch", warden: w.name, task: brief.task || payload.tool_input?.description || null, attempt: Number(brief.attempt ?? 1) });
    return;
  }

  // 2) Authority guard — tool calls made inside a warden.
  const w = findWarden(agents, payload.agent_type);
  if (!w) return;
  const reason = checkToolCall({ ...w.warden, name: w.name }, payload.tool_name, payload.tool_input, root, config);
  if (!reason) return;
  record(root, config, { ...base, event: "deny", warden: w.name, tool: payload.tool_name, reason, enforced: config.mode === "enforce" });
  if (config.mode === "enforce") deny(`denied-by-authority (${w.name}): ${reason}. Do not work around this. Finish with an upward-report: status: denied-by-authority, naming the out-of-scope path/command in blockers.`);
}

function hookSubagentStop(payload) {
  const root = projectDir(payload);
  const config = loadConfig(root);
  const w = findWarden(loadAgents(root, config), payload.agent_type);
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

export function doctor(root, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const config = loadConfig(root);
  let owned;
  try { owned = loadOwnership(root, config); }
  catch (e) { return { findings: [{ level: "error", agent: "config", msg: e.message }], wardens: 0, agents: 0 }; }
  // Lint the project's own definitions; bundled plugin agents are linted in the plugin's own CI (root === plugin root).
  const agents = loadAgents(root, config).filter((a) => resolve(root) === resolve(PLUGIN_ROOT) || !a.file.startsWith(join(PLUGIN_ROOT, "agents")));
  const findings = [];
  const add = (level, agent, msg) => findings.push({ level, agent, msg });
  if (config._error) add("error", "config", config._error);
  const files = trackedFiles(root);
  const lineCount = new Map();

  const exists = (p) => {
    if (existsSync(join(root, p))) return join(root, p);
    if (files) { const hit = files.find((f) => f === p || f.endsWith("/" + p)); return hit ? join(root, hit) : null; }
    return null;
  };

  const wardens = agents.filter((a) => a.warden);
  for (const a of agents) {
    if (a.error) { add("error", a.name, `cannot parse: ${a.error}`); continue; }
    const looksLikeWarden = /-warden$|scribe$/.test(a.name) || /upward-report|mission-brief/i.test(a.body);
    if (!a.warden) {
      if (looksLikeWarden) add("warn", a.name, "authority is prose-only (no `warden:` frontmatter) — hooks cannot enforce it");
      else continue;
    } else {
      const w = a.warden;
      if (!["domain", "specialist"].includes(w.kind)) add("error", a.name, `warden.kind must be domain | specialist (got ${w.kind})`);
      if (w.kind === "domain" && !w.edit.length) add("error", a.name, "domain warden has no `warden.edit` globs");
      const tools = String(a.data.tools || "");
      if (tools && w.edit.length && !/\b(Edit|Write|MultiEdit)\b/.test(tools)) add("warn", a.name, "has edit authority but no Edit/Write tool");
      if (tools && !w.edit.length && /\b(Edit|Write|MultiEdit)\b/.test(tools)) add("warn", a.name, "has Edit/Write tool but no edit authority (every edit will be denied)");
      if (w.expires && String(w.expires) < today) add("error", a.name, `pilot expired ${w.expires} — ratify (remove \`expires\`) or remove the warden`);
      if (w.bash == null) add("info", a.name, "no `warden.bash` allowlist — only never-commands and redirects are guarded");
    }
    // Stale anchors: backticked repo paths (optionally :line) mentioned in the primer.
    const seen = new Set();
    // Lines that document a deliberate deletion ("removed in W25 — do not recreate") are tombstones, not anchors.
    const TOMBSTONE = /\b(removed|deleted|do not recreate|no longer exists)\b/i;
    const scanned = a.body.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !TOMBSTONE.test(l)).join("\n");
    for (const m of scanned.matchAll(/`([\w@.\-]+(?:\/[\w@.\-]+)+\.[A-Za-z]{1,6})(?::(\d+))?(?:-\d+)?`/g)) {
      const [, p, line] = m;
      if (seen.has(p + line)) continue; seen.add(p + line);
      if (p.startsWith(".wardens/")) continue; // runtime config/outputs, may not exist yet
      const hit = exists(p);
      if (!hit) { add("warn", a.name, `stale anchor: \`${p}\` not found`); continue; }
      if (line) {
        if (!lineCount.has(hit)) { try { lineCount.set(hit, statSync(hit).isFile() ? readFileSync(hit, "utf8").split("\n").length : Infinity); } catch { lineCount.set(hit, Infinity); } }
        if (Number(line) > lineCount.get(hit)) add("warn", a.name, `stale anchor: \`${p}:${line}\` is past end of file (${lineCount.get(hit)} lines)`);
      }
    }
  }
  for (const owner of owned.keys())
    if (!wardens.some((a) => a.name === owner)) add("warn", "config", `ownershipFile names owner \`${owner}\` but no agent with a \`warden:\` block has that name — its paths are unenforced`);
  // Ownership overlap between domain wardens → ambiguous routing.
  const domain = wardens.filter((a) => a.warden.kind === "domain");
  for (let x = 0; x < domain.length; x++) for (let y = x + 1; y < domain.length; y++)
    for (const ga of domain[x].warden.edit) for (const gb of domain[y].warden.edit)
      if (globsOverlap(ga, gb)) add("error", `${domain[x].name} × ${domain[y].name}`, `edit authority overlaps (${ga} ∩ ${gb}) — routing is ambiguous`);
  return { findings, wardens: wardens.length, agents: agents.length };
}

// ─── Scaffolding ─────────────────────────────────────────────────────────────

function scaffold(root, name, { kind = "domain", edit = [], test = [] }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("name must be kebab-case");
  if (kind === "domain" && !edit.length) throw new Error("a domain warden needs at least one --edit glob");
  const tpl = join(PLUGIN_ROOT, "templates", `${kind}.md`);
  if (!existsSync(tpl)) throw new Error(`no template for kind ${kind}`);
  const out = join(root, ".claude", "agents", `${name}.md`);
  if (existsSync(out)) throw new Error(`${relative(root, out)} already exists`);
  const yamlList = (xs, pad) => (xs.length ? xs.map((x) => `\n${pad}- ${JSON.stringify(x)}`).join("") : " []");
  const text = readFileSync(tpl, "utf8")
    .replaceAll("{{name}}", name)
    .replaceAll("{{edit-yaml}}", yamlList(edit, "    "))
    .replaceAll("{{bash-yaml}}", yamlList(test, "    "))
    .replaceAll("{{edit-list}}", edit.map((g) => `\`${g}\``).join(", ") || "none");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return out;
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
        record(projectDir(payload), loadConfig(projectDir(payload)), { event: "hook-error", hook: f._[0], error: String(e?.stack || e) });
      }
      return 0; // fail open
    }
    case "check": {
      const text = readStdin();
      const kind = f._[0];
      if (kind !== "brief" && kind !== "report") { console.error("usage: warden check brief|report < file"); return 2; }
      const config = loadConfig(root);
      let w = null;
      if (kind === "brief" && f.warden) { const a = findWarden(loadAgents(root, config), f.warden); w = a && { ...a.warden, name: a.name }; if (!w) { console.error(`unknown warden ${f.warden}`); return 2; } }
      const errs = kind === "brief" ? validateBrief(extractBlock(text, "mission-brief", "first"), w) : validateReport(extractBlock(text, "upward-report", "last"), config);
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
      console.log(`\n${wardens} warden(s) of ${agents} agent file(s) checked — ${errors} error(s), ${warns} warning(s)`);
      return errors || (f.strict && warns) ? 1 : 0;
    }
    case "stats": {
      const stats = computeStats(readLedger(root, loadConfig(root)));
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
      const wardens = loadAgents(root).filter((a) => a.warden);
      let bad = 0;
      for (const p of f._) {
        const owners = wardens.filter((a) => matchesAny(a.warden.edit, p.replace(/^\.\//, ""))).map((a) => a.name);
        if (owners.length !== 1) bad++;
        console.log(`${p} → ${owners.length ? owners.join(", ") : "UNOWNED (parent owns it, or scaffold a warden)"}${owners.length > 1 ? "  ✗ ambiguous" : ""}`);
      }
      return bad ? 1 : 0;
    }
    case "new": {
      const name = f._[0];
      if (!name) { console.error("usage: warden new <name> --edit <glob> [--edit <glob>] [--kind domain|specialist] [--test <cmd>]"); return 2; }
      try {
        const out = scaffold(root, name, { kind: f.kind || "domain", edit: [].concat(f.edit || []), test: [].concat(f.test || []) });
        console.log(`created ${relative(root, out)} — fill in the domain primer, then run \`warden doctor\``);
        return 0;
      } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
