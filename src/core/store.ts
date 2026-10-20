import fs from "node:fs";
import path from "node:path";
import type { Evidence, EvidenceKind, MissionState } from "./types.js";
import { PROJECT_ROOT, nowIso, padId, sha256, slug } from "./util.js";
import { redactText } from "./redact.js";

export const RUNS_ROOT = path.resolve(process.env.QA_RUNS_DIR ?? path.join(PROJECT_ROOT, "runs"));

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

let active: MissionState | null = null;

export function setActive(state: MissionState): void {
  active = state;
  fs.mkdirSync(path.join(state.mission.runDir, "evidence"), { recursive: true });
  persist();
}

/** Every tool except start_mission requires an authorised, active mission. */
export function requireMission(): MissionState {
  if (!active) {
    throw new ScopeError(
      "No active mission. Call start_mission with the target URLs, allowed hosts and an authorization statement before investigating.",
    );
  }
  return active;
}

export function persist(): void {
  if (!active) return;
  const file = path.join(active.mission.runDir, "state.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(active, null, 2));
  // On Windows a concurrent reader (e.g. the web UI) can briefly lock state.json,
  // making rename fail with EPERM/EBUSY. Retry briefly instead of failing the tool call.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function loadMission(missionId: string): MissionState {
  const file = path.join(RUNS_ROOT, slug(missionId, 80), "state.json");
  if (!fs.existsSync(file)) throw new Error(`No saved mission at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as MissionState;
}

export function logActivity(tool: string, summary: string): void {
  if (!active) return;
  active.activity.push({ at: nowIso(), tool, summary: redactText(summary).slice(0, 400) });
  persist();
}

/** Write an evidence file (already redacted by the caller) and register it. */
export function saveEvidence(input: {
  kind: EvidenceKind;
  label: string;
  source: string;
  summary: string;
  ext: string;
  data: string | Buffer;
}): Evidence {
  const state = requireMission();
  state.counters.evidence += 1;
  const id = padId("EV", state.counters.evidence);
  const fileName = `${id}-${slug(input.label)}.${input.ext}`;
  const rel = path.posix.join("evidence", fileName);
  const data = typeof input.data === "string" ? redactText(input.data) : input.data;
  fs.writeFileSync(path.join(state.mission.runDir, rel), data);
  const ev: Evidence = {
    id,
    kind: input.kind,
    label: input.label,
    file: rel,
    sha256: sha256(data),
    createdAt: nowIso(),
    source: redactText(input.source),
    summary: redactText(input.summary).slice(0, 500),
  };
  state.evidence.push(ev);
  persist();
  return ev;
}

export function assertEvidenceIds(ids: string[]): void {
  const state = requireMission();
  const known = new Set(state.evidence.map((e) => e.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    throw new Error(
      `Unknown evidence id(s): ${missing.join(", ")}. Evidence must be captured by a tool (capture_evidence, investigate_api, verify_finding) before it can be referenced.`,
    );
  }
}
