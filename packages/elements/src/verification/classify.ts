/**
 * Shape classifier for arbitrary extraction payloads.
 *
 * Near-verbatim port of the console's battle-tested classifier
 * (gemina-console `src/pages/extractions/components/FormView/utils.ts`).
 * It buckets a payload into headers / simpleLists / tables / entities /
 * fallback. The heuristics are intentionally unchanged — they are proven
 * against every extraction type.
 *
 * ONE structural addition over the console: every emitted leaf carries the
 * JSON pointer at which it lives in the ORIGINAL payload, so bindings can
 * match fields to server-generated schema keys. Pointers point at the
 * value-object WRAPPER (e.g. `/supplier_name`, not `/supplier_name/value`);
 * `/value` normalization happens at binding time. When the payload wraps its
 * fields in a root `{ data: ... }` object, inner pointers keep the `/data`
 * prefix because server pointers resolve against the payload root.
 *
 * Pointer segments are RFC-6901 escaped (`~` → `~0` first, then `/` → `~1`)
 * so emitted pointers round-trip through `resolvePointer`.
 *
 * Pure and dependency-free: no React, no DOM, no antd.
 */

/**
 * Common acronyms that should stay uppercase
 */
const ACRONYMS = new Set(['ID', 'VAT', 'OCR', 'PDF', 'URL', 'API', 'HTML', 'CSS', 'JSON', 'XML', 'UUID']);

/**
 * Convert camelCase or snake_case to Title Case with acronym handling
 * Examples:
 *   supplierName -> "Supplier Name"
 *   vat_amount -> "VAT Amount"
 *   ocr_text -> "OCR Text"
 *   businessNumber -> "Business Number"
 */
export function formatLabel(key: string): string {
  // First, split by underscores and camelCase
  const words = key
    // Insert space before uppercase letters (camelCase)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Replace underscores with spaces
    .replace(/_/g, ' ')
    // Split into words
    .split(' ')
    .filter(Boolean);

  return words
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) {
        return upper;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Format a value for display based on its type.
 *
 * DISPLAY ONLY — never feed this into inputs or submissions; the raw
 * `value` on each classified leaf is the source of truth.
 */
export function formatValue(value: unknown, fieldName?: string): string {
  if (value === null || value === undefined) {
    return '-';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number') {
    // Check if it looks like a percentage (field name contains rate/percent)
    if (fieldName && /rate|percent/i.test(fieldName)) {
      return `${value}%`;
    }
    // Don't format identifier fields with thousand separators
    if (fieldName && /number|num|id|code|phone|fax|postal|zip/i.test(fieldName)) {
      return String(value);
    }
    // Format numbers with thousand separators
    return value.toLocaleString();
  }

  if (typeof value === 'string') {
    // Try to detect and format ISO dates
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) {
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString();
        }
      } catch {
        // Fall through to return original
      }
    }
    return value;
  }

  return String(value);
}

/**
 * Check if a value is a "value object" with { value, coordinates?, confidence? }
 */
export function isValueObject(obj: unknown): obj is { value: unknown; coordinates?: unknown; confidence?: string; confidence_reasons?: string[] } {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  return 'value' in obj;
}

/**
 * Check if an array contains only primitives
 */
export function isPrimitiveArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  return arr.every((item) => item === null || typeof item !== 'object');
}

/**
 * Check if an array is a "simple value array" (Type C)
 * Array of { value, coordinates? } objects
 */
export function isSimpleValueArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  return arr.every((item) => isValueObject(item) && Object.keys(item as object).every(k => ['value', 'coordinates', 'confidence', 'confidence_reasons'].includes(k)));
}

/**
 * Check if an array is a "table array" (Type A)
 * Array of flat objects with many fields
 */
export function isTableArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return false;

  // Count non-metadata fields
  const metaFields = new Set(['confidence', 'confidence_reasons', 'coordinates']);
  const keys = Object.keys(first as object).filter(k => !metaFields.has(k));

  // If objects have >3 non-meta fields and those values are primitives or value objects, it's a table
  if (keys.length > 3) {
    const firstObj = first as Record<string, unknown>;
    // Only check the non-metadata field values
    const nonMetaValues = keys.map(k => firstObj[k]);
    const allSimple = nonMetaValues.every(v =>
      v === null ||
      typeof v !== 'object' ||
      isValueObject(v)
    );
    return allSimple;
  }
  return false;
}

/**
 * Check if an array is an "entity array" (Type B)
 * Array of objects that aren't tables - includes both wrapped value objects
 * and plain object arrays with few fields
 */
export function isEntityArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  if (isPrimitiveArray(arr)) return false;
  if (isSimpleValueArray(arr)) return false;
  if (isTableArray(arr)) return false;

  const first = arr[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return false;

  // Any array of objects that isn't a table or simple value array is an entity array
  // This includes objects with nested value wrappers OR plain objects with few fields
  return true;
}

/**
 * Extract the actual value from a field (handles value objects)
 */
export function extractValue(field: unknown): unknown {
  if (isValueObject(field)) {
    return field.value;
  }
  return field;
}

/**
 * Extract coordinates from a field if present
 */
export function extractCoordinates(field: unknown): { points: [number, number][] } | null {
  if (isValueObject(field) && field.coordinates) {
    const coords = field.coordinates as { relative?: [number, number][] };
    if (coords.relative) {
      return { points: coords.relative };
    }
  }
  return null;
}

/**
 * Extract confidence from a field if present
 */
export function extractConfidence(field: unknown): { level: string; reasons: string[] } | null {
  if (isValueObject(field) && field.confidence) {
    return {
      level: field.confidence,
      reasons: field.confidence_reasons || [],
    };
  }
  return null;
}

/**
 * Escape one JSON-pointer segment per RFC 6901 (`~` before `/`, mirroring the
 * resolver's unescape order of `~1` before `~0`).
 */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * One classified leaf field. `pointer` locates the field's value-object
 * wrapper (or raw value) in the ORIGINAL payload.
 */
export interface ClassifiedField {
  key: string;                                   // display label source (formatLabel applied at render)
  pointer: string;                               // pointer to this field in the ORIGINAL payload
  value: unknown;                                // unwrapped raw value
  coordinates: { points: [number, number][] } | null;
  confidence: { level: string; reasons: string[] } | null;
}

/**
 * Key under which a table row's synthetic row-level confidence cell is
 * stored. Not a real payload field — it never binds to a server schema key.
 */
export const ROW_META_KEY = '_rowMeta';

/** A cell inside a table row or entity card (no own display key). */
export interface ClassifiedCell {
  pointer: string;
  value: unknown;
  coordinates: { points: [number, number][] } | null;
  confidence: { level: string; reasons: string[] } | null;
}

/**
 * Classify all fields in a data object
 */
export interface ClassifiedData {
  overallConfidence: { level: string; reasons: string[] } | null;
  headers: ClassifiedField[];
  simpleLists: Array<{
    key: string;
    pointer: string;
    items: ClassifiedCell[];
  }>;
  entities: Array<{
    key: string;
    pointer: string;
    items: Array<Record<string, ClassifiedCell>>;
  }>;
  tables: Array<{
    key: string;
    pointer: string;
    columns: string[];
    rows: Array<Record<string, ClassifiedCell>>;
    overallConfidence: { level: string; reasons: string[] } | null;
  }>;
  fallback: Array<{
    key: string;
    data: unknown;
  }>;
}

export function classifyData(data: unknown): ClassifiedData {
  const result: ClassifiedData = {
    overallConfidence: null,
    headers: [],
    simpleLists: [],
    entities: [],
    tables: [],
    fallback: [],
  };

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return result;
  }

  // Handle wrapped data (some extractions wrap in { data: ... })
  let rootData = data as Record<string, unknown>;
  result.overallConfidence = readOverallConfidence(rootData);
  let basePointer = '';
  if ('data' in rootData && typeof rootData.data === 'object' && rootData.data !== null && !Array.isArray(rootData.data)) {
    // Process top-level non-data fields first (like total_lines, overall_confidence)
    for (const [key, value] of Object.entries(rootData)) {
      if (key === 'data') continue;
      processField(key, value, result, rootData, '');
    }
    rootData = rootData.data as Record<string, unknown>;
    result.overallConfidence ??= readOverallConfidence(rootData);
    // Inner fields live under the wrapper in the original payload — server
    // pointers resolve against the payload root, so keep the /data prefix.
    basePointer = '/data';
  }

  for (const [key, value] of Object.entries(rootData)) {
    processField(key, value, result, rootData, basePointer);
  }

  return result;
}

function readOverallConfidence(
  source: Record<string, unknown>,
): { level: string; reasons: string[] } | null {
  const rawLevel = source.overall_confidence ?? source.overallConfidence;
  const value = extractValue(rawLevel);
  if (typeof value !== 'string' || value.length === 0) return null;

  const rawReasons = source.confidence_reasons ?? source.confidenceReasons;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  return { level: value, reasons };
}

function processField(
  key: string,
  value: unknown,
  result: ClassifiedData,
  parentObj: Record<string, unknown> | undefined,
  basePointer: string,
): void {
  // Skip metadata fields at root level
  // Overall confidence has a dedicated summary above the form. Accept both
  // wire spellings because Pydantic aliases vary between processor payloads.
  if ([
    'confidence', 'confidence_reasons', 'confidenceReasons', 'coordinates',
    'overall_confidence', 'overallConfidence',
  ].includes(key)) {
    return;
  }

  const pointer = `${basePointer}/${escapeSegment(key)}`;

  // Primitive or null
  if (value === null || typeof value !== 'object') {
    result.headers.push({
      key,
      pointer,
      value,
      coordinates: null,
      confidence: null,
    });
    return;
  }

  // Value object (has 'value' property)
  if (isValueObject(value)) {
    result.headers.push({
      key,
      pointer,
      value: extractValue(value),
      coordinates: extractCoordinates(value),
      confidence: extractConfidence(value),
    });
    return;
  }

  // Array
  if (Array.isArray(value)) {
    if (value.length === 0) {
      result.headers.push({
        key,
        pointer,
        value: null,
        coordinates: null,
        confidence: null,
      });
      return;
    }

    // Array of primitives - display as simple list
    if (isPrimitiveArray(value)) {
      result.simpleLists.push({
        key,
        pointer,
        items: value.map((item, index) => ({
          pointer: `${pointer}/${index}`,
          value: item,
          coordinates: null,
          confidence: null,
        })),
      });
      return;
    }

    // Simple value array (Type C) - array of { value, coordinates? }
    if (isSimpleValueArray(value)) {
      result.simpleLists.push({
        key,
        pointer,
        items: value.map((item, index) => ({
          pointer: `${pointer}/${index}`,
          value: extractValue(item),
          coordinates: extractCoordinates(item),
          confidence: extractConfidence(item),
        })),
      });
      return;
    }

    // Table array (Type A) - array of flat objects with many fields
    if (isTableArray(value)) {
      const first = value[0] as Record<string, unknown>;
      const metaFields = new Set(['confidence', 'confidence_reasons', 'coordinates']);
      const columns = Object.keys(first).filter(k => !metaFields.has(k));

      // A table-specific confidence belongs in its section header. Global
      // overall confidence is intentionally not copied into every table.
      let overallConfidence: { level: string; reasons: string[] } | null = null;
      if (parentObj) {
        // First check for specific key pattern (e.g., line_items_confidence)
        const confidenceKey = `${key}_confidence`;
        const reasonsKey = `${key}_confidence_reasons`;
        if (parentObj[confidenceKey]) {
          overallConfidence = {
            level: parentObj[confidenceKey] as string,
            reasons: (parentObj[reasonsKey] as string[]) || [],
          };
        }
      }

      result.tables.push({
        key,
        pointer,
        columns,
        overallConfidence,
        rows: value.map((row, rowIndex) => {
          const rowPointer = `${pointer}/${rowIndex}`;
          const rowData: Record<string, ClassifiedCell> = {};
          // isTableArray samples only the first element; a null/non-object row
          // later in the array must not crash — its cells emit with undefined.
          const rowObj = (row ?? {}) as Record<string, unknown>;

          for (const col of columns) {
            const cell = rowObj[col];
            rowData[col] = {
              pointer: `${rowPointer}/${escapeSegment(col)}`,
              value: extractValue(cell),
              coordinates: extractCoordinates(cell),
              confidence: extractConfidence(cell),
            };
          }

          // Also extract row-level confidence if present
          if (rowObj.confidence || rowObj.confidence_reasons) {
            // _rowMeta is synthetic (no real field behind it); its pointer is
            // the ROW pointer, and it never binds to a server schema key.
            rowData[ROW_META_KEY] = {
              pointer: rowPointer,
              value: null,
              coordinates: null,
              confidence: {
                level: rowObj.confidence as string || '',
                reasons: (rowObj.confidence_reasons as string[]) || [],
              },
            };
          }

          return rowData;
        }),
      });
      return;
    }

    // Entity array (Type B) - array of objects (cards)
    if (isEntityArray(value)) {
      result.entities.push({
        key,
        pointer,
        items: value.map((item, index) => {
          const entity: Record<string, ClassifiedCell> = {};

          // isEntityArray samples only the first element; a null/non-object
          // item later in the array emits an empty entity so indices (and
          // therefore sibling pointers) stay aligned with the payload.
          if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            return entity;
          }

          for (const [fieldKey, fieldValue] of Object.entries(item as Record<string, unknown>)) {
            // Skip metadata fields
            if (['confidence', 'confidence_reasons', 'coordinates'].includes(fieldKey)) {
              continue;
            }
            entity[fieldKey] = {
              pointer: `${pointer}/${index}/${escapeSegment(fieldKey)}`,
              value: extractValue(fieldValue),
              coordinates: extractCoordinates(fieldValue),
              confidence: extractConfidence(fieldValue),
            };
          }

          return entity;
        }),
      });
      return;
    }

    // Fallback for unrecognized arrays
    result.fallback.push({ key, data: value });
    return;
  }

  // Nested object without 'value' property - try to recurse into it
  const nestedObj = value as Record<string, unknown>;
  const nestedKeys = Object.keys(nestedObj).filter(k => !['confidence', 'confidence_reasons', 'coordinates'].includes(k));

  // If the nested object has fields, process them recursively with prefixed keys
  if (nestedKeys.length > 0 && nestedKeys.length <= 10) {
    // Small nested objects get flattened into headers with grouped key names
    for (const nestedKey of nestedKeys) {
      const nestedValue = nestedObj[nestedKey];
      const combinedKey = `${key}.${nestedKey}`;
      const nestedPointer = `${pointer}/${escapeSegment(nestedKey)}`;

      // Process primitives and value objects as headers
      if (nestedValue === null || typeof nestedValue !== 'object') {
        result.headers.push({
          key: combinedKey,
          pointer: nestedPointer,
          value: nestedValue,
          coordinates: null,
          confidence: null,
        });
      } else if (isValueObject(nestedValue)) {
        result.headers.push({
          key: combinedKey,
          pointer: nestedPointer,
          value: extractValue(nestedValue),
          coordinates: extractCoordinates(nestedValue),
          confidence: extractConfidence(nestedValue),
        });
      } else {
        // Complex nested values go to fallback
        result.fallback.push({ key: combinedKey, data: nestedValue });
      }
    }
    return;
  }

  // Large or empty nested objects go to fallback
  result.fallback.push({ key, data: value });
}
