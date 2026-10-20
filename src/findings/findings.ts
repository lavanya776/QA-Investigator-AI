import { assertEvidenceIds, persist, requireMission, saveEvidence } from "../core/store.js";
import type { Finding, FindingStatus, Severity, VerificationRecord } from "../core/types.js";
import { errorMessage, getPath, jaccard, normalizeSignature, nowIso, padId, resourceKey, tokens } from "../core/util.js";
import { redactDeep, redactText } from "../core/redact.js";
import { exchangeEvidence, send, type ApiRequest } from "../api/http.js";
import { analyzeExchange } from "../api/analyze.js";
import { engine } from "../browser/engine.js";
import { interact, type Action } from "../browser/operations.js";

export interface FindingInput {
  title: string;
  category: string;
  affectedUrl?: string;
  affectedEndpoint?: string;
  severity: Severity;
  severityRationale: string;
  priority: "P1" | "P2" | "P3" | "P4";
  priorityRationale: string;
  status?: "Potential" | "Blocked";
  securityConfidence?: "suspected" | "verified";
  preconditions?: string[];
  steps: string[];
  expected: string;
  expectedSource: string;
  actual: string;
  errorSignature?: string;
  evidenceIds: string[];
  impact: string;
  scope: string;
  suggestedFollowUp: string;
  requirementIds?: string[];
  scenarioIds?: string[];
}

/** Similarity used for duplicate detection: resource, category, error signature, title, shared evidence. */
function similarity(a: Pick<Finding, "resourceKey" | "category" | "errorSignature" | "actual" | "title" | "evidenceIds">, b: Finding): number {
  let score = 0;
  if (a.resourceKey === b.resourceKey) score += 0.4;
  else if (a.resourceKey.split("?")[0] === b.resourceKey.split("?")[0]) score += 0.3;
  if (a.category === b.category) score += 0.15;
  const sigA = tokens(normalizeSignature(a.errorSignature ?? a.actual));
  const sigB = tokens(normalizeSignature(b.errorSignature ?? b.actual));
  score += 0.3 * jaccard(sigA, sigB);
  score += 0.15 * jaccard(tokens(a.title), tokens(b.title));
  if (a.evidenceIds.some((e) => b.evidenceIds.includes(e))) score += 0.2;
  return Math.min(1, Math.round(score * 100) / 100);
}

export function recordFinding(input: FindingInput & { allowDuplicate?: boolean; duplicateJustification?: string }) {
  const state = requireMission();
  if (!input.evidenceIds.length) throw new Error("A finding needs at least one evidence id captured by a tool. Capture evidence first; never record a finding from assumption alone.");
  assertEvidenceIds(input.evidenceIds);
  if (input.category === "security" && !input.securityConfidence) throw new Error("Security findings must state securityConfidence: 'suspected' or 'verified'.");
  if (!input.affectedUrl && !input.affectedEndpoint) throw new Error("Provide affectedUrl or affectedEndpoint.");

  const key = resourceKey({ url: input.affectedUrl, endpoint: input.affectedEndpoint });
  const candidate = { resourceKey: key, category: input.category, errorSignature: input.errorSignature, actual: input.actual, title: input.title, evidenceIds: input.evidenceIds };
  const ranked = state.findings.map((f) => ({ f, score: similarity(candidate, f) })).sort((x, y) => y.score - x.score);
  const best = ranked[0];
  if (best && best.score >= 0.75 && !input.allowDuplicate) {
    return {
      created: false,
      duplicateOf: best.f.id,
      score: best.score,
      message: `Likely duplicate of ${best.f.id} ("${best.f.title}"). Add new evidence to the existing finding with action=update, or resubmit with allowDuplicate=true and a duplicateJustification if it is a distinct defect.`,
    };
  }
  state.counters.finding += 1;
  const now = nowIso();
  const finding: Finding = {
    id: padId("QA", state.counters.finding),
    title: input.title,
    category: input.category,
    affectedUrl: input.affectedUrl,
    affectedEndpoint: input.affectedEndpoint,
    resourceKey: key,
    environment: state.mission.environment,
    createdAt: now,
    updatedAt: now,
    severity: input.severity,
    severityRationale: input.severityRationale,
    priority: input.priority,
    priorityRationale: input.priorityRationale,
    status: input.status ?? "Potential",
    securityConfidence: input.securityConfidence === "verified" ? "suspected" : input.securityConfidence,
    preconditions: input.preconditions ?? [],
    steps: input.steps,
    expected: input.expected,
    expectedSource: input.expectedSource,
    actual: input.actual,
    errorSignature: input.errorSignature,
    evidenceIds: input.evidenceIds,
    impact: input.impact,
    scope: input.scope,
    suggestedFollowUp: input.suggestedFollowUp,
    requirementIds: input.requirementIds ?? [],
    scenarioIds: input.scenarioIds ?? [],
    possibleDuplicateOf: best && best.score >= 0.5 ? { id: best.f.id, score: best.score } : undefined,
    verifications: [],
  };
  state.findings.push(redactDeep(finding));
  persist();
  return {
    created: true,
    id: finding.id,
    status: finding.status,
    possibleDuplicateOf: finding.possibleDuplicateOf,
    note:
      "Recorded as " +
      finding.status +
      ". Use verify_finding to reproduce it before it can become Confirmed." +
      (input.securityConfidence === "verified" ? " securityConfidence starts as 'suspected' and is upgraded to 'verified' only by a successful reproduction." : ""),
  };
}

export function updateFinding(id: string, patch: Partial<FindingInput> & { addEvidenceIds?: string[] }) {
  const state = requireMission();
  const f = state.findings.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown finding ${id}`);
  if (patch.addEvidenceIds?.length) {
    assertEvidenceIds(patch.addEvidenceIds);
    f.evidenceIds = [...new Set([...f.evidenceIds, ...patch.addEvidenceIds])];
  }
  const editable = ["title", "severity", "severityRationale", "priority", "priorityRationale", "preconditions", "steps", "expected", "expectedSource", "actual", "impact", "scope", "suggestedFollowUp", "requirementIds", "scenarioIds", "errorSignature"] as const;
  for (const k of editable) if (patch[k] !== undefined) (f as unknown as Record<string, unknown>)[k] = redactDeep(patch[k]);
  if (patch.status === "Blocked") f.status = "Blocked";
  f.updatedAt = nowIso();
  persist();
  return { updated: true, id: f.id, status: f.status };
}

export function listFindings() {
  const state = requireMission();
  return state.findings.map((f) => ({ id: f.id, title: f.title, category: f.category, severity: f.severity, priority: f.priority, status: f.status, resource: f.resourceKey, evidence: f.evidenceIds.length, verifications: f.verifications.length, possibleDuplicateOf: f.possibleDuplicateOf?.id }));
}

export function getFinding(id: string): Finding {
  const f = requireMission().findings.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown finding ${id}`);
  return f;
}

// --------------------------------------------------------------- verification

export interface ApiSignature {
  status?: number[];
  bodyIncludes?: string[];
  bodyExcludes?: string[];
  headerMissing?: string[];
  headerPresent?: string[];
  jsonPathExists?: string[];
  jsonPathEquals?: Array<{ path: string; value: unknown }>;
  observationType?: string;
  headerValueIncludes?: Array<{ name: string; value: string }>;
  headerValueExcludes?: Array<{ name: string; value: string }>;
}

export interface BrowserSignature {
  urlIncludes?: string;
  textPresent?: string[];
  textAbsent?: string[];
  selectorPresent?: string;
  selectorAbsent?: string;
  consoleErrorIncludes?: string;
  apiCall?: { urlIncludes: string; status?: number; minCount?: number };
  blockedNavigationIncludes?: string;
  horizontalOverflow?: boolean;
  loadingIndicatorVisible?: boolean;
  selectorCount?: { selector: string; min?: number; max?: number };
}

const nonEmpty = (o: object) => Object.values(o).some((v) => v !== undefined);

export async function verifyFinding(input: {
  findingId: string;
  method: "api" | "browser" | "evidence_review";
  attempts?: number;
  api?: { request: ApiRequest; defectSignature: ApiSignature };
  browser?: { session?: string; actions: Action[]; defectSignature: BrowserSignature };
  review?: { evidenceIds: string[]; rationale: string; conclusion: "Confirmed" | "Potential" | "Not Reproduced" };
}) {
  const f = getFinding(input.findingId);
  const attempts = Math.min(Math.max(input.attempts ?? 2, 1), 5);
  const record: VerificationRecord = { at: nowIso(), method: input.method, attempts: 0, reproduced: 0, errors: [], resultingStatus: f.status, evidenceIds: [], notes: "" };
  const details: Array<Record<string, unknown>> = [];

  if (input.method === "evidence_review") {
    if (!input.review) throw new Error("evidence_review requires review {evidenceIds, rationale, conclusion}");
    if (!input.review.evidenceIds.length || input.review.rationale.trim().length < 20) throw new Error("evidence_review needs at least one evidence id and a substantive rationale (>= 20 chars).");
    assertEvidenceIds(input.review.evidenceIds);
    record.attempts = 1;
    record.reproduced = input.review.conclusion === "Confirmed" ? 1 : 0;
    record.evidenceIds = input.review.evidenceIds;
    record.resultingStatus = input.review.conclusion;
    record.notes = `Manual evidence review by investigator: ${redactText(input.review.rationale)}`;
  } else if (input.method === "api") {
    if (!input.api || !nonEmpty(input.api.defectSignature)) throw new Error("api verification requires request and a non-empty defectSignature describing what is observed when the defect is present.");
    for (let i = 0; i < attempts; i++) {
      record.attempts++;
      try {
        const sent = await send(input.api.request);
        const ex = sent.exchange;
        if (ex.error) throw new Error(ex.error);
        const sig = input.api.defectSignature;
        const checks: Record<string, boolean> = {};
        if (sig.status) checks.status = sig.status.includes(ex.status);
        for (const s of sig.bodyIncludes ?? []) checks[`bodyIncludes:${s}`] = ex.bodyText.includes(s);
        for (const s of sig.bodyExcludes ?? []) checks[`bodyExcludes:${s}`] = !ex.bodyText.includes(s);
        for (const h of sig.headerMissing ?? []) checks[`headerMissing:${h}`] = !(h.toLowerCase() in ex.headers);
        for (const h of sig.headerPresent ?? []) checks[`headerPresent:${h}`] = h.toLowerCase() in ex.headers;
        const hval = (name: string) => (ex.headers[name.toLowerCase()] ?? "").toLowerCase();
        for (const hv of sig.headerValueIncludes ?? []) checks[`headerValueIncludes:${hv.name}~${hv.value}`] = hval(hv.name).includes(hv.value.toLowerCase());
        for (const hv of sig.headerValueExcludes ?? []) checks[`headerValueExcludes:${hv.name}~${hv.value}`] = hv.name.toLowerCase() in ex.headers && !hval(hv.name).includes(hv.value.toLowerCase());
        for (const p of sig.jsonPathExists ?? []) checks[`jsonPathExists:${p}`] = getPath(ex.json, p) !== undefined;
        for (const e of sig.jsonPathEquals ?? []) checks[`jsonPathEquals:${e.path}`] = JSON.stringify(getPath(ex.json, e.path)) === JSON.stringify(e.value);
        if (sig.observationType) {
          const obs = analyzeExchange({ url: sent.url, status: ex.status, headers: ex.headers, bodyText: ex.bodyText, json: ex.json, authenticated: Boolean(input.api.request.auth), contentType: ex.headers["content-type"] ?? "" });
          checks[`observation:${sig.observationType}`] = obs.some((o) => o.type === sig.observationType);
        }
        const reproduced = Object.values(checks).every(Boolean);
        if (reproduced) record.reproduced++;
        const ev = exchangeEvidence(`verify ${f.id} attempt ${i + 1}`, input.api.request.method.toUpperCase(), sent.url, sent, ex, { verification: { findingId: f.id, checks, reproduced } });
        record.evidenceIds.push(ev.id);
        details.push({ attempt: i + 1, status: ex.status, checks, reproduced, evidenceId: ev.id });
      } catch (err) {
        record.errors.push(redactText(errorMessage(err)));
        details.push({ attempt: i + 1, error: redactText(errorMessage(err)) });
      }
    }
  } else {
    if (!input.browser || !nonEmpty(input.browser.defectSignature)) throw new Error("browser verification requires actions and a non-empty defectSignature.");
    const sessionName = input.browser.session ?? `verify-${f.id}`;
    for (let i = 0; i < attempts; i++) {
      record.attempts++;
      try {
        const run = (await interact({ session: sessionName, actions: input.browser.actions, stopOnError: true })) as Record<string, any>;
        const failedStep = (run.steps as Array<Record<string, unknown>>).find((s) => s.ok === false);
        if (failedStep) throw new Error(`Step ${failedStep.step} (${failedStep.type}) failed: ${failedStep.error}`);
        const s = await engine.session(sessionName);
        const sig = input.browser.defectSignature;
        const page = s.page;
        const text = await page.evaluate(() => document.body.innerText);
        const checks: Record<string, boolean> = {};
        if (sig.urlIncludes) checks.urlIncludes = page.url().includes(sig.urlIncludes);
        for (const t of sig.textPresent ?? []) checks[`textPresent:${t}`] = text.includes(t);
        for (const t of sig.textAbsent ?? []) checks[`textAbsent:${t}`] = !text.includes(t);
        if (sig.selectorPresent) checks.selectorPresent = (await page.locator(sig.selectorPresent).count()) > 0;
        if (sig.selectorCount) {
          const n = await page.locator(sig.selectorCount.selector).count();
          checks[`selectorCount=${n}`] = n >= (sig.selectorCount.min ?? 0) && n <= (sig.selectorCount.max ?? Number.MAX_SAFE_INTEGER);
        }
        if (sig.selectorAbsent) checks.selectorAbsent = (await page.locator(sig.selectorAbsent).count()) === 0;
        if (sig.consoleErrorIncludes) checks.consoleError = (run.events.consoleErrors as Array<{ text: string }>).some((c) => c.text.includes(sig.consoleErrorIncludes as string));
        if (sig.apiCall) {
          const calls = (run.events.apiCalls as Array<{ url: string; status?: number }>).filter((c) => c.url.includes(sig.apiCall!.urlIncludes) && (sig.apiCall!.status === undefined || c.status === sig.apiCall!.status));
          checks.apiCall = calls.length >= (sig.apiCall.minCount ?? 1);
        }
        if (sig.blockedNavigationIncludes) checks.blockedNavigation = (run.events.blockedNavigations as Array<{ to: string }>).some((b) => b.to.includes(sig.blockedNavigationIncludes as string));
        if (sig.horizontalOverflow !== undefined) checks.horizontalOverflow = (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) === sig.horizontalOverflow;
        if (sig.loadingIndicatorVisible !== undefined) checks.loadingIndicatorVisible = ((await page.locator("[aria-busy=true], .spinner, .loading, [role=progressbar]").filter({ visible: true }).count()) > 0) === sig.loadingIndicatorVisible;
        const reproduced = Object.values(checks).every(Boolean);
        if (reproduced) record.reproduced++;
        const shot = saveEvidence({ kind: "verification", label: `verify ${f.id} attempt ${i + 1}`, source: page.url(), summary: `Verification attempt ${i + 1}: ${reproduced ? "reproduced" : "not reproduced"} ${JSON.stringify(checks)}`, ext: "png", data: await page.screenshot({ fullPage: true }) });
        record.evidenceIds.push(shot.id);
        details.push({ attempt: i + 1, checks, reproduced, evidenceId: shot.id, finalUrl: page.url() });
      } catch (err) {
        record.errors.push(redactText(errorMessage(err).split("\n")[0]));
        details.push({ attempt: i + 1, error: redactText(errorMessage(err).split("\n")[0]) });
      } finally {
        // fresh state for each attempt so earlier attempts cannot mask the result
        await engine.closeSession(sessionName);
      }
    }
  }

  if (input.method !== "evidence_review") {
    const completed = record.attempts - record.errors.length;
    let status: FindingStatus;
    if (completed === 0) status = "Blocked";
    else if (record.reproduced === record.attempts) status = "Confirmed";
    else if (record.reproduced > 0) status = "Potential";
    else status = "Not Reproduced";
    record.resultingStatus = status;
    record.notes =
      status === "Potential" && record.reproduced > 0
        ? `Intermittent: reproduced ${record.reproduced}/${record.attempts}.`
        : status === "Blocked"
          ? "Verification could not run; see errors."
          : `Reproduced ${record.reproduced}/${record.attempts}.`;
  }

  f.status = record.resultingStatus;
  if (f.category === "security" && f.securityConfidence) {
    f.securityConfidence = record.resultingStatus === "Confirmed" && input.method !== "evidence_review" ? "verified" : "suspected";
  }
  f.evidenceIds = [...new Set([...f.evidenceIds, ...record.evidenceIds])];
  f.verifications.push(record);
  f.updatedAt = nowIso();
  persist();
  return {
    findingId: f.id,
    status: f.status,
    securityConfidence: f.securityConfidence,
    attempts: record.attempts,
    reproduced: record.reproduced,
    errors: record.errors,
    notes: record.notes,
    attemptsDetail: details,
    limitations:
      input.method === "evidence_review"
        ? ["Status set by investigator judgement over captured evidence, not by automated reproduction."]
        : ["Verification reproduces the observable defect signature you supplied; it does not prove root cause."],
  };
}
