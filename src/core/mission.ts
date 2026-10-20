import fs from "node:fs";
import path from "node:path";
import { RUNS_ROOT, ScopeError, loadMission, setActive } from "./store.js";
import type { AuthProfile, Mission, MissionLimits, MissionState } from "./types.js";
import { nowIso, safeUrl, slug } from "./util.js";
import { secretAvailable } from "./secrets.js";
import { browserAvailability, engine } from "../browser/engine.js";
import { clearAuthCache } from "../api/http.js";

const DEFAULT_LIMITS: MissionLimits = { maxRequests: 400, minIntervalMs: 50, timeoutMs: 10000, maxResponseBytes: 1_000_000, maxBrowserActions: 1500 };
const HARD_CAPS: MissionLimits = { maxRequests: 2000, minIntervalMs: 20, timeoutMs: 30000, maxResponseBytes: 5_000_000, maxBrowserActions: 5000 };

export interface StartMissionInput {
  name: string;
  objective: string;
  environment: string;
  targetUrls: string[];
  allowedHosts?: string[];
  authorization: { statement: string; authorizedBy: string; scopeNotes?: string };
  allowStateChanging?: boolean;
  allowedMethods?: string[];
  outOfScope?: string[];
  limits?: Partial<MissionLimits>;
  authProfiles?: Record<string, AuthProfile>;
  resumeMissionId?: string;
}

function validateHostPattern(p: string): void {
  const v = p.toLowerCase().trim();
  if (v === "*" || v === "*.*" || /^\*\.[a-z]+$/.test(v) || v.includes("/")) {
    throw new ScopeError(`Host pattern "${p}" is too broad or malformed. Use explicit hosts such as "localhost:4100" or "*.staging.example.com".`);
  }
}

export async function startMission(input: StartMissionInput) {
  await engine.shutdown();
  clearAuthCache();

  if (input.resumeMissionId) {
    const state = loadMission(input.resumeMissionId);
    setActive(state);
    return { resumed: true, missionId: state.mission.id, runDir: state.mission.runDir, findings: state.findings.length, scenarios: state.scenarios.length, evidence: state.evidence.length };
  }

  if (!input.authorization?.statement || input.authorization.statement.trim().length < 10 || !input.authorization.authorizedBy?.trim()) {
    throw new ScopeError("An explicit authorization statement and authorizedBy are required. If authorization is unclear, stop and ask the user.");
  }
  if (!input.targetUrls.length) throw new ScopeError("At least one target URL is required.");
  const hosts = input.allowedHosts?.length ? input.allowedHosts : input.targetUrls.map((u) => safeUrl(u)?.host).filter((h): h is string => Boolean(h));
  hosts.forEach(validateHostPattern);
  for (const u of input.targetUrls) if (!safeUrl(u) || !/^https?:/.test(u)) throw new ScopeError(`Invalid target URL: ${u}`);

  const allowState = input.allowStateChanging ?? false;
  const readOnly = ["GET", "HEAD", "OPTIONS"];
  const methods = (input.allowedMethods?.length ? input.allowedMethods.map((m) => m.toUpperCase()) : allowState ? [...readOnly, "POST", "PUT", "PATCH", "DELETE"] : readOnly).filter((m) => allowState || readOnly.includes(m));

  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  limits.maxRequests = Math.min(limits.maxRequests, HARD_CAPS.maxRequests);
  limits.minIntervalMs = Math.max(limits.minIntervalMs, HARD_CAPS.minIntervalMs);
  limits.timeoutMs = Math.min(limits.timeoutMs, HARD_CAPS.timeoutMs);
  limits.maxResponseBytes = Math.min(limits.maxResponseBytes, HARD_CAPS.maxResponseBytes);
  limits.maxBrowserActions = Math.min(limits.maxBrowserActions, HARD_CAPS.maxBrowserActions);

  const id = `${slug(input.name, 40)}-${nowIso().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
  const runDir = path.join(RUNS_ROOT, id);
  fs.mkdirSync(runDir, { recursive: true });

  const mission: Mission = {
    id,
    name: input.name,
    objective: input.objective,
    environment: input.environment,
    targetUrls: input.targetUrls,
    allowedHosts: hosts,
    authorization: input.authorization,
    allowStateChanging: allowState,
    allowedMethods: methods,
    outOfScope: input.outOfScope ?? [],
    limits,
    authProfiles: input.authProfiles ?? {},
    createdAt: nowIso(),
    runDir,
  };
  const state: MissionState = {
    mission,
    counters: { evidence: 0, finding: 0, scenario: 0, requests: 0, browserActions: 0 },
    evidence: [],
    findings: [],
    requirements: [],
    areas: [],
    scenarios: [],
    endpoints: [],
    activity: [],
    limitations: [],
  };
  const browsers = browserAvailability();
  const missingBrowsers = Object.entries(browsers).filter(([, ok]) => !ok).map(([b]) => b);
  if (missingBrowsers.length) state.limitations.push(`Browsers not installed for this Playwright version: ${missingBrowsers.join(", ")}. Cross-browser checks on them are blocked.`);
  if (!allowState) state.limitations.push("Mission is read-only (GET/HEAD/OPTIONS); create/update/delete behaviour was not exercised through the API tool.");

  const authStatus = Object.fromEntries(
    Object.entries(mission.authProfiles).map(([name, p]) => {
      const refs = Object.entries(p).filter(([k]) => k.endsWith("Secret")).map(([, v]) => String(v));
      return [name, { type: p.type, secretsAvailable: refs.every(secretAvailable), secretNames: refs }];
    }),
  );
  setActive(state);
  return {
    missionId: id,
    runDir,
    scope: { targetUrls: mission.targetUrls, allowedHosts: hosts, allowedMethods: methods, outOfScope: mission.outOfScope },
    limits,
    authProfiles: authStatus,
    browsers,
    safetyPolicy: [
      "Requests and navigation outside allowedHosts are refused; out-of-scope browser navigations are blocked and logged.",
      "State-changing HTTP methods require allowStateChanging=true.",
      "Request budget, minimum request spacing, timeouts and response-size caps are enforced server-side.",
      "Input-handling checks use inert markers only; reflection is reported as a suspected indicator.",
      "Credentials are referenced by secret name and redacted from all outputs, evidence and reports.",
      "Findings require tool-captured evidence and start as Potential; Confirmed requires verify_finding.",
    ],
  };
}
