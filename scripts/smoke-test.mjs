#!/usr/bin/env node
/**
 * Self-test for the qa-investigator MCP server (tests the tool, not any target app).
 * Spawns the server over stdio, points it at an in-process fixture HTTP server,
 * and checks tool discovery, safety guards, evidence rules, duplicate detection,
 * verification, reporting and secret redaction. Output goes to a temp runs dir.
 *
 *   npm run build && npm run smoke
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-smoke-"));
const TOKEN = "smoke-secret-token-1234567890";

// fixture: echoes the Authorization header back (to prove redaction) and serves a small page
const fixture = http.createServer((req, res) => {
  if (req.url === "/json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoedAuth: req.headers.authorization ?? null, items: [1, 2, 3] }));
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html lang="en"><head><title>Fixture</title></head><body><h1>Fixture</h1><form><input name="q" placeholder="Search"><button>Go</button></form><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>');
  }
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fixture.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "server.js")],
  cwd: root,
  env: { ...process.env, QA_RUNS_DIR: runsDir, QA_SMOKE_TOKEN: TOKEN },
  stderr: "ignore",
});
const client = new Client({ name: "qa-smoke", version: "0.1.0" });
await client.connect(transport);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: Boolean(r.isError), text, json, structured: r.structuredContent };
};

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["capture_evidence", "generate_qa_report", "inspect_page", "interact_with_page", "investigate_api", "manage_coverage", "record_finding", "start_mission", "verify_finding"];
  check("tool discovery (9 tools)", JSON.stringify(names) === JSON.stringify(expected), names.join(","));
  check("every tool has input schema + description", tools.every((t) => t.inputSchema && t.description));

  let r = await call("inspect_page", { url: `${base}/` });
  check("refuses work without a mission", r.isError && /No active mission/.test(r.text));

  r = await call("start_mission", { name: "smoke wildcard", objective: "should be refused", environment: "smoke", targetUrls: [`${base}/`], allowedHosts: ["*"], authorization: { statement: "smoke test fixture", authorizedBy: "smoke" } });
  check("refuses wildcard host scope", r.isError && /too broad/.test(r.text));

  r = await call("start_mission", { name: "smoke no auth", objective: "should be refused", environment: "smoke", targetUrls: [`${base}/`], authorization: { statement: "", authorizedBy: "" } });
  check("refuses mission without authorization", r.isError && /authorization/i.test(r.text));

  r = await call("start_mission", {
    name: "smoke mission",
    objective: "Self-test of the QA investigator server",
    environment: "smoke fixture",
    targetUrls: [`${base}/`],
    authorization: { statement: "In-process fixture owned by the smoke test", authorizedBy: "smoke-test.mjs" },
    authProfiles: { tester: { type: "bearer", tokenSecret: "QA_SMOKE_TOKEN" } },
  });
  check("starts read-only mission", !r.isError && r.json?.scope?.allowedMethods?.join(",") === "GET,HEAD,OPTIONS", r.isError ? r.text : "");

  r = await call("investigate_api", { requests: [{ method: "GET", url: `${base}/json`, auth: "tester", expect: { status: [200], jsonSchema: { type: "object", required: ["ok", "items"], properties: { items: { type: "array", maxItems: 2 } } } } }] });
  const res0 = r.json?.results?.[0];
  check("API request returns status + evidence id", res0?.status === 200 && /^EV-\d+/.test(res0?.evidenceId ?? ""));
  check("JSON schema violations reported", res0?.expectation?.failures?.some((f) => /maxItems/.test(f)));
  check("echoed credential redacted in tool output", !r.text.includes(TOKEN));
  const evFile = fs.readdirSync(path.join(runsDir)).flatMap((d) => (fs.existsSync(path.join(runsDir, d, "evidence")) ? fs.readdirSync(path.join(runsDir, d, "evidence")).map((f) => path.join(runsDir, d, "evidence", f)) : []));
  check("credential absent from evidence files", evFile.length > 0 && evFile.every((f) => !fs.readFileSync(f, "utf8").includes(TOKEN)));

  r = await call("investigate_api", { requests: [{ method: "POST", url: `${base}/json`, json: {} }] });
  check("state-changing method blocked in read-only mission", r.json?.results?.[0]?.blocked && /not authorised/.test(r.json.results[0].error));

  r = await call("investigate_api", { requests: [{ method: "GET", url: "http://example.invalid/" }] });
  check("out-of-scope host blocked", r.json?.results?.[0]?.blocked && /outside the authorised scope/.test(r.json.results[0].error));

  r = await call("inspect_page", { url: `${base}/` });
  check("browser inspection works", !r.isError && r.json?.title === "Fixture", r.isError ? r.text.slice(0, 200) : "");
  check("a11y heuristics detect unlabeled field + missing alt", r.json?.accessibilityIssues?.some((a) => a.rule === "form-field-no-accessible-name") && r.json?.accessibilityIssues?.some((a) => a.rule === "img-alt-missing"));
  const pageEv = r.json?.evidenceId;

  const finding = { title: "Fixture search field has no accessible name", category: "accessibility", affectedUrl: `${base}/`, severity: "low", severityRationale: "smoke test rationale", priority: "P4", priorityRationale: "smoke test rationale", steps: ["Open fixture"], expected: "Labelled field", expectedSource: "convention: WCAG 1.3.1", actual: "placeholder only", impact: "n/a", scope: "fixture", suggestedFollowUp: "n/a" };
  r = await call("record_finding", { action: "create", finding: { ...finding, evidenceIds: ["EV-999"] } });
  check("finding with unknown evidence refused", r.isError && /Unknown evidence/.test(r.text));
  r = await call("record_finding", { action: "create", finding: { ...finding, evidenceIds: [pageEv] } });
  check("finding recorded as Potential", r.json?.created && r.json?.status === "Potential");
  const fid = r.json?.id;
  r = await call("record_finding", { action: "create", finding: { ...finding, evidenceIds: [pageEv] } });
  check("duplicate finding rejected", r.json?.created === false && r.json?.duplicateOf === fid);

  r = await call("verify_finding", { findingId: fid, method: "api", attempts: 2, api: { request: { method: "GET", url: `${base}/` }, defectSignature: { bodyIncludes: ['placeholder="Search"'], bodyExcludes: ["<label"] } } });
  check("verification confirms reproducible defect", r.json?.status === "Confirmed" && r.json?.reproduced === 2);
  r = await call("verify_finding", { findingId: fid, method: "api", attempts: 1, api: { request: { method: "GET", url: `${base}/` }, defectSignature: { bodyIncludes: ["text-that-is-not-there"] } } });
  check("verification reports Not Reproduced", r.json?.status === "Not Reproduced");
  r = await call("verify_finding", { findingId: fid, method: "api", attempts: 1, api: { request: { method: "GET", url: `${base}/json` }, defectSignature: { jsonPathEquals: [{ path: "$.items[0]", value: 1 }, { path: "items.2", value: 3 }] } } });
  check("JSONPath-style and dotted paths both supported", r.json?.status === "Confirmed", JSON.stringify(r.json?.attemptsDetail?.[0]?.checks ?? r.text));

  await call("manage_coverage", { action: "add_requirements", items: [{ id: "R1", text: "fields labelled", source: "smoke" }] });
  await call("manage_coverage", { action: "add_areas", items: [{ id: "A1", category: "ui", name: "fixture ui", impact: 2, likelihood: 2, rationale: "smoke" }] });
  await call("manage_coverage", { action: "add_scenarios", items: [{ id: "S1", areaId: "A1", title: "labels", technique: "accessibility", requirementIds: ["R1"] }, { id: "S2", areaId: "A1", title: "not run", technique: "positive" }] });
  r = await call("manage_coverage", { action: "record_results", items: [{ scenarioId: "S1", status: "failed" }] });
  check("failed result without observation refused", r.isError);
  r = await call("manage_coverage", { action: "record_results", items: [{ scenarioId: "S1", status: "failed", notes: "unlabeled (via notes alias)", evidenceIds: [pageEv], findingIds: [fid] }] });
  check("'notes' accepted as observation alias", !r.isError, r.isError ? r.text : "");
  r = await call("manage_coverage", { action: "summary" });
  check("coverage metrics use recorded denominators", r.json?.metrics?.scenarioExecution?.numerator === 1 && r.json?.metrics?.scenarioExecution?.denominator === 2 && r.json?.metrics?.requirementsCoverage?.percent === 100);

  r = await call("generate_qa_report", { executiveSummary: "smoke" });
  const written = r.json?.written ?? {};
  check("reports written (html/json/md)", ["html", "json", "md"].every((k) => written[k] && fs.existsSync(written[k])));
  check("no credential in reports", Object.values(written).every((f) => !fs.readFileSync(f, "utf8").includes(TOKEN)));
} catch (err) {
  fail++;
  console.log(`FAIL  unexpected error — ${err?.message ?? err}`);
} finally {
  await client.close().catch(() => undefined);
  fixture.close();
}

console.log(`\n${pass} passed, ${fail} failed  (artifacts: ${runsDir})`);
process.exit(fail ? 1 : 0);
