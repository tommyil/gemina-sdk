import { isValueObject } from './classify';
import { NOT_FOUND, parseSchemaKey, resolvePointer } from './pointer';
import type { NotFound, SchemaKey } from './pointer';

/** One server-mandated submission slot, bound to whatever was extracted there. */
export interface FieldBinding {
  key: SchemaKey;
  /** Raw extracted JSON value (unwrapped from `{value,...}`), or NOT_FOUND. */
  extracted: unknown | NotFound;
}

/**
 * Resolve a schema pointer the way the server will, then unwrap.
 * Two payload-shape mismatches are normalized here:
 * - pointer ends in `/value` but the payload stores a bare primitive → resolve the parent;
 * - pointer stops at a `{value, coordinates?, confidence?}` wrapper → take `.value`.
 */
export function resolveSchemaValue(values: unknown, pointer: string): unknown | NotFound {
  let node = resolvePointer(values, pointer);
  if (node === NOT_FOUND && pointer.endsWith('/value')) {
    node = resolvePointer(values, pointer.slice(0, -'/value'.length));
  }
  if (node !== NOT_FOUND && isValueObject(node)) {
    return node.value;
  }
  return node;
}

/** Parse + resolve every schema key. Malformed entries are skipped (backend parity). */
export function buildBindings(validationSchema: string[], values: unknown): FieldBinding[] {
  const bindings: FieldBinding[] = [];
  for (const raw of validationSchema) {
    const key = parseSchemaKey(raw);
    if (key === null) {
      continue;
    }
    bindings.push({ key, extracted: resolveSchemaValue(values, key.pointer) });
  }
  return bindings;
}

/**
 * Index bindings by the pointer the CLASSIFIER reports for a field (which is
 * always the wrapper-level pointer): a schema pointer `P/value` and a
 * classifier pointer `P` are the same field.
 */
export function indexBindingsByFieldPointer(bindings: FieldBinding[]): Map<string, FieldBinding> {
  const map = new Map<string, FieldBinding>();
  for (const binding of bindings) {
    const pointer = binding.key.pointer;
    const fieldPointer = pointer.endsWith('/value')
      ? pointer.slice(0, -'/value'.length)
      : pointer;
    map.set(fieldPointer, binding);
  }
  return map;
}

/**
 * What an editable input is prefilled with. RAW value stringification only —
 * display formatting (`formatValue`) must never round-trip into a submission
 * (a locale-formatted "1,500" or date would score as a correction).
 */
export function toInputString(extracted: unknown | NotFound): string {
  if (extracted === NOT_FOUND || extracted === null || extracted === undefined) {
    return '';
  }
  if (typeof extracted === 'object') {
    return JSON.stringify(extracted);
  }
  return String(extracted);
}

export interface SubmissionResult {
  /** Body for `ExtractionValidationInDTO.data` — raw schema keys, ALL asserted fields. */
  data: Record<string, unknown>;
  /** The same entries keyed by human label — handed to `onComplete`. */
  byLabel: Record<string, unknown>;
  confirmed: number;
  corrected: number;
}

/**
 * Compose the one-shot feedback body.
 *
 * `edits` holds ONLY dirty keys (raw schema key → current input string; the
 * UI removes an entry when the input returns to its initial string).
 *
 * Rules (verified against the backend DataValidator):
 * - untouched + extracted (even extracted-null): submit the raw value as-is
 *   → server compares equal → scored a confirmation;
 * - untouched + never extracted: OMIT — the user asserted nothing, and
 *   submitting null would force a false "missing";
 * - dirty, non-empty: submit the trimmed string (server `coerce_like`
 *   adopts the extracted value's type before comparing);
 * - dirty, cleared: the user asserts the field is absent/wrong → null;
 *   unless nothing was extracted either, in which case there is nothing
 *   to assert → OMIT.
 */
export function composeSubmission(
  bindings: FieldBinding[],
  edits: ReadonlyMap<string, string>,
): SubmissionResult {
  const data: Record<string, unknown> = {};
  const byLabel: Record<string, unknown> = {};
  let confirmed = 0;
  let corrected = 0;

  for (const binding of bindings) {
    const edit = edits.get(binding.key.raw);
    if (edit !== undefined) {
      const trimmed = edit.trim();
      if (trimmed === '' && binding.extracted === NOT_FOUND) {
        continue;
      }
      const value = trimmed === '' ? null : trimmed;
      data[binding.key.raw] = value;
      byLabel[binding.key.label] = value;
      corrected += 1;
    } else {
      if (binding.extracted === NOT_FOUND) {
        continue;
      }
      data[binding.key.raw] = binding.extracted;
      byLabel[binding.key.label] = binding.extracted;
      confirmed += 1;
    }
  }
  return { data, byLabel, confirmed, corrected };
}
