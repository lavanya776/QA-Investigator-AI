import { assertEvidenceIds, persist, requireMission } from "../core/store.js";
import type { CoverageArea, Endpoint, MissionState, Requirement, Scenario, ScenarioStatus } from "../core/types.js";
import { nowIso, padId, templateToPath } from "../core/util.js";

export const CATEGORIES = ["functional", "ui", "api", "security", "integration", "compatibility", "business-rules"] as const;

export function addRequirements(items: Array<Omit<Requirement, "type"> & { type?: string }>) {
  const state = requireMission();
  const added: string[] = [];
  for (const r of items) {
    if (!r.source?.trim()) throw new Error(`Requirement ${r.id} needs a source (document URL/section, ticket, or "stated by user"). Do not invent requirements.`);
    const existing = state.requirements.find((x) => x.id === r.id);
    if (existing) Object.assign(existing, r);
    else state.requirements.push({ id: r.id, text: r.text, source: r.source, type: r.type ?? "functional" });
    added.push(r.id);
  }
  persist();
  return { upserted: added, total: state.requirements.length };
}

export function addAreas(items: Array<{ id: string; category: string; name: string; description?: string; impact: number; likelihood: number; exposure?: number; rationale: string }>) {
  const state = requireMission();
  for (const a of items) {
    if (!(CATEGORIES as readonly string[]).includes(a.category)) throw new Error(`Area ${a.id}: category must be one of ${CATEGORIES.join(", ")}`);
    const exposure = a.exposure ?? 3;
    const area: CoverageArea = { id: a.id, category: a.category, name: a.name, description: a.description ?? "", risk: { impact: a.impact, likelihood: a.likelihood, exposure, score: a.impact * a.likelihood * exposure }, rationale: a.rationale };
    const i = state.areas.findIndex((x) => x.id === a.id);
    if (i >= 0) state.areas[i] = area;
    else state.areas.push(area);
  }
  persist();
  return { areas: state.areas.map((a) => ({ id: a.id, category: a.category, risk: a.risk.score })).sort((x, y) => y.risk - x.risk) };
}

export function addScenarios(items: Array<{ id?: string; areaId: string; title: string; technique: string; requirementIds?: string[]; endpointKeys?: string[] }>) {
  const state = requireMission();
  const created: string[] = [];
  for (const s of items) {
    if (!state.areas.some((a) => a.id === s.areaId)) throw new Error(`Unknown area ${s.areaId}; add it with add_areas first.`);
    const unknownReq = (s.requirementIds ?? []).filter((r) => !state.requirements.some((x) => x.id === r));
    if (unknownReq.length) throw new Error(`Scenario "${s.title}" references unknown requirement(s): ${unknownReq.join(", ")}`);
    let id = s.id;
    if (!id) {
      state.counters.scenario += 1;
      id = padId("SC", state.counters.scenario);
    }
    const existing = state.scenarios.find((x) => x.id === id);
    if (existing) Object.assign(existing, { areaId: s.areaId, title: s.title, technique: s.technique, requirementIds: s.requirementIds ?? [], endpointKeys: s.endpointKeys ?? [] });
    else state.scenarios.push({ id, areaId: s.areaId, title: s.title, technique: s.technique, requirementIds: s.requirementIds ?? [], endpointKeys: s.endpointKeys ?? [], status: "planned", evidenceIds: [], findingIds: [], updatedAt: nowIso() });
    created.push(id);
  }
  persist();
  return { scenarios: created, total: state.scenarios.length };
}

export function recordResults(items: Array<{ scenarioId: string; status: ScenarioStatus; observation?: string; blockedReason?: string; evidenceIds?: string[]; findingIds?: string[] }>) {
  const state = requireMission();
  const warnings: string[] = [];
  for (const r of items) {
    // accept common aliases models use for the free-text fields
    const alias = r as typeof r & { notes?: string; reason?: string };
    r.observation ??= alias.notes;
    if (r.status === "blocked" || r.status === "not_tested") r.blockedReason ??= alias.reason ?? alias.notes;
    const sc = state.scenarios.find((x) => x.id === r.scenarioId);
    if (!sc) throw new Error(`Unknown scenario ${r.scenarioId}`);
    if ((r.status === "failed" || r.status === "partial") && !r.observation) throw new Error(`${r.scenarioId}: ${r.status} results need an observation.`);
    if (r.status === "blocked" && !r.blockedReason) throw new Error(`${r.scenarioId}: blocked results need a blockedReason.`);
    if (r.status === "not_tested" && !r.blockedReason) throw new Error(`${r.scenarioId}: not_tested results need a reason (blockedReason).`);
    if (r.evidenceIds?.length) assertEvidenceIds(r.evidenceIds);
    const unknownF = (r.findingIds ?? []).filter((f) => !state.findings.some((x) => x.id === f));
    if (unknownF.length) throw new Error(`${r.scenarioId}: unknown finding(s) ${unknownF.join(", ")}`);
    if ((r.status === "passed" || r.status === "failed") && !(r.evidenceIds?.length || sc.evidenceIds.length)) warnings.push(`${r.scenarioId} marked ${r.status} without evidence; the report will flag it as unevidenced.`);
    if (r.status === "failed" && !(r.findingIds?.length || sc.findingIds.length)) warnings.push(`${r.scenarioId} failed but no finding is linked.`);
    sc.status = r.status;
    sc.observation = r.observation ?? sc.observation;
    sc.blockedReason = r.blockedReason ?? sc.blockedReason;
    sc.evidenceIds = [...new Set([...sc.evidenceIds, ...(r.evidenceIds ?? [])])];
    sc.findingIds = [...new Set([...sc.findingIds, ...(r.findingIds ?? [])])];
    sc.updatedAt = nowIso();
  }
  persist();
  return { updated: items.map((i) => i.scenarioId), warnings };
}

export function addEndpoints(items: Array<{ method: string; path: string; source: string; requiresAuth?: boolean }>) {
  const state = requireMission();
  for (const e of items) {
    const method = e.method.toUpperCase();
    const pathT = templateToPath(e.path.startsWith("http") ? new URL(e.path).pathname : e.path);
    const key = `${method} ${pathT}`;
    if (!state.endpoints.some((x) => x.key === key)) state.endpoints.push({ key, method, path: pathT, source: e.source, requiresAuth: e.requiresAuth, requestCount: 0, statusesSeen: [] });
  }
  persist();
  return { total: state.endpoints.length, endpoints: state.endpoints.map((e) => e.key) };
}

const ratio = (num: number, den: number) => ({ numerator: num, denominator: den, percent: den ? Math.round((num / den) * 1000) / 10 : null });

export function computeCoverage(state: MissionState = requireMission()) {
  const attempted = (s: Scenario) => !["planned", "not_tested"].includes(s.status);
  const byCategory = CATEGORIES.map((cat) => {
    const areaIds = state.areas.filter((a) => a.category === cat).map((a) => a.id);
    const sc = state.scenarios.filter((s) => areaIds.includes(s.areaId));
    const findingIds = new Set(sc.flatMap((s) => s.findingIds));
    for (const f of state.findings) if (categoryOfFinding(f.category) === cat) findingIds.add(f.id);
    return {
      category: cat,
      areas: areaIds.length,
      planned: sc.length,
      attempted: sc.filter(attempted).length,
      passed: sc.filter((s) => s.status === "passed").length,
      failed: sc.filter((s) => s.status === "failed").length,
      partial: sc.filter((s) => s.status === "partial").length,
      blocked: sc.filter((s) => s.status === "blocked").length,
      notTested: sc.filter((s) => s.status === "not_tested" || s.status === "planned").length,
      defects: findingIds.size,
      evidenceRefs: [...new Set(sc.flatMap((s) => s.evidenceIds))].length,
      gapReasons: sc.filter((s) => s.blockedReason).map((s) => `${s.id}: ${s.blockedReason}`),
      applicable: areaIds.length > 0,
    };
  });

  const reqCovered = state.requirements.filter((r) => state.scenarios.some((s) => s.requirementIds.includes(r.id) && attempted(s)));
  const reqWithScenario = state.requirements.filter((r) => state.scenarios.some((s) => s.requirementIds.includes(r.id)));
  const reqFailed = state.requirements.filter((r) => state.scenarios.some((s) => s.requirementIds.includes(r.id) && s.status === "failed"));
  const epTested = state.endpoints.filter((e) => e.requestCount > 0);

  const metrics = {
    scenarioExecution: { ...ratio(state.scenarios.filter(attempted).length, state.scenarios.length), definition: "Scenarios with a recorded result (passed/failed/partial/blocked) ÷ scenarios planned in this mission." },
    scenarioCompletion: { ...ratio(state.scenarios.filter((s) => ["passed", "failed"].includes(s.status)).length, state.scenarios.length), definition: "Scenarios with a conclusive pass/fail ÷ scenarios planned (blocked and partial excluded)." },
    requirementsCoverage: { ...ratio(reqCovered.length, state.requirements.length), definition: "Recorded requirements with ≥1 attempted scenario ÷ requirements recorded from stated sources." },
    requirementsPlanned: { ...ratio(reqWithScenario.length, state.requirements.length), definition: "Recorded requirements with ≥1 planned scenario ÷ requirements recorded." },
    requirementsWithFailures: { ...ratio(reqFailed.length, state.requirements.length), definition: "Requirements with ≥1 failed scenario ÷ requirements recorded." },
    endpointCoverage: { ...ratio(epTested.length, state.endpoints.length), definition: "Registered endpoints (from docs/network/supplied) that received ≥1 investigator request ÷ endpoints registered. Says nothing about depth." },
  };

  const riskOf = (s: Scenario) => state.areas.find((a) => a.id === s.areaId)?.risk.score ?? 0;
  const open = state.scenarios.filter((s) => ["planned", "not_tested", "blocked", "partial"].includes(s.status)).sort((a, b) => riskOf(b) - riskOf(a));
  const recommendations = [
    ...open.slice(0, 6).map((s) => `[risk ${riskOf(s)}] ${s.id} ${s.title} — ${s.status}${s.blockedReason ? ` (${s.blockedReason})` : ""}`),
    ...state.requirements.filter((r) => !reqCovered.includes(r)).slice(0, 5).map((r) => `Requirement ${r.id} has no attempted scenario: ${r.text}`),
    ...state.endpoints.filter((e) => e.requestCount === 0).slice(0, 5).map((e) => `Endpoint ${e.key} (${e.source}) never exercised`),
    ...state.areas.filter((a) => !state.scenarios.some((s) => s.areaId === a.id)).map((a) => `Area ${a.id} "${a.name}" has no scenarios planned`),
  ];

  return {
    metrics,
    byCategory,
    areas: state.areas
      .map((a) => {
        const sc = state.scenarios.filter((s) => s.areaId === a.id);
        return { ...a, scenarios: sc.length, results: countBy(sc.map((s) => s.status)) };
      })
      .sort((x, y) => y.risk.score - x.risk.score),
    gaps: {
      notTested: state.scenarios.filter((s) => s.status === "planned" || s.status === "not_tested").map((s) => ({ id: s.id, title: s.title, reason: s.blockedReason ?? "not yet executed" })),
      blocked: state.scenarios.filter((s) => s.status === "blocked").map((s) => ({ id: s.id, title: s.title, reason: s.blockedReason })),
      partial: state.scenarios.filter((s) => s.status === "partial").map((s) => ({ id: s.id, title: s.title, observation: s.observation })),
      requirementsWithoutScenarios: state.requirements.filter((r) => !reqWithScenario.includes(r)).map((r) => r.id),
      untestedEndpoints: state.endpoints.filter((e) => e.requestCount === 0).map((e) => e.key),
      unevidencedResults: state.scenarios.filter((s) => ["passed", "failed"].includes(s.status) && !s.evidenceIds.length).map((s) => s.id),
    },
    recommendations,
    disclaimer: "Coverage is measured only against the scenarios, requirements and endpoints recorded in this mission. It is not a claim of exhaustive testing.",
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function categoryOfFinding(cat: string): string {
  if (["ui", "usability", "accessibility"].includes(cat)) return "ui";
  if (["integration", "resilience"].includes(cat)) return "integration";
  if (["functional", "data-integrity"].includes(cat)) return "functional";
  if (cat === "business-rule") return "business-rules";
  return cat;
}

export function listCoverage() {
  const state = requireMission();
  return {
    requirements: state.requirements,
    areas: state.areas,
    scenarios: state.scenarios.map((s) => ({ id: s.id, areaId: s.areaId, title: s.title, technique: s.technique, status: s.status, req: s.requirementIds, findings: s.findingIds, evidence: s.evidenceIds.length })),
    endpoints: state.endpoints.map((e: Endpoint) => ({ key: e.key, source: e.source, requests: e.requestCount, statuses: e.statusesSeen })),
  };
}
