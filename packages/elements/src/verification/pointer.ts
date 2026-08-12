/**
 * Server-generated submission keys and JSON-pointer resolution.
 *
 * Mirrors the backend exactly (gemina-api-v2 `data_validator.py` /
 * `validator/utils.py`) so that what the component resolves client-side is
 * what the server will resolve when it scores the submission:
 * - key regex `^label:([^|]+)\|ptr:(/.*)$`
 * - `~1` unescaped before `~0`
 * - list segments must be all digits
 * - unresolvable paths are a sentinel, distinct from a stored `null`.
 */

export interface SchemaKey {
  /** The raw key — submitted verbatim as a property name in the feedback body. */
  raw: string;
  /** Human-meaningful label; the only key format the host app ever sees. */
  label: string;
  /** JSON pointer into the extraction values payload. */
  pointer: string;
}

const KEY_RE = /^label:([^|]+)\|ptr:(\/.*)$/;

/** Parse one schema key, or null for a malformed entry (the backend skips those quietly too). */
export function parseSchemaKey(raw: string): SchemaKey | null {
  const match = KEY_RE.exec(raw);
  if (match === null) {
    return null;
  }
  return { raw, label: match[1] as string, pointer: match[2] as string };
}

/** "Path did not resolve" — deliberately distinct from a stored null value. */
export const NOT_FOUND: unique symbol = Symbol('gemina-verification-not-found');
export type NotFound = typeof NOT_FOUND;

/** Resolve a JSON pointer against a document, backend-compatible (see module docs). */
export function resolvePointer(doc: unknown, pointer: string): unknown | NotFound {
  if (pointer === '') {
    return doc;
  }
  if (!pointer.startsWith('/')) {
    return NOT_FOUND;
  }
  let current: unknown = doc;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return NOT_FOUND;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return NOT_FOUND;
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!(segment in (current as Record<string, unknown>))) {
        return NOT_FOUND;
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return NOT_FOUND;
    }
  }
  return current;
}
