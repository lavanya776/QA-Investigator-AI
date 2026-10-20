#!/usr/bin/env node
/**
 * Local web UI for QA Investigator AI.
 *
 * The UI does not talk to the MCP server directly and contains no agent logic.
 * "Start investigation" launches a headless Claude Code session (`claude -p`,
 * the user's existing subscription) that loads ONLY the project's .mcp.json and
 * may call ONLY the qa-investigator tools. Progress shown in the UI comes from
 * two real sources: Claude Code's stream-json events and the MCP server's own
 * runs/<mission>/state.json. Results and reports are read from runs/ and examples/.
 *
 *   npm start       -> builds the MCP server, then serves http://127.0.0.1:4300
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "ui", "public");
const SOURCES = { runs: path.join(ROOT, "runs"), examples: path.join(ROOT, "examples") };
const UI_LOGS = path.join(ROOT, "runs", "_ui");
const PORT = Number(process.env.QA_UI_PORT ?? 4300);
const HOST = "127.0.0.1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const MAX_TURNS = Number(process.env.QA_UI_MAX_TURNS ?? 150);

const QA_TOOLS = ["start_mission", "inspect_page", "interact_with_page", "capture_evidence", "investigate_api", "record_finding", "verify_finding", "manage_coverage", "generate_qa_report"].map((t) => `mcp__qa-investigator__${t}`);
const SCOPES = ["functional", "ui", "api", "security", "integration"];
const ENVIRONMENTS = ["local", "staging", "production"];

// --------------------------------------------------------------- run state
let current = null; // one investigation at a time

function pushEvent(run, ev) {
  run.events.push({ i: run.events.length, at: new Date().toISOString(), ...ev });
}

function shortJson(value, max = 220) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const arr = (v) => (Array.isArray(v) ? v : []);

function summariseToolInput(name, input = {}) {
  input = input && typeof input === "object" ? input : {};
  switch (name) {
    case "start_mission": return `${input.name ?? ""} → ${arr(input.targetUrls).join(", ")}`;
    case "inspect_page": return input.url ?? "(current page)";
    case "interact_with_page": return `${arr(input.actions).map((a) => a.type).join(", ")}${input.session ? ` [${input.session}]` : ""}`;
    case "capture_evidence": return `${arr(input.kinds).join(", ")} — ${input.label ?? ""}`;
    case "investigate_api": return arr(input.requests).map((r) => `${r.method} ${String(r.url).replace(/^https?:\/\/[^/]+/, "")}`).join(" | ");
    case "record_finding": return `${input.action} ${input.finding?.title ?? input.findingId ?? ""}`;
    case "verify_finding": return `${input.findingId} via ${input.method}`;
    case "manage_coverage": return `${input.action}${Array.isArray(input.items) ? ` (${input.items.length})` : ""}`;
    case "generate_qa_report": return "write HTML / JSON / Markdown reports";
    default: return shortJson(input);
  }
}

function summariseToolResult(name, text, isError) {
  if (isError) return text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    if (name === "start_mission") return `mission ${j.missionId}`;
    if (name === "inspect_page") return `${j.title} · ${j.accessibilityIssues?.length ?? 0} a11y issues · ${j.evidenceId}`;
    if (name === "investigate_api") return (j.results ?? []).map((r) => (r.blocked ? `blocked: ${r.error}` : `${r.status} ${r.evidenceId}`)).join(" | ");
    if (name === "record_finding") return j.created === false ? `duplicate of ${j.duplicateOf}` : j.id ? `${j.id} ${j.status}` : j.findings ? `${j.findings.length} findings` : shortJson(j);
    if (name === "verify_finding") return `${j.findingId} → ${j.status} (${j.reproduced}/${j.attempts})`;
    if (name === "interact_with_page") return `${(j.steps ?? []).filter((s) => s.ok).length}/${(j.steps ?? []).length} steps ok · ${j.finalUrl}`;
    if (name === "capture_evidence") return (j.evidence ?? []).map((e) => e.id).join(", ");
    if (name === "generate_qa_report") return "reports written";
    return shortJson(j, 160);
  } catch {
    return text.slice(0, 200);
  }
}

function handleStreamLine(run, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "system" && msg.subtype === "init") {
    const qa = (msg.mcp_servers ?? []).find((s) => s.name === "qa-investigator");
    const toolCount = (msg.tools ?? []).filter((t) => t.startsWith("mcp__qa-investigator__")).length;
    run.mcpStatus = qa?.status ?? "missing";
    pushEvent(run, { kind: "system", text: `Claude Code ${msg.claude_code_version ?? ""} started · model ${msg.model} · qa-investigator ${run.mcpStatus} (${toolCount} tools)` });
    if (run.mcpStatus !== "connected") pushEvent(run, { kind: "error", text: "qa-investigator MCP server did not connect. Run `npm run build` and check `claude mcp list`." });
    return;
  }
  if (msg.type === "assistant") {
    for (const c of msg.message?.content ?? []) {
      if (c.type === "text" && c.text.trim()) pushEvent(run, { kind: "thought", text: c.text.trim() });
      if (c.type === "tool_use") {
        const name = c.name.replace("mcp__qa-investigator__", "");
        run.pendingTools.set(c.id, name);
        pushEvent(run, { kind: "tool", tool: name, text: summariseToolInput(name, c.input) });
      }
    }
    return;
  }
  if (msg.type === "user") {
    for (const c of msg.message?.content ?? []) {
      if (c.type !== "tool_result") continue;
      const name = run.pendingTools.get(c.tool_use_id) ?? "tool";
      const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("\n") : String(c.content ?? "");
      if (name === "start_mission" && !c.is_error) {
        try {
          const id = JSON.parse(text).missionId;
          if (id) run.missionId = id;
        } catch {}
      }
      pushEvent(run, { kind: c.is_error ? "tool-error" : "tool-result", tool: name, text: summariseToolResult(name, text, c.is_error) });
    }
    return;
  }
  if (msg.type === "result") {
    run.result = { subtype: msg.subtype, isError: msg.is_error, turns: msg.num_turns, durationMs: msg.duration_ms, text: msg.result, denials: (msg.permission_denials ?? []).length };
    pushEvent(run, { kind: msg.is_error ? "error" : "done", text: `Claude Code finished (${msg.subtype}, ${msg.num_turns} turns${run.result.denials ? `, ${run.result.denials} tool calls denied` : ""}).` });
    if (msg.result) pushEvent(run, { kind: "thought", text: msg.result });
  }
}

// One malformed or unexpected event must never take down the UI server.
function safeHandle(run, line) {
  try {
    handleStreamLine(run, line);
  } catch (err) {
    pushEvent(run, { kind: "stderr", text: `UI could not display one event: ${err.message}` });
  }
}

function buildPrompt(f) {
  const host = new URL(f.url).host;
  const hosts = [host, ...f.extraHosts.filter((h) => h && h !== host)];
  const stateChanging = !f.readOnly;
  return `You are a senior QA investigator. Use ONLY the qa-investigator MCP tools. Do not read files, do not run shell commands, and never generate test automation scripts.

Mission parameters (use exactly; do not widen scope):
- Target URL: ${f.url}
- Allowed hosts: ${JSON.stringify(hosts)}
- Environment: ${f.environment}
- Authorization statement: ${JSON.stringify(f.authorization)}
- Authorized by: "${f.authorizedBy}"
- allowStateChanging: ${stateChanging}${stateChanging ? "" : " (read-only: GET/HEAD/OPTIONS only; do not submit forms that create, change or delete data)"}
- Testing scope: ${f.scope.join(", ")}
- Objective: ${f.objective}

Workflow:
1. Call start_mission with the parameters above (name: "${f.name}", objective, environment, targetUrls [${JSON.stringify(f.url)}], allowedHosts, authorization {statement, authorizedBy}, allowStateChanging). If start_mission refuses, stop and explain why.
2. Understand the application: inspect the start page, look for requirements/help/API documentation links and in-scope API calls made by the pages. Record requirements only if a real source exists (cite it); never invent them. Register API endpoints you find (manage_coverage add_endpoints from documentation, import_network_endpoints after browsing) so endpoint coverage is measurable.
3. Plan with manage_coverage: risk-scored areas only for the selected scope categories, and scenarios (positive, negative, boundary, exception, recovery, integration, security, accessibility as relevant).
4. Investigate in risk order with inspect_page, interact_with_page, investigate_api and capture_evidence. Adapt to what you find. Security checks must be safe and non-destructive.
5. Record findings only with captured evidence (record_finding), then verify each (verify_finding).
6. Record every scenario result with manage_coverage record_results, including blocked / not_tested with reasons.
7. Finish with generate_qa_report (executive summary, risk statement, limitations, next investigations). Never claim complete coverage.

If something needs credentials you were not given, record it as blocked. Keep your final reply to a short summary.`;
}

function validate(body) {
  const errors = [];
  let url;
  try {
    url = new URL(String(body.url ?? "").trim());
    if (!/^https?:$/.test(url.protocol)) errors.push("Website URL must start with http:// or https://");
  } catch {
    errors.push("Website URL is not a valid absolute URL");
  }
  const authorization = String(body.authorization ?? "").trim();
  if (authorization.length < 10) errors.push("Authorization statement is required (at least 10 characters)");
  const authorizedBy = String(body.authorizedBy ?? "").trim();
  if (!authorizedBy) errors.push("Authorized by is required");
  const environment = String(body.environment ?? "");
  if (!ENVIRONMENTS.includes(environment)) errors.push("Choose an environment");
  const scope = (Array.isArray(body.scope) ? body.scope : []).filter((s) => SCOPES.includes(s));
  if (!scope.length) errors.push("Select at least one testing scope");
  const objective = String(body.objective ?? "").trim();
  if (objective.length < 10) errors.push("Testing objective is required (at least 10 characters)");
  // Production is always read-only from the UI.
  const readOnly = environment === "production" ? true : body.readOnly !== false;
  const extraHosts = String(body.extraHosts ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of extraHosts) if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(h) || /^\*\.[a-z]+$/.test(h)) errors.push(`Invalid or too broad host: ${h}`);
  return { errors, form: { url: url?.toString(), authorization, authorizedBy, environment, scope, objective, readOnly, extraHosts, name: `UI ${url?.host ?? "investigation"}` } };
}

function startRun(form) {
  const id = randomUUID().slice(0, 8);
  const run = { id, form, status: "running", startedAt: new Date().toISOString(), events: [], pendingTools: new Map(), missionId: null, mcpStatus: null, result: null, proc: null };
  fs.mkdirSync(UI_LOGS, { recursive: true });
  const log = fs.createWriteStream(path.join(UI_LOGS, `${id}.jsonl`));
  const args = ["-p", "--mcp-config", path.join(ROOT, ".mcp.json"), "--strict-mcp-config", "--allowedTools", QA_TOOLS.join(","), "--output-format", "stream-json", "--verbose", "--max-turns", String(MAX_TURNS)];
  const proc = spawn(CLAUDE, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  run.proc = proc;
  pushEvent(run, { kind: "system", text: `Launching headless Claude Code (run ${id}); only qa-investigator tools are allowed.` });
  let buf = "";
  proc.stdout.on("data", (d) => {
    log.write(d);
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      safeHandle(run, buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  proc.stderr.on("data", (d) => {
    const t = d.toString("utf8").trim();
    if (t) pushEvent(run, { kind: "stderr", text: t.slice(0, 400) });
  });
  proc.on("error", (err) => {
    run.status = "failed";
    pushEvent(run, { kind: "error", text: `Could not start Claude Code (${err.message}). Is \`claude\` on PATH?` });
  });
  proc.on("close", (code) => {
    if (buf.trim()) safeHandle(run, buf);
    log.end();
    if (run.status === "running") run.status = run.cancelled ? "cancelled" : code === 0 && run.result && !run.result.isError ? "completed" : "failed";
    run.finishedAt = new Date().toISOString();
    if (!run.missionId) pushEvent(run, { kind: "error", text: "No mission was started, so no findings or report exist for this run." });
    pushEvent(run, { kind: "system", text: `Run ${run.status} (exit code ${code}).` });
  });
  proc.stdin.end(buildPrompt(form));
  current = run;
  return run;
}

// ---------------------------------------------------------- reading results
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listRuns() {
  const out = [];
  for (const [source, dir] of Object.entries(SOURCES)) {
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      const state = readJson(path.join(dir, id, "state.json"));
      if (!state?.mission) continue;
      const f = state.findings ?? [];
      out.push({
        source,
        id,
        name: state.mission.name,
        target: state.mission.targetUrls?.[0],
        environment: state.mission.environment,
        createdAt: state.mission.createdAt,
        findings: f.length,
        bySeverity: countBy(f.map((x) => x.severity)),
        byStatus: countBy(f.map((x) => x.status)),
        scenarios: state.scenarios?.length ?? 0,
        hasReport: fs.existsSync(path.join(dir, id, "report.html")),
      });
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function countBy(values) {
  const o = {};
  for (const v of values) o[v] = (o[v] ?? 0) + 1;
  return o;
}

async function runDetail(source, id) {
  const dir = SOURCES[source];
  if (!dir || !/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const state = readJson(path.join(dir, id, "state.json"));
  if (!state?.mission) return null;
  let coverage = null;
  try {
    const { computeCoverage } = await import(new URL("../dist/coverage/coverage.js", import.meta.url));
    coverage = computeCoverage(state);
  } catch (err) {
    coverage = { error: `Coverage unavailable (${err.message}). Run npm run build.` };
  }
  const evidence = Object.fromEntries((state.evidence ?? []).map((e) => [e.id, { kind: e.kind, file: e.file, label: e.label }]));
  const m = state.mission;
  return {
    source,
    id,
    // never return auth profile contents; secret NAMES are not needed by the UI either
    mission: { name: m.name, objective: m.objective, environment: m.environment, targetUrls: m.targetUrls, allowedHosts: m.allowedHosts, allowedMethods: m.allowedMethods, authorization: m.authorization, createdAt: m.createdAt, authProfiles: Object.keys(m.authProfiles ?? {}) },
    counters: state.counters,
    findings: state.findings ?? [],
    evidence,
    coverage,
    scenarios: state.scenarios ?? [],
    activity: state.activity ?? [],
    limitations: state.limitations ?? [],
    hasReport: fs.existsSync(path.join(dir, id, "report.html")),
  };
}

// ------------------------------------------------------------------ http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, base, rel) {
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base) + path.sep) && full !== path.resolve(base)) return send(res, 403, { error: "forbidden" });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: "not found" });
  // state.json is internal; the UI reads it via /api only
  if (path.basename(full) === "state.json" || full.includes(`${path.sep}.qa-secrets`)) return send(res, 403, { error: "forbidden" });
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] ?? "application/octet-stream");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sameOrigin(req) {
  // Blocks other websites from starting investigations through this local server.
  const origin = req.headers.origin;
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

// Stops a Claude Code run together with the MCP server and browser it spawned.
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
  else proc.kill("SIGTERM");
}

function checkClaude() {
  const r = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
const claudeVersion = checkClaude();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === "/api/status" && req.method === "GET") {
      return send(res, 200, {
        claude: claudeVersion,
        built: fs.existsSync(path.join(ROOT, "dist", "server.js")),
        mcpConfig: fs.existsSync(path.join(ROOT, ".mcp.json")),
        running: current?.status === "running" ? current.id : null,
      });
    }
    if (p === "/api/investigations" && req.method === "POST") {
      if (!sameOrigin(req) || !String(req.headers["content-type"]).includes("application/json")) return send(res, 403, { error: "Requests must come from the QA Investigator UI" });
      if (current?.status === "running") return send(res, 409, { error: "An investigation is already running. Wait for it or cancel it." });
      if (!claudeVersion) return send(res, 503, { error: "Claude Code CLI (`claude`) was not found on PATH." });
      if (!fs.existsSync(path.join(ROOT, "dist", "server.js"))) return send(res, 503, { error: "MCP server not built. Run: npm run build" });
      const { errors, form } = validate(await readBody(req));
      if (errors.length) return send(res, 400, { errors });
      const run = startRun(form);
      return send(res, 201, { id: run.id });
    }
    if (p === "/api/investigations/current" && req.method === "GET") {
      if (!current) return send(res, 200, { run: null });
      const since = Number(url.searchParams.get("since") ?? 0);
      let missionActivity = [];
      if (current.missionId) missionActivity = readJson(path.join(SOURCES.runs, current.missionId, "state.json"))?.activity ?? [];
      const { proc, pendingTools, ...pub } = current;
      return send(res, 200, { run: { ...pub, events: current.events.slice(since), totalEvents: current.events.length, missionActivity: missionActivity.slice(-15) } });
    }
    if (p === "/api/investigations/current/cancel" && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "forbidden" });
      if (current?.status !== "running") return send(res, 409, { error: "No investigation is running" });
      current.cancelled = true;
      current.status = "cancelled";
      pushEvent(current, { kind: "error", text: "Cancelled by user." });
      killTree(current.proc);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/runs" && req.method === "GET") return send(res, 200, { runs: listRuns() });
    let m = p.match(/^\/api\/runs\/(runs|examples)\/([^/]+)$/);
    if (m && req.method === "GET") {
      const d = await runDetail(m[1], decodeURIComponent(m[2]));
      return d ? send(res, 200, d) : send(res, 404, { error: "run not found" });
    }
    m = p.match(/^\/files\/(runs|examples)\/([A-Za-z0-9._-]+)\/(.+)$/);
    if (m && req.method === "GET") return serveFile(res, path.join(SOURCES[m[1]], m[2]), decodeURIComponent(m[3]));
    if (req.method === "GET") return serveFile(res, PUBLIC, p === "/" ? "index.html" : p.slice(1));
    return send(res, 405, { error: "method not allowed" });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop the other process or set QA_UI_PORT.` : `UI server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`QA Investigator UI: http://${HOST}:${PORT}`);
  console.log(claudeVersion ? `Claude Code: ${claudeVersion}` : "WARNING: `claude` not found on PATH; investigations cannot start.");
  console.log("Press Ctrl+C to stop. A running investigation is stopped with it.");
});

// Ctrl+C / termination: stop any running investigation (Claude Code, MCP server, browser), then exit.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (current?.status === "running") {
    current.cancelled = true;
    current.status = "cancelled";
    pushEvent(current, { kind: "error", text: `UI server stopped (${signal}).` });
    killTree(current.proc);
  }
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
