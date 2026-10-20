import { assertInScope, assertInputSize, assertMethodAllowed, consumeRequestBudget, makeProbeMarker } from "../core/safety.js";
import { resolveSecret, substituteSecrets } from "../core/secrets.js";
import { registerSecret, redactHeaders, redactJson, redactText, redactUrl } from "../core/redact.js";
import { persist, requireMission, saveEvidence } from "../core/store.js";
import { errorMessage, getPath, normalizePath, nowIso, templateToPath, truncate } from "../core/util.js";
import { analyzeExchange, type Observation } from "./analyze.js";
import { validateSchema, type Schema } from "./schema.js";

export interface ApiExpect {
  status?: number[];
  jsonSchema?: Schema;
  headersPresent?: string[];
  headersAbsent?: string[];
  bodyIncludes?: string[];
  bodyExcludes?: string[];
  maxDurationMs?: number;
}

export interface ApiRequest {
  label?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  json?: unknown;
  body?: string;
  contentType?: string;
  auth?: string;
  authMode?: "valid" | "none" | "invalid";
  origin?: string;
  followRedirects?: boolean;
  useProbeMarker?: boolean;
  expect?: ApiExpect;
  repeat?: number;
}

export interface Exchange {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Record<string, string>;
  bodyText: string;
  json: unknown;
  truncated: boolean;
  sizeBytes: number;
  error?: string;
}

const authCache = new Map<string, { header: string; value: string }>();

async function authHeader(profileName: string, mode: "valid" | "invalid"): Promise<{ header: string; value: string }> {
  const state = requireMission();
  const profile = state.mission.authProfiles[profileName];
  if (!profile) throw new Error(`Unknown auth profile "${profileName}". Defined: ${Object.keys(state.mission.authProfiles).join(", ") || "none"}`);
  if (mode === "invalid") {
    if (profile.type === "basic") return { header: "authorization", value: `Basic ${Buffer.from("qa-invalid:qa-invalid").toString("base64")}` };
    if (profile.type === "header") return { header: profile.headerName.toLowerCase(), value: "qa-invalid-credential" };
    if (profile.type === "login" && !profile.tokenPath) return { header: "cookie", value: "sid=qa-invalid-session" };
    return { header: "authorization", value: "Bearer qa.invalid.token" };
  }
  const cached = authCache.get(profileName);
  if (cached) return cached;
  let result: { header: string; value: string };
  if (profile.type === "bearer") {
    result = { header: "authorization", value: `Bearer ${resolveSecret(profile.tokenSecret)}` };
  } else if (profile.type === "basic") {
    const raw = `${resolveSecret(profile.usernameSecret)}:${resolveSecret(profile.passwordSecret)}`;
    const encoded = Buffer.from(raw).toString("base64");
    registerSecret(`${profileName}-basic`, encoded);
    result = { header: "authorization", value: `Basic ${encoded}` };
  } else if (profile.type === "header") {
    result = { header: profile.headerName.toLowerCase(), value: resolveSecret(profile.valueSecret) };
  } else {
    assertInScope(profile.loginUrl);
    await consumeRequestBudget();
    const body = { [profile.usernameField ?? "username"]: resolveSecret(profile.usernameSecret), [profile.passwordField ?? "password"]: resolveSecret(profile.passwordSecret) };
    const resp = await fetch(profile.loginUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(state.mission.limits.timeoutMs) });
    if (resp.status >= 400) throw new Error(`Login for profile "${profileName}" failed with HTTP ${resp.status}; credentials or login endpoint may be wrong. Mark dependent checks Blocked.`);
    if (profile.tokenPath) {
      const token = String(getPath(await resp.json(), profile.tokenPath) ?? "");
      if (!token) throw new Error(`Login response for "${profileName}" had no value at "${profile.tokenPath}"`);
      registerSecret(`${profileName}-token`, token);
      result = { header: "authorization", value: `Bearer ${token}` };
    } else {
      const cookies = resp.headers.getSetCookie().map((c) => c.split(";")[0]);
      if (!cookies.length) throw new Error(`Login for "${profileName}" returned no session cookie`);
      for (const c of cookies) registerSecret(`${profileName}-cookie`, c.split("=").slice(1).join("="));
      result = { header: "cookie", value: cookies.join("; ") };
    }
  }
  authCache.set(profileName, result);
  return result;
}

export function clearAuthCache(profile?: string): void {
  if (profile) authCache.delete(profile);
  else authCache.clear();
}

function substituteProbe<T>(value: T, marker: string): T {
  if (typeof value === "string") return value.split("{{probe}}").join(marker) as T;
  if (Array.isArray(value)) return value.map((v) => substituteProbe(v, marker)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteProbe(v, marker)])) as T;
  return value;
}

async function readLimited(resp: Response, limit: number): Promise<{ text: string; truncated: boolean; size: number }> {
  if (!resp.body) return { text: "", truncated: false, size: 0 };
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      chunks.push(value.slice(0, value.byteLength - (size - limit)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated, size };
}

/** Low-level send; used by investigate_api and verify_finding. */
export async function send(req: ApiRequest, marker?: string): Promise<{ exchange: Exchange; url: string; requestHeaders: Record<string, string>; requestBody?: string }> {
  const state = requireMission();
  const r = marker ? substituteProbe(req, marker) : req;
  const method = r.method.toUpperCase();
  const url = new URL(r.url);
  for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, String(v));
  assertInScope(url.toString());
  assertMethodAllowed(method);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = substituteSecrets(v);
  let body: string | undefined;
  if (r.json !== undefined) {
    body = substituteSecrets(JSON.stringify(r.json));
    headers["content-type"] ??= "application/json";
  } else if (r.body !== undefined) {
    body = substituteSecrets(r.body);
    if (r.contentType) headers["content-type"] = r.contentType;
  }
  assertInputSize(body, "request body");
  if (r.origin) headers.origin = r.origin;
  const mode = r.authMode ?? (r.auth ? "valid" : "none");
  if (r.auth && mode !== "none") {
    const a = await authHeader(r.auth, mode);
    headers[a.header] = a.value;
  }

  await consumeRequestBudget();
  const started = Date.now();
  let exchange: Exchange;
  try {
    const resp = await fetch(url, { method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : body, redirect: r.followRedirects ? "follow" : "manual", signal: AbortSignal.timeout(state.mission.limits.timeoutMs) });
    const read = await readLimited(resp, state.mission.limits.maxResponseBytes);
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => (respHeaders[k] = v));
    const sc = resp.headers.getSetCookie();
    if (sc.length) respHeaders["set-cookie"] = sc.join(", ");
    let json: unknown;
    if ((respHeaders["content-type"] ?? "").includes("json") || /^\s*[[{]/.test(read.text)) {
      try {
        json = JSON.parse(read.text);
      } catch {
        json = undefined;
      }
    }
    exchange = { status: resp.status, statusText: resp.statusText, durationMs: Date.now() - started, headers: respHeaders, bodyText: read.text, json, truncated: read.truncated, sizeBytes: read.size };
  } catch (err) {
    const msg = errorMessage(err);
    exchange = { status: 0, statusText: "", durationMs: Date.now() - started, headers: {}, bodyText: "", json: undefined, truncated: false, sizeBytes: 0, error: /timeout|aborted/i.test(msg) ? `Timed out after ${state.mission.limits.timeoutMs}ms` : msg };
  }
  linkEndpoint(method, url, exchange.status);
  return { exchange, url: url.toString(), requestHeaders: headers, requestBody: body };
}

function linkEndpoint(method: string, url: URL, status: number): void {
  const state = requireMission();
  const actual = normalizePath(url.pathname).split("/");
  for (const ep of state.endpoints) {
    if (ep.method !== method) continue;
    const tpl = normalizePath(templateToPath(ep.path)).split("/");
    if (tpl.length !== actual.length) continue;
    if (tpl.every((seg, i) => seg === actual[i] || seg.startsWith(":"))) {
      ep.requestCount += 1;
      if (status && !ep.statusesSeen.includes(status)) ep.statusesSeen.push(status);
      ep.lastTestedAt = nowIso();
    }
  }
  persist();
}

function checkExpectations(ex: Exchange, e: ApiExpect | undefined): { evaluated: boolean; passed: boolean; failures: string[] } {
  if (!e) return { evaluated: false, passed: true, failures: [] };
  const failures: string[] = [];
  if (e.status && !e.status.includes(ex.status)) failures.push(`status ${ex.status} not in expected [${e.status.join(", ")}]`);
  if (e.jsonSchema) {
    if (ex.json === undefined) failures.push("expected JSON body but response was not JSON");
    else failures.push(...validateSchema(ex.json, e.jsonSchema).map((m) => `schema: ${m}`));
  }
  for (const h of e.headersPresent ?? []) if (!(h.toLowerCase() in ex.headers)) failures.push(`header "${h}" missing`);
  for (const h of e.headersAbsent ?? []) if (h.toLowerCase() in ex.headers) failures.push(`header "${h}" present`);
  for (const s of e.bodyIncludes ?? []) if (!ex.bodyText.includes(s)) failures.push(`body does not include "${s}"`);
  for (const s of e.bodyExcludes ?? []) if (ex.bodyText.includes(s)) failures.push(`body includes "${s}"`);
  if (e.maxDurationMs && ex.durationMs > e.maxDurationMs) failures.push(`duration ${ex.durationMs}ms > ${e.maxDurationMs}ms`);
  return { evaluated: true, passed: failures.length === 0, failures };
}

export function exchangeEvidence(label: string, method: string, url: string, sent: { requestHeaders: Record<string, string>; requestBody?: string }, ex: Exchange, extra: Record<string, unknown> = {}) {
  const payload = {
    request: { method, url: redactUrl(url), headers: redactHeaders(sent.requestHeaders), body: sent.requestBody ? truncate(redactText(safeRedactBody(sent.requestBody)), 4000) : undefined },
    response: {
      status: ex.status,
      statusText: ex.statusText,
      error: ex.error,
      durationMs: ex.durationMs,
      headers: redactHeaders(ex.headers),
      sizeBytes: ex.sizeBytes,
      truncated: ex.truncated,
      body: ex.json !== undefined ? redactJson(ex.json) : truncate(redactText(ex.bodyText), 20000),
    },
    ...extra,
  };
  return saveEvidence({ kind: "api_exchange", label, source: `${method} ${redactUrl(url)}`, summary: `${method} ${new URL(url).pathname} -> ${ex.status || ex.error}`, ext: "json", data: JSON.stringify(payload, null, 2) });
}

function safeRedactBody(body: string): string {
  try {
    return JSON.stringify(redactJson(JSON.parse(body)));
  } catch {
    return body;
  }
}

export async function investigateApi(requests: ApiRequest[]) {
  const results: Array<Record<string, unknown>> = [];
  for (const req of requests) {
    const label = req.label ?? `${req.method} ${req.url}`;
    const marker = req.useProbeMarker ? makeProbeMarker() : undefined;
    const attempts = Math.min(Math.max(req.repeat ?? 1, 1), 5);
    try {
      const runs: Array<Awaited<ReturnType<typeof send>>> = [];
      for (let i = 0; i < attempts; i++) runs.push(await send(req, marker));
      const last = runs[runs.length - 1];
      const ex = last.exchange;
      const observations: Observation[] = ex.error
        ? []
        : analyzeExchange({ url: last.url, status: ex.status, headers: ex.headers, bodyText: ex.bodyText, json: ex.json, requestOrigin: req.origin, authenticated: Boolean(req.auth) && (req.authMode ?? "valid") === "valid", contentType: ex.headers["content-type"] ?? "" });
      const expectation = checkExpectations(ex, req.expect);
      let reflection: Record<string, unknown> | undefined;
      if (marker) {
        reflection = { marker, reflected: ex.bodyText.includes(marker), contentType: ex.headers["content-type"], note: "Reflection of an inert marker is an input-handling indicator only (suspected), not proof of exploitability." };
      }
      const repeatSummary =
        attempts > 1
          ? { attempts, statuses: runs.map((r) => r.exchange.status), identicalBodies: runs.every((r) => r.exchange.bodyText === runs[0].exchange.bodyText) }
          : undefined;
      const ev = exchangeEvidence(label, req.method.toUpperCase(), last.url, last, ex, { observations, expectation, reflection, repeat: repeatSummary });
      results.push({
        label,
        evidenceId: ev.id,
        request: `${req.method.toUpperCase()} ${redactUrl(last.url)}`,
        authProfile: req.auth ? `${req.auth} (${req.authMode ?? "valid"})` : "none",
        status: ex.status,
        error: ex.error,
        durationMs: ex.durationMs,
        contentType: ex.headers["content-type"],
        headers: redactHeaders(ex.headers),
        sizeBytes: ex.sizeBytes,
        truncated: ex.truncated,
        body: ex.json !== undefined ? truncate(JSON.stringify(redactJson(ex.json)), 2500) : truncate(redactText(ex.bodyText), 1500),
        expectation,
        observations,
        reflection,
        repeat: repeatSummary,
      });
    } catch (err) {
      results.push({ label, blocked: true, error: redactText(errorMessage(err)) });
    }
  }
  const state = requireMission();
  return { results, budget: { used: state.counters.requests, max: state.mission.limits.maxRequests } };
}
