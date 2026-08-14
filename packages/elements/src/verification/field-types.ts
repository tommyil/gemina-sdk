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
