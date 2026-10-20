import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root = parent of dist/ (or src/ when run from source). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const nowIso = (): string => new Date().toISOString();

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

export function slug(value: string, max = 40): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "item"
  );
}

export function padId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

/** Normalise a URL path so that /orders/42 and /orders/43 map to /orders/:id. */
export function normalizePath(p: string): string {
  const clean = p.split("?")[0].split("#")[0];
  const segs = clean.split("/").map((s) => (ID_SEGMENT.test(s) ? ":id" : s.toLowerCase()));
  const joined = segs.join("/").replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}

/** "GET http://host/a/1?x=1" -> "GET host/a/:id?x" */
export function resourceKey(input: { method?: string; url?: string; endpoint?: string }): string {
  if (input.endpoint) {
    const m = input.endpoint.trim().match(/^([A-Z]+)\s+(.+)$/i);
    if (m) {
      const p = m[2].startsWith("http") ? safeUrl(m[2]) : null;
      const pathPart = p ? `${p.host}${normalizePath(p.pathname)}` : normalizePath(templateToPath(m[2]));
      // keep query parameter NAMES so "?search" and "?sort" are distinct resources
      const query = p ? [...p.searchParams.keys()].join("&") : (m[2].split("?")[1] ?? "").split("&").map((kv) => kv.split("=")[0]).filter(Boolean).sort().join("&");
      return `${m[1].toUpperCase()} ${pathPart}${query ? `?${query}` : ""}`;
    }
  }
  if (input.url) {
    const u = safeUrl(input.url);
    if (u) {
      const qKeys = [...u.searchParams.keys()].sort();
      return `${(input.method ?? "PAGE").toUpperCase()} ${u.host}${normalizePath(u.pathname)}${qKeys.length ? `?${qKeys.join("&")}` : ""}`;
    }
    return `${(input.method ?? "PAGE").toUpperCase()} ${input.url}`;
  }
  return "UNKNOWN";
}

/** Convert OpenAPI style /orders/{id} to /orders/:id */
export function templateToPath(p: string): string {
  return p.replace(/\{[^}]+\}/g, ":id");
}

export function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[0-9a-f]{8,}/g, " ")
      .replace(/\d+/g, " ")
      .split(/[^a-z]+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Normalised error signature: strips numbers, ids, quotes and whitespace noise. */
export function normalizeSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<uuid>")
    .replace(/\d+/g, "<n>")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Read a JSON path: "items.0.price", "items[0].price" or JSONPath-style "$.items[0].price" */
export function getPath(obj: unknown, p: string): unknown {
  const normalized = p
    .replace(/^\$\.?/, "")
    .replace(/\[\s*['"]?([^\]'"]+)['"]?\s*\]/g, ".$1");
  let cur: unknown = obj;
  for (const part of normalized.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
