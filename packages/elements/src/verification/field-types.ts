/**
 * The typed side of the validation contract.
 *
 * The backend publishes a descriptor per submittable field alongside the
 * opaque key list (`meta.validationFeedback.validationFields`, and per-column
 * in `rowMutableTables[].columns`). They are derived from the pydantic models,
 * so they are the same source of truth the scorer uses — which is why the
 * client can validate against them and be sure the server will agree.
 *
 * The descriptor is declared STRUCTURALLY here rather than imported from
 * `@gemina/sdk`, so this module compiles against any SDK version. That is a
 * convenience for development only: it does NOT rescue the data. Elements
 * consumes the generated DTO, and a generated converter drops properties it
 * was not generated with, so a host on a pre-1.5.0 SDK receives `undefined`
 * here no matter what the server sent. Every consumer must therefore treat an
 * absent descriptor as "render the plain text input we always rendered".
 */

/** The JSON types the generator emits (`schema_generator.JsonType`). */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date';

export interface ValidationFieldDescriptor {
  /** The opaque schema key this describes. The ONLY identity — labels repeat. */
  key?: string;
  label?: string;
  type?: FieldType;
  /**
   * A closed roster. Note the wire name: the generator renames the reserved
   * word, so the SDK property is `_enum`; callers normalise before handing a
   * descriptor here.
   */
  enum?: string[] | null;
  /** A closed external standard the annotation cannot express, e.g. `iso4217`. */
  format?: string | null;
  /** The model's own field description — shown to the reviewer verbatim. */
  description?: string | null;
}

/**
 * Active ISO 4217 codes, for the currency field's `<datalist>`.
 *
 * SUGGESTIONS ONLY — `validateInput` deliberately does not require membership.
 * A reviewer looking at a real invoice is the authority on what currency it is
 * in, and blocking submission because a legitimate code is missing from a list
 * baked into a client release is a worse failure than accepting an odd one.
 * The server does not check membership either; it compares values.
 */
export const ISO_4217_CODES: readonly string[] = [
  'AED', 'ARS', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK',
  'DKK', 'EGP', 'EUR', 'GBP', 'HKD', 'HRK', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JPY', 'KRW', 'MAD', 'MXN', 'MYR', 'NGN', 'NOK', 'NZD', 'PEN', 'PHP', 'PLN',
  'RON', 'RSD', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD',
  'VND', 'ZAR',
];

const ISO_4217_SHAPE = /^[A-Za-z]{3}$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** Digits with optional sign/decimal, allowing the separators the server strips. */
const NUMERIC_SHAPE = /^[+-]?[\d,_]*\.?\d+$/;

/** The server's own leniency (`utils._strip_numeric`) — match it, don't exceed it. */
function toNumber(value: string): number | null {
  if (!NUMERIC_SHAPE.test(value)) {
    return null;
  }
  const parsed = Number(value.replace(/[,_]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Why a value cannot be submitted, or `null` if it can.
 *
 * The message is the FIX, not the complaint: "Enter a whole number", not
 * "Invalid integer". A reviewer correcting an invoice should never have to
 * infer what the form wants from a restatement of what it rejected.
 *
 * Two rules are load-bearing rather than cosmetic:
 *
 * - An EMPTY value is always valid. `composeSubmission` reads a cleared input
 *   as "the user asserts this field is absent", which is a legitimate and
 *   common correction. Validating emptiness would make the field unclearable.
 * - NO DESCRIPTOR means valid. Untyped is not the same as invalid, and the
 *   component must stay usable against a backend or an SDK that predates the
 *   typed contract.
 */
export function validateInput(
  value: string,
  field: ValidationFieldDescriptor | undefined,
): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || !field) {
    return null;
  }

  // A published roster wins over the annotation's type: the server emits enum
  // and type together, and the roster is the narrower statement.
  if (field.enum && field.enum.length > 0) {
    return field.enum.includes(trimmed)
      ? null
      : `Choose one of: ${field.enum.join(', ')}`;
  }

  if (field.format === 'iso4217') {
    return ISO_4217_SHAPE.test(trimmed) ? null : 'Use a 3-letter ISO 4217 code, e.g. USD';
  }

  switch (field.type) {
    case 'number':
      return toNumber(trimmed) === null ? 'Enter a number' : null;
    case 'integer': {
      const parsed = toNumber(trimmed);
      if (parsed === null || !Number.isInteger(parsed)) {
        return 'Enter a whole number';
      }
      return null;
    }
    case 'date': {
      if (!DATE_SHAPE.test(trimmed)) {
        return 'Enter a date as YYYY-MM-DD';
      }
      // Shape alone accepts 2026-02-30. Round-trip through Date and require
      // the parts to survive, which rejects overflowed days and months.
      const [year, month, day] = trimmed.split('-').map(Number);
      const date = new Date(Date.UTC(year!, month! - 1, day!));
      const survives = date.getUTCFullYear() === year
        && date.getUTCMonth() === month! - 1
        && date.getUTCDate() === day;
      return survives ? null : 'Enter a date as YYYY-MM-DD';
    }
    default:
      return null;
  }
}

/**
 * A table the server declares row-mutable — the reviewer may add and delete
 * its rows, and the client may send a `rowSources` alignment for it.
 *
 * SERVER-DECLARED, never inferred. Any wide array of objects looks like a
 * table to the classifier — `custom_template`'s do — and offering row controls
 * on one the scorer cannot align would mis-score permanently, on a submission
 * that only happens once.
 */
export interface RowMutableTable {
  /** JSON pointer to the array, e.g. `/line_items`. */
  pointer: string;
  /** `label:line_{index}_{field}|ptr:/line_items/{index}/{field}`. */
  keyTemplate: string;
  /**
   * Every column of a row, derived by the backend from the MODEL rather than
   * from a sampled row — so they exist even when the extraction found nothing,
   * which is exactly when a reviewer most needs to type a line in.
   */
  columns: ValidationFieldDescriptor[];
}

/** Normalise the SDK's `rowMutableTables`, including each column's `_enum`. */
export function readRowMutableTables(raw: unknown): RowMutableTable[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RowMutableTable[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const source = item as Record<string, unknown>;
    if (typeof source.pointer !== 'string' || typeof source.keyTemplate !== 'string') {
      continue;
    }
    out.push({
      pointer: source.pointer,
      keyTemplate: source.keyTemplate,
      // Columns are descriptors keyed by `name` rather than `key`, so they get
      // the same treatment with the name standing in as the identity.
      columns: readDescriptors(
        (Array.isArray(source.columns) ? source.columns : []).map((column) => {
          const record = (column ?? {}) as Record<string, unknown>;
          return { ...record, key: record.name };
        }),
      ),
    });
  }
  return out;
}

/** The cell key a table's rows mint, with `{index}`/`{field}` filled in. */
export function cellSchemaKey(template: string, index: number, field: string): string {
  return template.replace(/\{index\}/g, String(index)).replace(/\{field\}/g, field);
}

/**
 * Turn a reviewer's typed string into the value that goes on the wire.
 *
 * Typed rendering without typed parsing leaves the approval payload as
 * unusable as it was before, for two independent reasons:
 *
 * - ON THE WIRE, the server's `coerce_like` adopts the EXTRACTED value's type
 *   before comparing — but skips coercion entirely when the target resolves
 *   NOT_FOUND, which is exactly the never-extracted and added-row cases. There
 *   a string `"12"` is compared against a number and scores incorrect.
 * - IN `onComplete`, the host receives the client-side values, never the
 *   backend-normalised ones. A host consuming approved data would get `"12"`
 *   where it expects `12`.
 *
 * Anything that does not parse is returned UNCHANGED rather than as `NaN`.
 * Task 6.4's gate means an unparseable value cannot reach here, but `NaN`
 * would `JSON.stringify` to `null` and score as a deliberate assertion of
 * absence — the one wrong answer worse than the raw string.
 */
export function coerceInput(
  value: string,
  field: ValidationFieldDescriptor | undefined,
): unknown {
  if (!field) {
    return value;
  }
  switch (field.type) {
    case 'number':
    case 'integer': {
      const parsed = toNumber(value);
      return parsed === null ? value : parsed;
    }
    case 'boolean': {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false') return false;
      return value;
    }
    // `date` stays a string: the wire format IS the ISO string, and a Date
    // object would serialise with a time component the extraction never had.
    default:
      return value;
  }
}

/**
 * Normalise the SDK's descriptors into the shape the rest of this module uses.
 *
 * Exists for one word: `enum` is reserved, so the generator emits the property
 * as `_enum` in TypeScript (and would in a future regen too — it is the
 * generator's rule, not a one-off). Reading `field.enum` off a generated DTO
 * therefore yields `undefined` silently, and every enum would quietly render
 * as a free-text input. Accepting BOTH spellings also keeps the function
 * correct for a caller handing over raw JSON rather than a parsed DTO.
 *
 * Anything unusable — not an object, no string key — is dropped rather than
 * carried as a half-descriptor that later code has to re-check.
 */
export function readDescriptors(raw: unknown): ValidationFieldDescriptor[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ValidationFieldDescriptor[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const source = item as Record<string, unknown>;
    if (typeof source.key !== 'string') {
      continue;
    }
    const roster = source._enum ?? source.enum;
    out.push({
      key: source.key,
      label: typeof source.label === 'string' ? source.label : undefined,
      type: typeof source.type === 'string' ? (source.type as FieldType) : undefined,
      enum: Array.isArray(roster) ? roster.map(String) : null,
      format: typeof source.format === 'string' ? source.format : null,
      description: typeof source.description === 'string' ? source.description : null,
    });
  }
  return out;
}
