import { SENSITIVE_KEY } from "../core/redact.js";

/**
 * Passive analysis of an HTTP exchange. Produces observations (indicators),
 * never conclusions: the investigator decides whether something is a finding.
 */
export interface Observation {
  type: string;
  detail: string;
  confidence: "indicator" | "strong-indicator";
}

const STACK_TRACE = [
  /\bat [\w$.<>]+ \([^)]*:\d+:\d+\)/,
  /Traceback \(most recent call last\)/,
  /\bat [\w$.]+\.java:\d+\)/,
  /(SQLSTATE\[|SQLITE_ERROR|ORA-\d{5}|syntax error at or near|ER_PARSE_ERROR)/i,
  /\b(TypeError|ReferenceError|SyntaxError|NullPointerException|ValueError):/,
];

export function analyzeExchange(input: {
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  json: unknown;
  requestOrigin?: string;
  authenticated: boolean;
  contentType: string;
}): Observation[] {
  const obs: Observation[] = [];
  const h = (name: string) => input.headers[name.toLowerCase()];
  const isHtml = input.contentType.includes("text/html");
  const isHttps = input.url.startsWith("https:");

  if (!h("x-content-type-options")) obs.push({ type: "security-header-missing", detail: "X-Content-Type-Options is absent", confidence: "indicator" });
  if (isHtml) {
    if (!h("content-security-policy")) obs.push({ type: "security-header-missing", detail: "Content-Security-Policy is absent on an HTML response", confidence: "indicator" });
    const csp = h("content-security-policy") ?? "";
    if (!h("x-frame-options") && !csp.includes("frame-ancestors")) obs.push({ type: "security-header-missing", detail: "No X-Frame-Options or CSP frame-ancestors (clickjacking protection) on HTML response", confidence: "indicator" });
    if (!h("referrer-policy")) obs.push({ type: "security-header-missing", detail: "Referrer-Policy is absent", confidence: "indicator" });
  }
  if (isHttps && !h("strict-transport-security")) obs.push({ type: "security-header-missing", detail: "Strict-Transport-Security absent on HTTPS response", confidence: "indicator" });
  const powered = h("x-powered-by");
  if (powered) obs.push({ type: "technology-disclosure", detail: `X-Powered-By: ${powered}`, confidence: "indicator" });
  const server = h("server");
  if (server && /\d/.test(server)) obs.push({ type: "technology-disclosure", detail: `Server header discloses version: ${server}`, confidence: "indicator" });

  const acao = h("access-control-allow-origin");
  if (acao) {
    const creds = h("access-control-allow-credentials") === "true";
    if (acao === "*" && creds) obs.push({ type: "cors-misconfiguration", detail: "ACAO '*' combined with Allow-Credentials true", confidence: "strong-indicator" });
    else if (input.requestOrigin && acao === input.requestOrigin && creds) obs.push({ type: "cors-origin-reflection", detail: `Arbitrary Origin "${input.requestOrigin}" reflected with credentials allowed`, confidence: "strong-indicator" });
    else if (input.requestOrigin && acao === input.requestOrigin) obs.push({ type: "cors-origin-reflection", detail: `Request Origin "${input.requestOrigin}" reflected in ACAO (no credentials)`, confidence: "indicator" });
    else if (acao === "*") obs.push({ type: "cors-wildcard", detail: "ACAO is '*' (acceptable for public data only)", confidence: "indicator" });
  }

  for (const re of STACK_TRACE) {
    const m = input.bodyText.match(re);
    if (m) {
      obs.push({ type: "error-detail-disclosure", detail: `Response body contains stack trace / internal error text: "${m[0].slice(0, 120)}"`, confidence: "strong-indicator" });
      break;
    }
  }
  if (input.status >= 500) obs.push({ type: "server-error", detail: `Server returned ${input.status}; check whether input should have produced a 4xx`, confidence: "indicator" });

  if (input.json !== undefined) {
    const found = new Set<string>();
    const walk = (v: unknown, p: string, depth: number) => {
      if (depth > 8 || found.size > 10) return;
      if (Array.isArray(v)) v.slice(0, 20).forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (SENSITIVE_KEY.test(k) && !/^(token_type|expires_in)$/i.test(k)) found.add(`${p}.${k}`.replace(/\[\d+\]/g, "[]"));
          walk(x, `${p}.${k}`, depth + 1);
        }
      }
    };
    walk(input.json, "$", 0);
    if (found.size) obs.push({ type: "sensitive-field-in-response", detail: `Response contains sensitive-looking fields: ${[...found].slice(0, 8).join(", ")} (values masked in evidence)`, confidence: "indicator" });
  }

  if (input.authenticated && input.status === 200 && !/no-store|private/i.test(h("cache-control") ?? "")) {
    obs.push({ type: "cache-control", detail: "Authenticated response without Cache-Control no-store/private", confidence: "indicator" });
  }
  return obs;
}
