import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./util.js";
import { registerSecret } from "./redact.js";

/**
 * Secrets are referenced by NAME (e.g. "QA_USER_PASSWORD"), never passed as
 * literal values through the conversation. Resolution order:
 *   1. process.env[NAME]
 *   2. JSON file pointed to by QA_SECRETS_FILE (default ./.qa-secrets.json)
 */
let fileCache: Record<string, string> | null = null;

function loadFile(): Record<string, string> {
  if (fileCache) return fileCache;
  const configured = process.env.QA_SECRETS_FILE ?? ".qa-secrets.json";
  const full = path.isAbsolute(configured) ? configured : path.join(PROJECT_ROOT, configured);
  try {
    fileCache = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, string>;
  } catch {
    fileCache = {};
  }
  return fileCache;
}

export function resolveSecret(name: string): string {
  const value = process.env[name] ?? loadFile()[name];
  if (!value) {
    throw new Error(
      `Secret "${name}" is not available. Set environment variable ${name} or add it to the secrets file (QA_SECRETS_FILE). The value is never echoed.`,
    );
  }
  // Identifiers such as usernames are not credentials; redacting short common
  // values like "alice" would garble unrelated output (paths, names).
  if (CREDENTIAL_NAME.test(name)) registerSecret(name, value);
  return value;
}

const CREDENTIAL_NAME = /(pass|pwd|token|secret|key|cookie|cred|session|auth)/i;

/** Replace {{secret:NAME}} placeholders server-side; values are registered for redaction. */
export function substituteSecrets(input: string): string {
  return input.replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_m, name: string) => resolveSecret(name));
}

export function secretAvailable(name: string): boolean {
  return Boolean(process.env[name] ?? loadFile()[name]);
}
