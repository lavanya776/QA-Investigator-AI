/**
 * Central redaction. Every string that leaves the server (tool results, evidence
 * files, reports) passes through here so credentials are never echoed back.
 */

const registered = new Map<string, string>(); // secret value -> label

export function registerSecret(label: string, value: string | undefined): void {
  if (value && value.length >= 4) registered.set(value, label);
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
export const SENSITIVE_KEY = /(pass(word)?|passwd|pwd|secret|token|api[-_]?key|authorization|credential|session[-_]?id|sid|ssn|card[-_]?number|cvv|private[-_]?key)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redactText(input: string): string {
  let out = input;
  for (const [value, label] of registered) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${label}]`);
  }
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} [REDACTED]`);
  out = out.replace(JWT, "[REDACTED:jwt]");
  return out;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) out[k] = "[REDACTED]";
    else if (/^set-cookie$/i.test(k)) out[k] = redactSetCookie(v);
    else out[k] = redactText(v);
  }
  return out;
}

/** Keep cookie names and attributes (useful evidence), mask values. */
export function redactSetCookie(value: string): string {
  return value
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((cookie) => cookie.replace(/^(\s*[^=;]+)=([^;]*)/, (_m, name: string) => `${name}=[REDACTED]`))
    .join(", ");
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "REDACTED";
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) u.searchParams.set(key, "REDACTED");
    }
    return redactText(u.toString());
  } catch {
    return redactText(raw);
  }
}

/**
 * Mask values under sensitive keys but keep the key and a length hint, so the
 * report can prove "passwordHash was exposed" without repeating the value.
 */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
        out[k] = `[REDACTED len=${String(v).length}]`;
      } else {
        out[k] = redactJson(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function redactDeep<T>(value: T): T {
  return redactJson(value) as T;
}
