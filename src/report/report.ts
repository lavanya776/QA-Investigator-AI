import fs from "node:fs";
import path from "node:path";
import { requireMission } from "../core/store.js";
import type { Finding, MissionState } from "../core/types.js";
import { computeCoverage } from "../coverage/coverage.js";
import { redactDeep, redactText } from "../core/redact.js";
import { nowIso } from "../core/util.js";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;

const escRaw = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const esc = (v: unknown) =>
  redactText(String(v ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface ReportInput {
  title?: string;
  executiveSummary?: string;
  limitations?: string[];
  nextInvestigations?: string[];
  riskStatement?: string;
}

function autoLimitations(state: MissionState): string[] {
  const out = [...state.limitations];
  const cov = computeCoverage(state);
  if (!state.requirements.length) out.push("No requirements were recorded; expectations rely on stated conventions, so requirements coverage cannot be computed.");
  if (!state.endpoints.length) out.push("No API endpoints were registered; endpoint coverage cannot be computed.");
  if (cov.gaps.unevidencedResults.length) out.push(`Scenario results without attached evidence: ${cov.gaps.unevidencedResults.join(", ")}.`);
  const reviewOnly = state.findings.filter((f) => f.status === "Confirmed" && f.verifications.length && f.verifications.every((v) => v.method === "evidence_review"));
  if (reviewOnly.length) out.push(`Confirmed by investigator evidence review rather than automated reproduction: ${reviewOnly.map((f) => f.id).join(", ")}.`);
  const unverified = state.findings.filter((f) => !f.verifications.length);
  if (unverified.length) out.push(`Findings never verified: ${unverified.map((f) => f.id).join(", ")}.`);
  out.push("Security checks were limited to safe, non-destructive observations within the authorised scope. The absence of findings in an area is not evidence that it is secure.");
  out.push("No direct database or service-layer access was available unless stated; data-integrity conclusions are based on UI/API observations only.");
  out.push(`Request budget used: ${state.counters.requests}/${state.mission.limits.maxRequests}; browser actions: ${state.counters.browserActions}/${state.mission.limits.maxBrowserActions}.`);
  return [...new Set(out)];
}

function sortFindings(fs_: Finding[]): Finding[] {
  return [...fs_].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id));
}

export function generateReport(input: ReportInput, formats: Array<"html" | "json" | "md"> = ["html", "json", "md"]) {
  const state = requireMission();
  const cov = computeCoverage(state);
  const findings = sortFindings(state.findings);
  const limitations = [...autoLimitations(state), ...(input.limitations ?? [])];
  const next = [...(input.nextInvestigations ?? []), ...cov.recommendations];
  const generatedAt = nowIso();
  const dir = state.mission.runDir;
  const written: Record<string, string> = {};
  const counts = {
    bySeverity: Object.fromEntries(SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length])),
    byStatus: Object.fromEntries(["Confirmed", "Potential", "Not Reproduced", "Blocked"].map((s) => [s, findings.filter((f) => f.status === s).length])),
  };
  const mission = redactDeep({ ...state.mission, authProfiles: Object.fromEntries(Object.entries(state.mission.authProfiles).map(([k, v]) => [k, { type: v.type }])) });

  if (formats.includes("json")) {
    const evidenceById = Object.fromEntries(state.evidence.map((e) => [e.id, e]));
    const data = {
      generatedAt,
      tool: "qa-investigator-ai",
      mission,
      summary: { findings: counts, coverage: cov.metrics },
      findings: findings.map((f) => ({ ...f, evidence: f.evidenceIds.map((id) => evidenceById[id]).filter(Boolean) })),
      coverage: cov,
      requirements: state.requirements,
      endpoints: state.endpoints,
      scenarios: state.scenarios,
      limitations,
      nextInvestigations: next,
    };
    fs.writeFileSync(path.join(dir, "findings.json"), JSON.stringify(redactDeep(data), null, 2));
    fs.writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(redactDeep({ generatedAt, ...cov, scenarios: state.scenarios, endpoints: state.endpoints, requirements: state.requirements }), null, 2));
    written.json = path.join(dir, "findings.json");
    written.coverageJson = path.join(dir, "coverage.json");
  }

  if (formats.includes("md")) {
    fs.writeFileSync(path.join(dir, "summary.md"), redactText(markdownSummary(state, input, findings, cov, counts, limitations, next, generatedAt)));
    fs.writeFileSync(path.join(dir, "coverage-matrix.md"), redactText(markdownCoverage(state, cov)));
    written.md = path.join(dir, "summary.md");
    written.coverageMd = path.join(dir, "coverage-matrix.md");
  }

  if (formats.includes("html")) {
    fs.writeFileSync(path.join(dir, "report.html"), html(state, input, findings, cov, counts, limitations, next, generatedAt));
    written.html = path.join(dir, "report.html");
  }
  return { written, evidenceDir: path.join(dir, "evidence"), counts, coverage: cov.metrics };
}

type Cov = ReturnType<typeof computeCoverage>;
const pct = (m: { numerator: number; denominator: number; percent: number | null }) => (m.denominator ? `${m.numerator}/${m.denominator} (${m.percent}%)` : "n/a (no denominator recorded)");

function markdownSummary(state: MissionState, input: ReportInput, findings: Finding[], cov: Cov, counts: { bySeverity: Record<string, number>; byStatus: Record<string, number> }, limitations: string[], next: string[], at: string): string {
  const m = state.mission;
  const lines: string[] = [];
  lines.push(`# ${input.title ?? `QA Investigation — ${m.name}`}`, "");
  lines.push(`Generated ${at} · Environment: **${m.environment}** · Mission \`${m.id}\``, "");
  lines.push(`**Objective:** ${m.objective}`, "", `**Scope:** ${m.targetUrls.join(", ")} (hosts: ${m.allowedHosts.join(", ")}) · **Authorization:** ${m.authorization.statement} — ${m.authorization.authorizedBy}`, "");
  if (input.executiveSummary) lines.push("## Executive summary", "", input.executiveSummary, "");
  if (input.riskStatement) lines.push("## Overall risk", "", input.riskStatement, "");
  lines.push("## Findings at a glance", "");
  lines.push(`| Severity | ${SEV_ORDER.join(" | ")} |`, `|---|${SEV_ORDER.map(() => "---").join("|")}|`, `| Count | ${SEV_ORDER.map((s) => counts.bySeverity[s]).join(" | ")} |`, "");
  lines.push(`Status: ${Object.entries(counts.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");
  lines.push("| ID | Sev | Pri | Status | Category | Title | Resource |", "|---|---|---|---|---|---|---|");
  for (const f of findings) lines.push(`| ${f.id} | ${f.severity} | ${f.priority} | ${f.status}${f.securityConfidence ? ` (${f.securityConfidence})` : ""} | ${f.category} | ${f.title.replace(/\|/g, "/")} | \`${f.affectedEndpoint ?? f.affectedUrl}\` |`);
  lines.push("", "## Coverage (measured against recorded denominators)", "");
  for (const [k, v] of Object.entries(cov.metrics)) lines.push(`- **${k}**: ${pct(v)} — ${v.definition}`);
  lines.push("", "See `coverage-matrix.md` for the per-category matrix.", "");
  lines.push("## Blocked and untested", "");
  for (const b of cov.gaps.blocked) lines.push(`- BLOCKED ${b.id} ${b.title}: ${b.reason}`);
  for (const n of cov.gaps.notTested) lines.push(`- NOT TESTED ${n.id} ${n.title}: ${n.reason}`);
  if (!cov.gaps.blocked.length && !cov.gaps.notTested.length) lines.push("- None recorded (this reflects recorded scenarios only).");
  lines.push("", "## Limitations", "", ...limitations.map((l) => `- ${l}`), "");
  lines.push("## Recommended next investigations (highest risk first)", "", ...next.map((n) => `- ${n}`), "");
  lines.push("## Finding details", "");
  for (const f of findings) {
    lines.push(`### ${f.id} — ${f.title}`, "");
    lines.push(`- **Category:** ${f.category} · **Severity:** ${f.severity} (${f.severityRationale}) · **Priority:** ${f.priority} (${f.priorityRationale})`);
    lines.push(`- **Status:** ${f.status}${f.securityConfidence ? ` · security confidence: ${f.securityConfidence}` : ""} · **Resource:** \`${f.affectedEndpoint ?? f.affectedUrl}\` · **Environment:** ${f.environment} · **Recorded:** ${f.createdAt}`);
    if (f.possibleDuplicateOf) lines.push(`- **Possible duplicate of:** ${f.possibleDuplicateOf.id} (similarity ${f.possibleDuplicateOf.score})`);
    if (f.preconditions.length) lines.push(`- **Preconditions:** ${f.preconditions.join("; ")}`);
    lines.push("- **Steps:**", ...f.steps.map((s, i) => `  ${i + 1}. ${s}`));
    lines.push(`- **Expected:** ${f.expected} _(source: ${f.expectedSource})_`, `- **Actual:** ${f.actual}`, `- **Impact / scope:** ${f.impact} / ${f.scope}`, `- **Suggested follow-up:** ${f.suggestedFollowUp}`);
    lines.push(`- **Evidence:** ${f.evidenceIds.map((id) => { const e = state.evidence.find((x) => x.id === id); return e ? `[${id}](${e.file})` : id; }).join(", ")}`);
    for (const v of f.verifications) lines.push(`- **Verification ${v.at}:** ${v.method}, reproduced ${v.reproduced}/${v.attempts} → ${v.resultingStatus}. ${v.notes}${v.errors.length ? ` Errors: ${v.errors.join("; ")}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

function markdownCoverage(state: MissionState, cov: Cov): string {
  const l: string[] = ["# Coverage matrix", "", cov.disclaimer, ""];
  l.push("| Category | Areas | Planned | Attempted | Passed | Failed | Partial | Blocked | Not tested | Defects | Evidence refs |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cov.byCategory) l.push(`| ${c.category}${c.applicable ? "" : " (not planned)"} | ${c.areas} | ${c.planned} | ${c.attempted} | ${c.passed} | ${c.failed} | ${c.partial} | ${c.blocked} | ${c.notTested} | ${c.defects} | ${c.evidenceRefs} |`);
  l.push("", "## Metrics", "");
  for (const [k, v] of Object.entries(cov.metrics)) l.push(`- **${k}**: ${pct(v)} — ${v.definition}`);
  l.push("", "## Areas by risk (impact × likelihood × exposure)", "", "| Area | Category | Risk | Scenarios | Results | Rationale |", "|---|---|---|---|---|---|");
  for (const a of cov.areas) l.push(`| ${a.id} ${a.name} | ${a.category} | ${a.risk.score} | ${a.scenarios} | ${Object.entries(a.results).map(([k, v]) => `${k}:${v}`).join(" ")} | ${a.rationale} |`);
  l.push("", "## Scenarios", "", "| ID | Area | Technique | Status | Requirements | Findings | Evidence | Observation / reason |", "|---|---|---|---|---|---|---|---|");
  for (const s of state.scenarios) l.push(`| ${s.id} | ${s.areaId} | ${s.technique} | ${s.status} | ${s.requirementIds.join(", ")} | ${s.findingIds.join(", ")} | ${s.evidenceIds.join(", ")} | ${(s.observation ?? s.blockedReason ?? "").replace(/\|/g, "/").slice(0, 200)} |`);
  l.push("", "## Requirements", "", "| ID | Requirement | Source | Scenarios | Covered |", "|---|---|---|---|---|");
  for (const r of state.requirements) {
    const sc = state.scenarios.filter((s) => s.requirementIds.includes(r.id));
    l.push(`| ${r.id} | ${r.text.replace(/\|/g, "/")} | ${r.source} | ${sc.map((s) => `${s.id}:${s.status}`).join(" ")} | ${sc.some((s) => !["planned", "not_tested"].includes(s.status)) ? "yes" : "no"} |`);
  }
  l.push("", "## Endpoints", "", "| Endpoint | Source | Requests | Statuses seen |", "|---|---|---|---|");
  for (const e of state.endpoints) l.push(`| \`${e.key}\` | ${e.source} | ${e.requestCount} | ${e.statusesSeen.join(", ")} |`);
  return l.join("\n");
}

function html(state: MissionState, input: ReportInput, findings: Finding[], cov: Cov, counts: { bySeverity: Record<string, number>; byStatus: Record<string, number> }, limitations: string[], next: string[], at: string): string {
  const m = state.mission;
  const ev = (id: string) => state.evidence.find((e) => e.id === id);
  const evLink = (id: string) => {
    const e = ev(id);
    if (!e) return esc(id);
    if (e.file.endsWith(".png")) return `<a class="ev" href="${escRaw(e.file)}" title="${esc(e.summary)}"><img src="${escRaw(e.file)}" alt="${esc(`${id} ${e.label}`)}" loading="lazy"><span>${esc(id)}</span></a>`;
    return `<a class="evt" href="${escRaw(e.file)}" title="${esc(e.summary)}">${esc(id)} · ${esc(e.kind)}</a>`;
  };
  const metricCard = (name: string, v: { numerator: number; denominator: number; percent: number | null; definition: string }) =>
    `<div class="card"><div class="k">${esc(name.replace(/([A-Z])/g, " $1"))}</div><div class="v">${v.denominator ? `${v.percent}%` : "n/a"}</div><div class="d">${v.denominator ? `${v.numerator} of ${v.denominator}` : "no denominator recorded"}</div><p>${esc(v.definition)}</p></div>`;
  const sevBar = SEV_ORDER.map((s) => `<div class="sev s-${s}"><b>${counts.bySeverity[s]}</b><span>${s}</span></div>`).join("");
  const findingHtml = findings
    .map(
      (f) => `<article class="finding" id="${esc(f.id)}">
  <header><span class="badge s-${f.severity}">${esc(f.severity)}</span><span class="badge pri">${esc(f.priority)}</span><span class="badge st st-${esc(f.status.replace(/\s/g, ""))}">${esc(f.status)}${f.securityConfidence ? ` · ${esc(f.securityConfidence)}` : ""}</span><h3>${esc(f.id)} — ${esc(f.title)}</h3></header>
  <dl>
    <dt>Category</dt><dd>${esc(f.category)}</dd>
    <dt>Resource</dt><dd><code>${esc(f.affectedEndpoint ?? f.affectedUrl)}</code></dd>
    <dt>Environment</dt><dd>${esc(f.environment)} · recorded ${esc(f.createdAt)}</dd>
    <dt>Severity rationale</dt><dd>${esc(f.severityRationale)}</dd>
    <dt>Priority rationale</dt><dd>${esc(f.priorityRationale)}</dd>
    ${f.preconditions.length ? `<dt>Preconditions</dt><dd>${f.preconditions.map(esc).join("<br>")}</dd>` : ""}
    <dt>Steps</dt><dd><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></dd>
    <dt>Expected</dt><dd>${esc(f.expected)} <em>(source: ${esc(f.expectedSource)})</em></dd>
    <dt>Actual</dt><dd>${esc(f.actual)}</dd>
    <dt>Impact / scope</dt><dd>${esc(f.impact)} / ${esc(f.scope)}</dd>
    <dt>Follow-up</dt><dd>${esc(f.suggestedFollowUp)}</dd>
    ${f.possibleDuplicateOf ? `<dt>Possible duplicate</dt><dd><a href="#${esc(f.possibleDuplicateOf.id)}">${esc(f.possibleDuplicateOf.id)}</a> (similarity ${f.possibleDuplicateOf.score})</dd>` : ""}
    <dt>Verification</dt><dd>${f.verifications.length ? f.verifications.map((v) => `${esc(v.at)} — ${esc(v.method)}: reproduced ${v.reproduced}/${v.attempts} → <b>${esc(v.resultingStatus)}</b>. ${esc(v.notes)}${v.errors.length ? ` <span class="err">${esc(v.errors.join("; "))}</span>` : ""}`).join("<br>") : "<span class=\"err\">Not verified</span>"}</dd>
  </dl>
  <div class="evidence">${f.evidenceIds.map(evLink).join("")}</div>
</article>`,
    )
    .join("\n");
  const covRows = cov.byCategory
    .map((c) => `<tr class="${c.applicable ? "" : "na"}"><td>${esc(c.category)}${c.applicable ? "" : " <small>(not planned)</small>"}</td><td>${c.planned}</td><td>${c.attempted}</td><td class="ok">${c.passed}</td><td class="bad">${c.failed}</td><td>${c.partial}</td><td class="warn">${c.blocked}</td><td>${c.notTested}</td><td>${c.defects}</td><td>${c.evidenceRefs}</td></tr>`)
    .join("");
  const scenarioRows = state.scenarios
    .map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.areaId)}</td><td>${esc(s.title)}</td><td>${esc(s.technique)}</td><td><span class="pill p-${esc(s.status)}">${esc(s.status)}</span></td><td>${esc(s.requirementIds.join(", "))}</td><td>${s.findingIds.map((f) => `<a href="#${esc(f)}">${esc(f)}</a>`).join(" ")}</td><td>${s.evidenceIds.map((e) => { const x = ev(e); return x ? `<a href="${escRaw(x.file)}">${esc(e)}</a>` : esc(e); }).join(" ")}</td><td>${esc(s.observation ?? s.blockedReason ?? "")}</td></tr>`)
    .join("");
  const reqRows = state.requirements
    .map((r) => {
      const sc = state.scenarios.filter((s) => s.requirementIds.includes(r.id));
      const covered = sc.some((s) => !["planned", "not_tested"].includes(s.status));
      const failed = sc.some((s) => s.status === "failed");
      return `<tr><td>${esc(r.id)}</td><td>${esc(r.text)}</td><td>${esc(r.source)}</td><td>${sc.map((s) => `${esc(s.id)}:<span class="pill p-${esc(s.status)}">${esc(s.status)}</span>`).join(" ")}</td><td>${failed ? '<span class="bad">failed</span>' : covered ? '<span class="ok">covered</span>' : '<span class="warn">gap</span>'}</td></tr>`;
    })
    .join("");
  const epRows = state.endpoints.map((e) => `<tr><td><code>${esc(e.key)}</code></td><td>${esc(e.source)}</td><td>${e.requestCount}</td><td>${esc(e.statusesSeen.join(", "))}</td></tr>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Investigation Report</title>
<style>
:root{--bg:#f6f7f9;--fg:#1b1f24;--muted:#5b6470;--card:#fff;--line:#e2e5ea;--crit:#7a0b1f;--high:#c2410c;--med:#b45309;--low:#2563eb;--info:#64748b;--ok:#15803d;--bad:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e6e8eb;--muted:#9aa3ae;--card:#1a1e24;--line:#2b313a;--ok:#4ade80;--bad:#f87171;--warn:#facc15;--low:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{margin:36px 0 12px;font-size:19px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card .k{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em}.card .v{font-size:28px;font-weight:700}.card .d{font-size:13px;color:var(--muted)}.card p{font-size:12px;color:var(--muted);margin:6px 0 0}
.sevs{display:flex;gap:10px;flex-wrap:wrap}.sev{background:var(--card);border:1px solid var(--line);border-left:6px solid;border-radius:8px;padding:8px 14px;min-width:100px}.sev b{font-size:22px;display:block}.sev span{font-size:12px;color:var(--muted);text-transform:uppercase}
.s-critical{border-color:var(--crit)}.s-high{border-color:var(--high)}.s-medium{border-color:var(--med)}.s-low{border-color:var(--low)}.s-info{border-color:var(--info)}
.badge{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-right:6px;color:#fff;background:var(--info)}
.badge.s-critical{background:var(--crit)}.badge.s-high{background:var(--high)}.badge.s-medium{background:var(--med)}.badge.s-low{background:var(--low)}.badge.pri{background:#334155}
.badge.st-Confirmed{background:var(--bad)}.badge.st-Potential{background:var(--warn);color:#111}.badge.st-NotReproduced{background:#475569}.badge.st-Blocked{background:#6b21a8}
.finding{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.finding h3{margin:8px 0 0;font-size:16px}
dl{display:grid;grid-template-columns:170px 1fr;gap:4px 14px;margin:12px 0}dt{color:var(--muted);font-size:13px}dd{margin:0;overflow-wrap:anywhere}dd ol{margin:0;padding-left:18px}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
.evidence{display:flex;flex-wrap:wrap;gap:10px}.ev{display:flex;flex-direction:column;align-items:center;font-size:12px;text-decoration:none;color:var(--muted)}.ev img{width:180px;height:110px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px}
.evt{font-size:12px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;text-decoration:none;color:var(--fg);align-self:flex-start}
.tbl{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.03em}
tr.na td{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.err{color:var(--bad)}
.pill{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}.p-passed{color:var(--ok)}.p-failed{color:var(--bad)}.p-blocked,.p-partial{color:var(--warn)}
ul.l li{margin:4px 0}code{font-size:12.5px;overflow-wrap:anywhere}.note{background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:12px 14px;color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>${esc(input.title ?? `QA Investigation — ${m.name}`)}</h1>
<div class="meta">Generated ${esc(at)} · Mission <code>${esc(m.id)}</code> · Environment <b>${esc(m.environment)}</b> · Started ${esc(m.createdAt)}</div>
<p><b>Objective:</b> ${esc(m.objective)}<br><b>Scope:</b> ${m.targetUrls.map((u) => `<code>${esc(u)}</code>`).join(", ")} · hosts ${esc(m.allowedHosts.join(", "))} · methods ${esc(m.allowedMethods.join(", "))}<br><b>Authorization:</b> ${esc(m.authorization.statement)} — ${esc(m.authorization.authorizedBy)}</p>
${input.executiveSummary ? `<h2>Executive summary</h2><p>${esc(input.executiveSummary).replace(/\n/g, "<br>")}</p>` : ""}
${input.riskStatement ? `<h2>Overall risk</h2><p>${esc(input.riskStatement)}</p>` : ""}
<h2>Findings by severity</h2><div class="sevs">${sevBar}</div>
<p class="meta">Verification status: ${Object.entries(counts.byStatus).map(([k, v]) => `${esc(k)} <b>${v}</b>`).join(" · ")}</p>
<h2>Coverage</h2><div class="grid">${Object.entries(cov.metrics).map(([k, v]) => metricCard(k, v)).join("")}</div>
<p class="note">${esc(cov.disclaimer)}</p>
<h3>Coverage by area</h3><div class="tbl"><table><thead><tr><th>Category</th><th>Planned</th><th>Attempted</th><th>Passed</th><th>Failed</th><th>Partial</th><th>Blocked</th><th>Not tested</th><th>Defects</th><th>Evidence</th></tr></thead><tbody>${covRows}</tbody></table></div>
<h2>Findings</h2>${findingHtml || "<p>No findings recorded.</p>"}
<h2>Blocked checks and remaining gaps</h2>
<ul class="l">${[...cov.gaps.blocked.map((b) => `<li><b>Blocked</b> ${esc(b.id)} ${esc(b.title)} — ${esc(b.reason)}</li>`), ...cov.gaps.partial.map((p) => `<li><b>Partial</b> ${esc(p.id)} ${esc(p.title)} — ${esc(p.observation)}</li>`), ...cov.gaps.notTested.map((n) => `<li><b>Not tested</b> ${esc(n.id)} ${esc(n.title)} — ${esc(n.reason)}</li>`), ...cov.gaps.untestedEndpoints.map((e) => `<li><b>Endpoint not exercised</b> <code>${esc(e)}</code></li>`), ...cov.gaps.requirementsWithoutScenarios.map((r) => `<li><b>Requirement without scenario</b> ${esc(r)}</li>`)].join("") || "<li>None recorded.</li>"}</ul>
<h2>Recommended next investigations</h2><ol class="l">${next.map((n) => `<li>${esc(n)}</li>`).join("")}</ol>
<h2>Limitations</h2><ul class="l">${limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Scenario matrix</h2><div class="tbl"><table><thead><tr><th>ID</th><th>Area</th><th>Scenario</th><th>Technique</th><th>Status</th><th>Req</th><th>Findings</th><th>Evidence</th><th>Observation</th></tr></thead><tbody>${scenarioRows}</tbody></table></div>
<h2>Requirements traceability</h2><div class="tbl"><table><thead><tr><th>ID</th><th>Requirement</th><th>Source</th><th>Scenarios</th><th>Coverage</th></tr></thead><tbody>${reqRows || '<tr><td colspan="5">No requirements recorded.</td></tr>'}</tbody></table></div>
<h2>Endpoints</h2><div class="tbl"><table><thead><tr><th>Endpoint</th><th>Source</th><th>Requests</th><th>Statuses</th></tr></thead><tbody>${epRows || '<tr><td colspan="4">No endpoints registered.</td></tr>'}</tbody></table></div>
<h2>Investigation timeline</h2><div class="tbl"><table><thead><tr><th>Time</th><th>Tool</th><th>Summary</th></tr></thead><tbody>${state.activity.map((a) => `<tr><td>${esc(a.at.slice(11, 19))}</td><td>${esc(a.tool)}</td><td>${esc(a.summary)}</td></tr>`).join("")}</tbody></table></div>
<p class="meta">Evidence files are in <code>evidence/</code> next to this report, with SHA-256 hashes recorded in findings.json. Credentials and tokens are redacted.</p>
</main></body></html>`;
}
