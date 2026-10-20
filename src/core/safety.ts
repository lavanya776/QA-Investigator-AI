import { randomBytes } from "node:crypto";
import { ScopeError, persist, requireMission } from "./store.js";
import { safeUrl, sleep } from "./util.js";

/**
 * Safety policy. The investigator only performs non-destructive checks against
 * explicitly authorised hosts, within request budgets. These guards run inside
 * the server so they hold regardless of what the orchestrating model asks for.
 */

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    const hostNoPort = h.split(":")[0];
    return hostNoPort.endsWith(`.${base}`) || hostNoPort === base;
  }
  return h === p || (!p.includes(":") && h.split(":")[0] === p);
}

export function isInScope(rawUrl: string): boolean {
  const state = requireMission();
  const u = safeUrl(rawUrl);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  if (!state.mission.allowedHosts.some((p) => hostMatches(u.host, p))) return false;
  return !state.mission.outOfScope.some((rule) => rawUrl.includes(rule));
}

export function assertInScope(rawUrl: string): URL {
  const state = requireMission();
  const u = safeUrl(rawUrl);
  if (!u || !/^https?:$/.test(u.protocol)) throw new ScopeError(`Only absolute http(s) URLs are allowed: ${rawUrl}`);
  if (!state.mission.allowedHosts.some((p) => hostMatches(u.host, p))) {
    throw new ScopeError(
      `Host "${u.host}" is outside the authorised scope (${state.mission.allowedHosts.join(", ")}). Stop and confirm scope with the user rather than widening it implicitly.`,
    );
  }
  const rule = state.mission.outOfScope.find((r) => rawUrl.includes(r));
  if (rule) throw new ScopeError(`URL matches an out-of-scope rule ("${rule}"): ${rawUrl}`);
  return u;
}

export function assertMethodAllowed(method: string): void {
  const state = requireMission();
  const m = method.toUpperCase();
  if (!state.mission.allowedMethods.includes(m)) {
    throw new ScopeError(
      `HTTP method ${m} is not authorised for this mission (allowed: ${state.mission.allowedMethods.join(", ")}). State-changing methods require allowStateChanging=true in start_mission.`,
    );
  }
}

const MAX_INPUT_BYTES = 64 * 1024;

/** Bound the size of anything the investigator sends (request bodies, typed values). */
export function assertInputSize(value: string | undefined, what: string): void {
  if (value && Buffer.byteLength(value) > MAX_INPUT_BYTES) {
    throw new ScopeError(`${what} exceeds ${MAX_INPUT_BYTES} bytes; oversized inputs are not permitted.`);
  }
}

/**
 * Inert, alphanumeric marker for input-handling checks. Finding the marker
 * echoed back only shows that input is reflected; it is an indicator to be
 * reported as "suspected", never proof of an exploitable vulnerability.
 */
export function makeProbeMarker(): string {
  return `qaprobe${randomBytes(4).toString("hex")}`;
}

let lastRequestAt = 0;

/** Enforce the per-mission request budget and minimum spacing between requests. */
export async function consumeRequestBudget(count = 1): Promise<void> {
  const state = requireMission();
  if (state.counters.requests + count > state.mission.limits.maxRequests) {
    throw new ScopeError(
      `Request budget exhausted (${state.counters.requests}/${state.mission.limits.maxRequests}). Report the remaining work as not tested rather than raising the limit silently.`,
    );
  }
  const wait = lastRequestAt + state.mission.limits.minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  state.counters.requests += count;
  persist();
}

export function consumeBrowserActions(count: number): void {
  const state = requireMission();
  if (state.counters.browserActions + count > state.mission.limits.maxBrowserActions) {
    throw new ScopeError(
      `Browser action budget exhausted (${state.counters.browserActions}/${state.mission.limits.maxBrowserActions}).`,
    );
  }
  state.counters.browserActions += count;
  persist();
}
