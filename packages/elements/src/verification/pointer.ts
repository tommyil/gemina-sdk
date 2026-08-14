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
 *
 * Known divergences from the backend (all client-stricter; unreachable via
 * server-generated keys):
 * - Python's `$` in the key regex also matches before a trailing newline;
 *   JS `$` (no `m` flag) matches only at end-of-string.
 * - The backend's `pointer.lstrip("/")` collapses multiple leading slashes
 *   (`//a` resolves `doc["a"]`); here that is NOT_FOUND (RFC-6901-correct).
 * - Python's `isdigit()` accepts non-ASCII unicode digits as list indices;
 *   `/^\d+$/` here is ASCII-only.
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
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return NOT_FOUND;
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return NOT_FOUND;
    }
  }
  return current;
}

/**
 * `vendor_name` -> `vendorName`. The client's ONLY casing rule.
 *
 * Lives here, alone, on purpose. Schema pointers are snake_case while the
 * payload is camelCase, so this rule decides whether a pointer resolves at
 * all — and a second copy that drifts from it is exactly how a field silently
 * stops resolving (see the grossLinePrice alias bug: a wire name this rule
 * could not reproduce made an extracted value render as "Not detected" and
 * score a false `extra` on every row).
 */
export function snakeToCamel(segment: string): string {
  return segment.replace(/_([a-zA-Z0-9])/g, (_unused, ch: string) => ch.toUpperCase());
}
