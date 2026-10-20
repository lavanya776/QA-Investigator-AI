import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMission } from "../core/mission.js";
import { logActivity, requireMission } from "../core/store.js";
import { redactText } from "../core/redact.js";
import { errorMessage, normalizePath } from "../core/util.js";
import { inspectPage, interact, captureEvidence } from "../browser/operations.js";
import { engine } from "../browser/engine.js";
import { investigateApi } from "../api/http.js";
import { recordFinding, updateFinding, listFindings, getFinding, verifyFinding } from "../findings/findings.js";
import { addAreas, addEndpoints, addRequirements, addScenarios, computeCoverage, listCoverage, recordResults } from "../coverage/coverage.js";
import { generateReport } from "../report/report.js";

// ------------------------------------------------------------------ schemas

const browserName = z.enum(["chromium", "firefox", "webkit"]);
const viewport = z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) });
const sessionFields = {
  session: z.string().max(40).optional().describe("Named browser session (one per test identity), default 'default'. Sessions keep cookies, storage and logs."),
  browser: browserName.optional().describe("Browser engine for a NEW session (default chromium). Unavailable engines return an error to record as Blocked."),
  viewport: viewport.optional(),
};

const target = z
  .object({
    selector: z.string().optional().describe("CSS/Playwright selector (e.g. one returned by inspect_page)"),
    role: z.string().optional().describe("ARIA role, e.g. button, link, textbox"),
    name: z.string().optional().describe("Accessible name used with role"),
    label: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.string().optional(),
    testId: z.string().optional(),
    nth: z.number().int().min(0).optional(),
    exact: z.boolean().optional(),
  })
  .describe("How to locate the element. Prefer role+name or label (what a user perceives).");

const action = z.object({
  type: z.enum(["navigate", "click", "fill", "clear", "select", "check", "uncheck", "press", "hover", "scroll", "wait", "setViewport", "goBack", "goForward", "reload", "simulateNetwork", "clearSimulations", "clearSession"]),
  url: z.string().optional(),
  target: target.optional(),
  value: z.string().optional(),
  secretRef: z.string().optional().describe("Fill with a secret resolved server-side by name (never echoed)."),
  useProbeMarker: z.boolean().optional().describe("Append a server-generated inert marker to the filled value, for reflection checks."),
  key: z.string().optional(),
  repeat: z.number().int().min(1).max(5).optional().describe("click: rapid repeated clicks (duplicate-submission checks); press: repeat key"),
  intervalMs: z.number().int().min(0).max(2000).optional(),
  ms: z.number().int().min(0).max(30000).optional(),
  waitFor: z.object({ target: target.optional(), state: z.enum(["visible", "hidden", "attached", "detached"]).optional(), urlIncludes: z.string().optional() }).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  y: z.number().optional(),
  simulation: z
    .object({ urlIncludes: z.string().min(1), mode: z.enum(["abort", "status", "delay"]), status: z.number().int().optional(), body: z.string().max(4000).optional(), delayMs: z.number().int().max(30000).optional() })
    .optional()
    .describe("Fault injection applied only inside this investigator's browser session (dependency failure / slowness)."),
  clearCookies: z.boolean().optional(),
  clearStorage: z.boolean().optional(),
});

const apiExpect = z
  .object({
    status: z.array(z.number().int()).optional(),
    jsonSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema subset (type, required, properties, items, enum, min/max, pattern, format)"),
    headersPresent: z.array(z.string()).optional(),
    headersAbsent: z.array(z.string()).optional(),
    bodyIncludes: z.array(z.string()).optional(),
    bodyExcludes: z.array(z.string()).optional(),
    maxDurationMs: z.number().int().optional(),
  })
  .describe("Expected behaviour (from requirements/docs). Mismatches are reported, not auto-filed as findings.");

const apiRequest = z.object({
  label: z.string().max(120).optional(),
  method: z.string(),
  url: z.string().describe("Absolute URL inside the mission scope. '{{probe}}' is replaced by an inert marker when useProbeMarker=true."),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  json: z.unknown().optional(),
  body: z.string().optional().describe("Raw body (e.g. malformed JSON for negative tests)"),
  contentType: z.string().optional(),
  auth: z.string().optional().describe("Auth profile name defined in start_mission"),
  authMode: z.enum(["valid", "none", "invalid"]).optional(),
  origin: z.string().optional().describe("Origin header for CORS observation"),
  followRedirects: z.boolean().optional(),
  useProbeMarker: z.boolean().optional(),
  expect: apiExpect.optional(),
  repeat: z.number().int().min(1).max(5).optional().describe("Send the identical request N times (idempotency / duplicate checks)"),
});

const authProfile = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), tokenSecret: z.string() }),
  z.object({ type: z.literal("basic"), usernameSecret: z.string(), passwordSecret: z.string() }),
  z.object({ type: z.literal("header"), headerName: z.string(), valueSecret: z.string() }),
  z.object({ type: z.literal("login"), loginUrl: z.string(), usernameField: z.string().optional(), passwordField: z.string().optional(), usernameSecret: z.string(), passwordSecret: z.string(), tokenPath: z.string().optional() }),
]);

const severity = z.enum(["critical", "high", "medium", "low", "info"]);
const findingCategory = z.enum(["functional", "data-integrity", "business-rule", "ui", "usability", "accessibility", "api", "security", "integration", "resilience", "performance", "compatibility"]);

// ------------------------------------------------------------------ helpers

type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

async function run(tool: string, summary: string, fn: () => Promise<unknown> | unknown): Promise<Result> {
  try {
    const result = (await fn()) as Record<string, unknown>;
    logActivity(tool, summary);
    return { content: [{ type: "text", text: redactText(JSON.stringify(result, null, 1)) }], structuredContent: result };
  } catch (err) {
    const msg = redactText(errorMessage(err));
    logActivity(tool, `ERROR ${summary}: ${msg}`);
    const scope = err instanceof Error && err.name === "ScopeError";
    return { isError: true, content: [{ type: "text", text: `${scope ? "SCOPE/SAFETY STOP: " : "Error: "}${msg}` }] };
  }
}

// Output schemas are loose objects: strict MCP clients validate structuredContent
// against them, and results carry more fields than the guaranteed core.
const loose = z.looseObject({ ok: z.boolean().optional() });

// ------------------------------------------------------------------ tools

export function registerTools(server: McpServer): void {
  server.registerTool(
    "start_mission",
    {
      title: "Start (or resume) an authorised QA investigation mission",
      description:
        "Defines the authorised scope before any investigation: target URLs, allowed hosts, environment, authorization statement, allowed HTTP methods, limits and auth profiles (secrets referenced by NAME only). Every other tool refuses to run without an active mission. Creates runs/<missionId>/ with state, evidence and reports. If the user has not clearly authorised the target, do not call this — ask first.",
      inputSchema: {
        name: z.string().min(3),
        objective: z.string().min(10).describe("Business purpose of the app and what this investigation should establish"),
        environment: z.string().describe("e.g. 'local demo', 'staging v2.3'"),
        targetUrls: z.array(z.string()).min(1),
        allowedHosts: z.array(z.string()).optional().describe("Host[:port] patterns; defaults to the hosts of targetUrls. '*.x.y' allowed; bare '*' refused."),
        authorization: z.object({ statement: z.string(), authorizedBy: z.string(), scopeNotes: z.string().optional() }),
        allowStateChanging: z.boolean().optional().describe("Allow POST/PUT/PATCH/DELETE (only for test environments where this is approved)"),
        allowedMethods: z.array(z.string()).optional(),
        outOfScope: z.array(z.string()).optional().describe("URL substrings that must never be requested (e.g. '/admin/delete', 'payments')"),
        limits: z.object({ maxRequests: z.number().int().optional(), minIntervalMs: z.number().int().optional(), timeoutMs: z.number().int().optional(), maxResponseBytes: z.number().int().optional(), maxBrowserActions: z.number().int().optional() }).optional(),
        authProfiles: z.record(z.string(), authProfile).optional(),
        resumeMissionId: z.string().optional().describe("Resume a saved mission instead of creating one"),
      },
      outputSchema: z.looseObject({ missionId: z.string(), runDir: z.string() }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => run("start_mission", `mission "${args.name}" on ${args.targetUrls.join(", ")}`, () => startMission(args as never)),
  );

  server.registerTool(
    "inspect_page",
    {
      title: "Inspect page structure and state",
      description:
        "Loads (optional url) and inspects the current page in a browser session: title, headings, links, buttons, forms and fields (labels, required, constraints, validity), messages/alerts, loading indicators, accessibility heuristics (missing alt, unlabeled fields, nameless controls, duplicate ids, heading skips, lang), layout (horizontal overflow, overlapping controls), console errors and API calls made by the page. Options: tabStops (keyboard focus order + focus-indicator check), checkLinks (status of in-scope links), marker (check reflection of a probe marker). Saves the snapshot as evidence.",
      inputSchema: {
        ...sessionFields,
        url: z.string().optional(),
        maxItems: z.number().int().min(5).max(150).optional(),
        tabStops: z.number().int().min(0).max(40).optional(),
        checkLinks: z.boolean().optional(),
        marker: z.string().optional().describe("Probe marker returned by an earlier interaction, to test whether it is reflected in the DOM"),
      },
      outputSchema: z.looseObject({ evidenceId: z.string(), url: z.string(), title: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run("inspect_page", `inspect ${args.url ?? "(current page)"} [${args.session ?? "default"}]`, () => inspectPage(args)),
  );

  server.registerTool(
    "interact_with_page",
    {
      title: "Perform generic browser actions",
      description:
        "Executes a short list of generic browser actions (navigate, click incl. rapid repeat, fill incl. secretRef/probe marker, select, check, press, hover, scroll, wait, setViewport, back/forward/reload, simulateNetwork fault injection, clearSession) in a named session. Returns per-step outcome, resulting URL, new console errors, failed requests, API calls, blocked out-of-scope navigations, dialogs (auto-dismissed) and visible messages/validation state. Nothing is saved as a reusable script. Set screenshotAfter to capture evidence.",
      inputSchema: {
        ...sessionFields,
        actions: z.array(action).min(1).max(30),
        stopOnError: z.boolean().optional(),
        screenshotAfter: z.boolean().optional(),
        label: z.string().optional(),
      },
      outputSchema: z.looseObject({ session: z.string(), finalUrl: z.string(), steps: z.array(z.record(z.string(), z.unknown())) }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args) => run("interact_with_page", `${args.actions.length} action(s): ${args.actions.map((a) => a.type).join(",")} [${args.session ?? "default"}]`, () => interact(args as never)),
  );

  server.registerTool(
    "capture_evidence",
    {
      title: "Capture evidence from a browser session",
      description:
        "Saves evidence files for the current page of a session: screenshot (full page or a selector), DOM snapshot, console log, network log (with filters; includes blocked out-of-scope navigations), web storage (sensitive values masked) and cookies (attributes only, values never stored). Returns evidence IDs to cite in findings and coverage, plus automated observations (indicators, not findings).",
      inputSchema: {
        ...sessionFields,
        kinds: z.array(z.enum(["screenshot", "dom", "console", "network", "storage", "cookies"])).min(1),
        label: z.string().min(3),
        fullPage: z.boolean().optional(),
        selector: z.string().optional(),
        networkFilter: z.object({ urlIncludes: z.string().optional(), minStatus: z.number().int().optional(), apiOnly: z.boolean().optional() }).optional(),
      },
      outputSchema: z.looseObject({ url: z.string(), evidence: z.array(z.looseObject({ id: z.string(), kind: z.string(), file: z.string() })) }),
      annotations: { readOnlyHint: true },
    },
    async (args) => run("capture_evidence", `${args.kinds.join(",")} "${args.label}"`, () => captureEvidence(args)),
  );

  server.registerTool(
    "investigate_api",
    {
      title: "Controlled HTTP/API investigation",
      description:
        "Sends up to 15 controlled HTTP requests to in-scope endpoints with timeouts, response-size caps, a mission request budget and rate spacing. Supports auth profiles (valid/none/invalid modes for authn/authz checks), Origin header for CORS, raw/malformed bodies, repeat for idempotency, inert probe markers, and expectations (status, JSON Schema, headers, body). Returns status, headers, redacted body excerpt, expectation results and passive observations (security headers, CORS, error/stack-trace disclosure, sensitive fields, caching). Each exchange is saved as redacted evidence and linked to registered endpoints for coverage.",
      inputSchema: { requests: z.array(apiRequest).min(1).max(15) },
      outputSchema: z.looseObject({ results: z.array(z.record(z.string(), z.unknown())), budget: z.looseObject({ used: z.number(), max: z.number() }) }),
      annotations: { openWorldHint: true, destructiveHint: false },
    },
    async (args) => run("investigate_api", args.requests.map((r) => `${r.method} ${r.url}`).join(" | "), () => investigateApi(args.requests as never)),
  );

  server.registerTool(
    "record_finding",
    {
      title: "Record, update, list or get findings",
      description:
        "action=create records a finding with full defect details. Requires >=1 tool-captured evidence id; security findings must state securityConfidence. Duplicate detection compares resource, category, error signature, title and shared evidence: likely duplicates (score>=0.75) are rejected with the existing id; similar ones are flagged possibleDuplicateOf. New findings start as Potential (or Blocked) — only verify_finding can mark them Confirmed / Not Reproduced. action=update edits fields or adds evidence; list/get read findings.",
      inputSchema: {
        action: z.enum(["create", "update", "list", "get"]),
        findingId: z.string().optional(),
        finding: z
          .object({
            title: z.string().min(8),
            category: findingCategory,
            affectedUrl: z.string().optional(),
            affectedEndpoint: z.string().optional().describe("'METHOD /path' e.g. 'GET /api/orders/{id}'"),
            severity,
            severityRationale: z.string().min(10),
            priority: z.enum(["P1", "P2", "P3", "P4"]),
            priorityRationale: z.string().min(10),
            status: z.enum(["Potential", "Blocked"]).optional(),
            securityConfidence: z.enum(["suspected", "verified"]).optional(),
            preconditions: z.array(z.string()).optional(),
            steps: z.array(z.string()).min(1),
            expected: z.string(),
            expectedSource: z.string().describe("Where the expectation comes from: requirement id, doc URL, or 'convention: <which>' — never invent requirements"),
            actual: z.string(),
            errorSignature: z.string().optional().describe("Distinctive error text/status used for duplicate detection"),
            evidenceIds: z.array(z.string()).min(1),
            impact: z.string(),
            scope: z.string(),
            suggestedFollowUp: z.string(),
            requirementIds: z.array(z.string()).optional(),
            scenarioIds: z.array(z.string()).optional(),
            allowDuplicate: z.boolean().optional(),
            duplicateJustification: z.string().optional(),
          })
          .optional(),
        patch: z.record(z.string(), z.unknown()).optional().describe("For update: fields to change, and/or addEvidenceIds"),
      },
      outputSchema: loose,
      annotations: { destructiveHint: false },
    },
    async (args) =>
      run("record_finding", `${args.action} ${args.findingId ?? args.finding?.title ?? ""}`, () => {
        if (args.action === "create") {
          if (!args.finding) throw new Error("finding is required for create");
          return recordFinding(args.finding as never);
        }
        if (args.action === "update") {
          if (!args.findingId || !args.patch) throw new Error("findingId and patch are required for update");
          return updateFinding(args.findingId, args.patch as never);
        }
        if (args.action === "get") {
          if (!args.findingId) throw new Error("findingId is required for get");
          return { finding: getFinding(args.findingId) };
        }
        return { findings: listFindings() };
      }),
  );

  server.registerTool(
    "verify_finding",
    {
      title: "Re-check a finding and set its verification status",
      description:
        "Reproduces a recorded finding and sets status from the result. method=api replays a request; method=browser runs actions in a fresh session per attempt; both take a defectSignature describing what is observed WHEN THE DEFECT IS PRESENT (all conditions must hold). All attempts reproduce -> Confirmed; some -> Potential (intermittent); none -> Not Reproduced; could not run -> Blocked. method=evidence_review lets the investigator conclude from existing evidence (e.g. visual issues) with a written rationale; this is labelled as judgement, not reproduction. Each attempt captures evidence.",
      inputSchema: {
        findingId: z.string(),
        method: z.enum(["api", "browser", "evidence_review"]),
        attempts: z.number().int().min(1).max(5).optional(),
        api: z
          .object({
            request: apiRequest,
            defectSignature: z.object({
              status: z.array(z.number().int()).optional(),
              bodyIncludes: z.array(z.string()).optional(),
              bodyExcludes: z.array(z.string()).optional(),
              headerMissing: z.array(z.string()).optional(),
              headerPresent: z.array(z.string()).optional(),
              jsonPathExists: z.array(z.string()).optional(),
              jsonPathEquals: z.array(z.object({ path: z.string(), value: z.unknown() })).optional(),
              observationType: z.string().optional(),
              headerValueIncludes: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
              headerValueExcludes: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe("Header present but NOT containing value, e.g. set-cookie without HttpOnly"),
            }),
          })
          .optional(),
        browser: z
          .object({
            session: z.string().optional(),
            actions: z.array(action).min(1).max(30),
            defectSignature: z.object({
              urlIncludes: z.string().optional(),
              textPresent: z.array(z.string()).optional(),
              textAbsent: z.array(z.string()).optional(),
              selectorPresent: z.string().optional(),
              selectorAbsent: z.string().optional(),
              consoleErrorIncludes: z.string().optional(),
              apiCall: z.object({ urlIncludes: z.string(), status: z.number().int().optional(), minCount: z.number().int().optional() }).optional(),
              blockedNavigationIncludes: z.string().optional(),
              horizontalOverflow: z.boolean().optional(),
              loadingIndicatorVisible: z.boolean().optional(),
              selectorCount: z.object({ selector: z.string(), min: z.number().int().optional(), max: z.number().int().optional() }).optional(),
            }),
          })
          .optional(),
        review: z.object({ evidenceIds: z.array(z.string()).min(1), rationale: z.string(), conclusion: z.enum(["Confirmed", "Potential", "Not Reproduced"]) }).optional(),
      },
      outputSchema: z.looseObject({ findingId: z.string(), status: z.string(), attempts: z.number(), reproduced: z.number() }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args) => run("verify_finding", `${args.findingId} via ${args.method}`, () => verifyFinding(args as never)),
  );

  server.registerTool(
    "manage_coverage",
    {
      title: "Maintain the live coverage matrix",
      description:
        "Tracks requirements (with stated sources), risk-scored investigation areas (impact x likelihood x exposure, categories: functional, ui, api, security, integration, compatibility, business-rules), scenarios (technique: positive/negative/boundary/exception/recovery/integration/security/usability/accessibility/compatibility), results (passed/failed/partial/blocked/not_tested with evidence, findings and reasons) and endpoints (from docs, network or supplied). import_network_endpoints registers API calls observed in browser sessions. summary returns metrics with explicit numerators/denominators, gaps and highest-risk next steps.",
      inputSchema: {
        action: z.enum(["add_requirements", "add_areas", "add_scenarios", "record_results", "add_endpoints", "import_network_endpoints", "summary", "list"]),
        items: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      outputSchema: loose,
      annotations: { destructiveHint: false },
    },
    async (args) =>
      run("manage_coverage", `${args.action} (${args.items?.length ?? 0} items)`, () => {
        const items = (args.items ?? []) as never[];
        switch (args.action) {
          case "add_requirements":
            return addRequirements(items);
          case "add_areas":
            return addAreas(items);
          case "add_scenarios":
            return addScenarios(items);
          case "record_results":
            return recordResults(items);
          case "add_endpoints":
            return addEndpoints(items);
          case "import_network_endpoints": {
            requireMission();
            const seen = new Map<string, { method: string; path: string; source: string }>();
            for (const s of engine.all()) {
              for (const n of s.network) {
                if (n.resourceType !== "fetch" && n.resourceType !== "xhr") continue;
                const p = normalizePath(new URL(n.url).pathname);
                seen.set(`${n.method} ${p}`, { method: n.method, path: p, source: "network" });
              }
            }
            return addEndpoints([...seen.values()]);
          }
          case "list":
            return listCoverage();
          default:
            return computeCoverage();
        }
      }),
  );

  server.registerTool(
    "generate_qa_report",
    {
      title: "Generate HTML, JSON and Markdown QA reports",
      description:
        "Writes report.html (summary, coverage by area, findings by severity with evidence thumbnails/links, verification status, blocked checks, remaining risks, traceability, timeline), findings.json, coverage.json, summary.md and coverage-matrix.md into the mission run directory, next to evidence/. Limitations are derived automatically (unverified findings, missing denominators, budgets, unavailable browsers) and can be extended. Provide your own executive summary and risk statement; do not claim complete coverage.",
      inputSchema: {
        title: z.string().optional(),
        executiveSummary: z.string().optional(),
        riskStatement: z.string().optional(),
        limitations: z.array(z.string()).optional(),
        nextInvestigations: z.array(z.string()).optional(),
        formats: z.array(z.enum(["html", "json", "md"])).optional(),
      },
      outputSchema: z.looseObject({ written: z.record(z.string(), z.string()), evidenceDir: z.string() }),
      annotations: { destructiveHint: false },
    },
    async (args) => run("generate_qa_report", "generate report", () => generateReport(args, args.formats)),
  );
}
