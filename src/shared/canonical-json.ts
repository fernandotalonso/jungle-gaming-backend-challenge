import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization used for payload hashing (idempotency).
 * Object keys are recursively sorted; array order is preserved (it is
 * semantically meaningful); `undefined` properties are omitted (matching
 * JSON.stringify semantics); primitive values use their JSON representation.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return primitive(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, propertyValue]) => propertyValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, propertyValue]) => `${JSON.stringify(key)}:${serialize(propertyValue)}`);
  return `{${entries.join(',')}}`;
}

function primitive(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // finite numbers only — payload values come from parsed JSON
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number is not serializable: ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'undefined':
      return 'null'; // standalone undefined (e.g. inside arrays)
    default:
      throw new TypeError(`canonicalJson: unsupported value type: ${typeof value}`);
  }
}

/** SHA-256 hex digest of the canonical JSON representation. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
