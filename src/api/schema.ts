/**
 * Minimal JSON Schema subset validator (type, required, properties,
 * additionalProperties, items, enum, const, min/max, minLength/maxLength,
 * pattern, format: email|date-time|uri, minItems/maxItems, nullable via type
 * arrays). Kept dependency-free on purpose; reports every violation path.
 */
export type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
};

export function validateSchema(value: unknown, schema: Schema, path = "$", errors: string[] = []): string[] {
  if (errors.length > 50) return errors;
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const ok = allowed.some((a) => a === t || (a === "number" && t === "integer"));
    if (!ok) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${t}`);
      return errors;
    }
  }
  if (schema.enum && !(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
    if (typeof schema.format === "string" && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) errors.push(`${path}: invalid ${schema.format} format`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    if (schema.items && typeof schema.items === "object") value.forEach((v, i) => validateSchema(v, schema.items as Schema, `${path}[${i}]`, errors));
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in obj) validateSchema(obj[k], sub, `${path}.${k}`, errors);
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${path}: unexpected property "${k}"`);
    }
  }
  return errors;
}
