export type AuthProfile =
  | { type: "bearer"; tokenSecret: string }
  | { type: "basic"; usernameSecret: string; passwordSecret: string }
  | { type: "header"; headerName: string; valueSecret: string }
  | {
      type: "login";
      loginUrl: string;
      usernameField?: string;
      passwordField?: string;
      usernameSecret: string;
      passwordSecret: string;
      /** Dotted JSON path of the token in the login response, e.g. "token". Omit to use the session cookie. */
      tokenPath?: string;
    };

export interface MissionLimits {
  maxRequests: number;
  minIntervalMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxBrowserActions: number;
}

export interface Mission {
  id: string;
  name: string;
  objective: string;
  environment: string;
  targetUrls: string[];
  allowedHosts: string[];
  authorization: { statement: string; authorizedBy: string; scopeNotes?: string };
  allowStateChanging: boolean;
  allowedMethods: string[];
  outOfScope: string[];
  limits: MissionLimits;
  authProfiles: Record<string, AuthProfile>;
  createdAt: string;
  runDir: string;
}

export type EvidenceKind =
  | "screenshot"
  | "dom"
  | "console"
  | "network"
  | "storage"
  | "cookies"
  | "page_inspection"
  | "api_exchange"
  | "verification"
  | "note";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  file: string; // relative to run dir
  sha256: string;
  createdAt: string;
  source: string; // url or endpoint
  summary: string;
}

export type FindingStatus = "Confirmed" | "Potential" | "Not Reproduced" | "Blocked";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface VerificationRecord {
  at: string;
  method: "api" | "browser" | "evidence_review";
  attempts: number;
  reproduced: number;
  errors: string[];
  resultingStatus: FindingStatus;
  evidenceIds: string[];
  notes: string;
}

export interface Finding {
  id: string;
  title: string;
  category: string;
  affectedUrl?: string;
  affectedEndpoint?: string;
  resourceKey: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  severity: Severity;
  severityRationale: string;
  priority: "P1" | "P2" | "P3" | "P4";
  priorityRationale: string;
  status: FindingStatus;
  securityConfidence?: "suspected" | "verified";
  preconditions: string[];
  steps: string[];
  expected: string;
  expectedSource: string;
  actual: string;
  errorSignature?: string;
  evidenceIds: string[];
  impact: string;
  scope: string;
  suggestedFollowUp: string;
  requirementIds: string[];
  scenarioIds: string[];
  possibleDuplicateOf?: { id: string; score: number };
  verifications: VerificationRecord[];
}

export type ScenarioStatus = "planned" | "passed" | "failed" | "blocked" | "partial" | "not_tested";

export interface Requirement {
  id: string;
  text: string;
  source: string;
  type: string;
}

export interface CoverageArea {
  id: string;
  category: string;
  name: string;
  description: string;
  risk: { impact: number; likelihood: number; exposure: number; score: number };
  rationale: string;
}

export interface Scenario {
  id: string;
  areaId: string;
  title: string;
  technique: string;
  requirementIds: string[];
  endpointKeys: string[];
  status: ScenarioStatus;
  observation?: string;
  blockedReason?: string;
  evidenceIds: string[];
  findingIds: string[];
  updatedAt: string;
}

export interface Endpoint {
  key: string; // "GET /api/orders/:id"
  method: string;
  path: string;
  source: string;
  requiresAuth?: boolean;
  requestCount: number;
  statusesSeen: number[];
  lastTestedAt?: string;
}

export interface ActivityEntry {
  at: string;
  tool: string;
  summary: string;
}

export interface MissionState {
  mission: Mission;
  counters: { evidence: number; finding: number; scenario: number; requests: number; browserActions: number };
  evidence: Evidence[];
  findings: Finding[];
  requirements: Requirement[];
  areas: CoverageArea[];
  scenarios: Scenario[];
  endpoints: Endpoint[];
  activity: ActivityEntry[];
  limitations: string[];
}
