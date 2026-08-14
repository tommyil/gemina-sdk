import { isValueObject } from './classify';
import { coerceInput } from './field-types';
import type { ValidationFieldDescriptor } from './field-types';
import { NOT_FOUND, parseSchemaKey } from './pointer';
import type { NotFound, SchemaKey } from './pointer';

/** One server-mandated submission slot, bound to whatever was extracted there. */
export interface FieldBinding {
  key: SchemaKey;
  /**
   * The RAW resolved node — never unwrapped — or NOT_FOUND. This is what an
   * untouched binding submits verbatim: the server resolves the same pointer
   * against the same model tree (casing aside), so wrapper objects compare
   * dict-vs-dict and score correct. Note: dict-valued submissions additionally
   * require INNER-key casing identity with the server's scoring dict — which
   * holds for custom_template's uncamelized dicts, the only reachable case.
   */
  serverValue: unknown | NotFound;
  /** DISPLAY value: serverValue unwrapped via isValueObject, else serverValue. */
  extracted: unknown | NotFound;
  /**
   * The actually-RESOLVED pointer (payload casing — camel in prod) minus a
   * trailing `/value` segment; the pointer the classifier reports for this
   * field. For NOT_FOUND bindings: best-effort camelized schema pointer.
   */
  fieldPointer: string;
  /**
   * False when serverValue is a container (object/array, including value-object
   * wrappers): the server's `coerce_like` does nothing for containers, so a
   * string edit could never score correct. True for NOT_FOUND (fill-in), null,
   * and primitives.
   */
  editable: boolean;
  /**
   * The server's type metadata for this field, matched by exact key.
   *
   * `undefined` whenever the backend predates the typed contract OR the host
   * is on an SDK generated before it — the converter drops what it does not
   * know. Every consumer treats that as "the plain text input we always had",
   * which is why nothing here is required.
   */
  field?: ValidationFieldDescriptor;
}

function unescapeSegment(raw: string): string {
  return raw.replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** `vendor_name` → `vendorName`; plain lower single words are identical under both. */
function snakeToCamel(segment: string): string {
  return segment.replace(/_([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** Best-effort camelization of a whole pointer (used when resolution fails). */
function camelizePointer(pointer: string): string {
  if (!pointer.startsWith('/')) {
    return pointer;
  }
  return '/' + pointer
    .slice(1)
    .split('/')
    .map((raw) => escapeSegment(snakeToCamel(unescapeSegment(raw))))
    .join('/');
}

interface Resolution {
  node: unknown | NotFound;
  /** The pointer as actually matched in the payload (camel in prod). */
  resolvedPointer: string;
}

/**
 * Resolve a schema pointer against the view payload, casing-aware (review C1):
 * schema pointers are snake_case while the prod payload is camelCase, so each
 * object-key segment tries exact first, then snake→camel. The server scores
 * against its own snake dict, so the mismatch is client-only; structurally the
 * walk mirrors `resolvePointer` (backend parity — no fallbacks, no unwrapping).
 */
function resolveCasingAware(doc: unknown, pointer: string): Resolution {
  const missing: Resolution = { node: NOT_FOUND, resolvedPointer: camelizePointer(pointer) };
  if (pointer === '') {
    return { node: doc, resolvedPointer: '' };
  }
  if (!pointer.startsWith('/')) {
    return missing;
  }
  let current: unknown = doc;
  const matched: string[] = [];
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = unescapeSegment(rawSegment);
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return missing;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return missing;
      }
      current = current[index];
      matched.push(rawSegment);
    } else if (current !== null && typeof current === 'object') {
      let key: string;
      if (Object.prototype.hasOwnProperty.call(current, segment)) {
        key = segment;
      } else {
        const camel = snakeToCamel(segment);
        if (camel === segment || !Object.prototype.hasOwnProperty.call(current, camel)) {
          return missing;
        }
        key = camel;
      }
      current = (current as Record<string, unknown>)[key];
      matched.push(escapeSegment(key));
    } else {
      return missing;
    }
  }
  return { node: current, resolvedPointer: '/' + matched.join('/') };
}

/** A schema pointer `P/value` and a classifier pointer `P` are the same field. */
function stripValueSuffix(pointer: string): string {
  return pointer.endsWith('/value') ? pointer.slice(0, -'/value'.length) : pointer;
}

/**
 * Parse + resolve every schema key. Malformed entries are skipped (backend
 * parity).
 *
 * `fields` is the server's typed descriptors, indexed here by their opaque
 * key. Matching is by key and ONLY by key: labels repeat across rows of a
 * table (`total` appears once per line item), so a label match would type one
 * row's cell from another row's descriptor.
 */
export function buildBindings(
  validationSchema: string[],
  values: unknown,
  fields?: ValidationFieldDescriptor[],
): FieldBinding[] {
  const descriptors = new Map<string, ValidationFieldDescriptor>();
  for (const descriptor of fields ?? []) {
    if (typeof descriptor?.key === 'string') {
      descriptors.set(descriptor.key, descriptor);
    }
  }
  const bindings: FieldBinding[] = [];
  for (const raw of validationSchema) {
    const key = parseSchemaKey(raw);
    if (key === null) {
      continue;
    }
    const { node: serverValue, resolvedPointer } = resolveCasingAware(values, key.pointer);
    const extracted = serverValue !== NOT_FOUND && isValueObject(serverValue)
      ? serverValue.value
      : serverValue;
    const editable = serverValue === NOT_FOUND
      || serverValue === null
      || typeof serverValue !== 'object';
    bindings.push({
      key,
      serverValue,
      extracted,
      fieldPointer: stripValueSuffix(resolvedPointer),
      editable,
      field: descriptors.get(key.raw),
    });
  }
  return bindings;
}

/**
 * Index bindings by the pointer the CLASSIFIER reports for a field. The
 * classifier walks the same payload the bindings resolved against, so its
 * pointers carry the payload's casing — which is exactly what `fieldPointer`
 * recorded during resolution.
 */
export function indexBindingsByFieldPointer(bindings: FieldBinding[]): Map<string, FieldBinding> {
  const map = new Map<string, FieldBinding>();
  for (const binding of bindings) {
    map.set(binding.fieldPointer, binding);
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
 * UI removes an entry when the input returns to its initial string). The
 * counts trust that contract: a caller that fails to delete-on-revert
 * relabels a confirmation as a correction in `confirmed`/`corrected`; the
 * server-side scoring itself survives, since the unchanged string coerces
 * back to a value equal to the extracted one.
 *
 * Rules (verified against the backend DataValidator):
 * - untouched + resolved (even resolved-null): submit `serverValue` verbatim
 *   — the raw node, wrappers included — the server resolves the same node
 *   and compares equal → scored a confirmation;
 * - untouched + never extracted: OMIT — the user asserted nothing, and
 *   submitting null would force a false "missing";
 * - dirty, non-empty: submit the trimmed string (only scalar-valued bindings
 *   are editable, and for scalar targets the server's `coerce_like` adopts
 *   the extracted value's type before comparing; containers are never
 *   editable — see `FieldBinding.editable`);
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
      if (trimmed === '' && binding.serverValue === NOT_FOUND) {
        continue;
      }
      // Typed by the field's own descriptor, so a number reaches the server as
      // a number. A cleared input stays null — it asserts absence and must
      // never become 0 or an empty string.
      const value = trimmed === '' ? null : coerceInput(trimmed, binding.field);
      data[binding.key.raw] = value;
      byLabel[binding.key.label] = value;
      corrected += 1;
    } else {
      if (binding.serverValue === NOT_FOUND) {
        continue;
      }
      data[binding.key.raw] = binding.serverValue;
      byLabel[binding.key.label] = binding.serverValue;
      confirmed += 1;
    }
  }
  return { data, byLabel, confirmed, corrected };
}

/** The one cross-field rule the server enforces. Deliberately not a rules engine. */
const UNIT_SIZE = 'unit_size';
const UNIT_SIZE_UOM = 'unit_size_uom';
export const UNIT_PAIR_MESSAGE = 'Enter both value and unit';

/** `/line_items/3/unit_size` -> `{ row: '/line_items/3', field: 'unit_size' }`. */
function splitPointer(pointer: string): { row: string; field: string } | null {
  const cut = pointer.lastIndexOf('/');
  if (cut <= 0) {
    return null;
  }
  return { row: pointer.slice(0, cut), field: pointer.slice(cut + 1) };
}

/**
 * Rows where exactly one half of the unit-size pair is filled in.
 *
 * The server treats `unit_size` and `unit_size_uom` as both-or-nothing:
 * `_unit_size_pair_rule` (invoice_line_item.py:50-56) nulls BOTH whenever
 * either is missing, on every parse INCLUDING the scorer's. So a reviewer who
 * fills one and not the other has both silently zeroed before scoring, and
 * `onComplete` would hand the host a value the backend had already discarded.
 * Flagging it is the only way the reviewer ever learns.
 *
 * Returns raw key -> message, for BOTH cells of an orphaned pair: the fix is
 * available at either one, so both are marked.
 *
 * Deliberately hard-coded to this pair rather than generalised. Exactly one
 * such rule exists in the models; a cross-field rules DSL would be speculative
 * flexibility with no second caller.
 */
export function unitSizePairErrors(
  bindings: FieldBinding[],
  edits: ReadonlyMap<string, string>,
): Map<string, string> {
  const rows = new Map<string, { size?: FieldBinding; uom?: FieldBinding }>();
  for (const binding of bindings) {
    const split = splitPointer(binding.key.pointer);
    if (!split || (split.field !== UNIT_SIZE && split.field !== UNIT_SIZE_UOM)) {
      continue;
    }
    const row = rows.get(split.row) ?? {};
    if (split.field === UNIT_SIZE) {
      row.size = binding;
    } else {
      row.uom = binding;
    }
    rows.set(split.row, row);
  }

  const errors = new Map<string, string>();
  for (const { size, uom } of rows.values()) {
    // A row missing one half of the pair entirely from its schema cannot be
    // half-filled, so there is nothing to enforce.
    if (!size || !uom) {
      continue;
    }
    const filled = (binding: FieldBinding) =>
      (edits.get(binding.key.raw) ?? toInputString(binding.extracted)).trim() !== '';
    if (filled(size) !== filled(uom)) {
      errors.set(size.key.raw, UNIT_PAIR_MESSAGE);
      errors.set(uom.key.raw, UNIT_PAIR_MESSAGE);
    }
  }
  return errors;
}

/**
 * How many rows the extraction actually found at a table pointer.
 *
 * Reuses the SAME casing-aware walk the bindings use, because the server's
 * pointers are snake_case while the payload is camelCase — counting with a
 * naive lookup would report 0 for every table in production and quietly
 * disable every row control.
 *
 * 0 for a pointer that resolves to anything but an array, which covers both
 * "no such table" and the zero-row case identically — and both want the same
 * empty plan.
 */
export function countRowsAt(values: unknown, pointer: string): number {
  const { node } = resolveCasingAware(values, pointer);
  return Array.isArray(node) ? node.length : 0;
}
