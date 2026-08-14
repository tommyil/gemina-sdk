import { describe, expect, it } from 'vitest';
import {
  buildBindings, composeSubmission, indexBindingsByFieldPointer, toInputString,
} from '../../src/verification/bindings';
import { NOT_FOUND } from '../../src/verification/pointer';

const values = {
  supplier_name: { value: 'Acme Ltd', confidence: 'high' },
  total_amount: { value: 1500, confidence: 'low', confidence_reasons: ['blurry_region'] },
  due_date: { value: null },
  line_items: [{ description: 'Widget', total: 100 }],
};
const schema = [
  'label:supplier_name|ptr:/supplier_name/value',
  'label:total_amount|ptr:/total_amount/value',
  'label:due_date|ptr:/due_date/value',
  'label:vat_number|ptr:/vat_number/value',          // never extracted
  'label:line_0_description|ptr:/line_items/0/description',
  'label:line_0_total|ptr:/line_items/0/total',
  'not-a-valid-key',                                  // must be skipped quietly
];

// Prod shape: snake_case schema pointers, camelCase view payload (review C1).
const camelValues = {
  vendorName: { value: 'Acme Ltd', confidence: 'high' },
  lineItems: [{ itemCode: 'A1' }],
};
const camelSchema = [
  'label:vendor_name|ptr:/vendor_name/value',
  'label:line_0_item_code|ptr:/line_items/0/item_code',
];

describe('buildBindings', () => {
  const bindings = buildBindings(schema, values);
  it('resolves /value pointers to the raw primitive', () => {
    expect(bindings.find((b) => b.key.label === 'supplier_name')?.extracted).toBe('Acme Ltd');
    expect(bindings.find((b) => b.key.label === 'total_amount')?.extracted).toBe(1500);
  });
  it('keeps real nulls distinct from never-extracted', () => {
    expect(bindings.find((b) => b.key.label === 'due_date')?.extracted).toBeNull();
    expect(bindings.find((b) => b.key.label === 'vat_number')?.extracted).toBe(NOT_FOUND);
  });
  it('resolves row-indexed pointers and skips malformed keys', () => {
    expect(bindings.find((b) => b.key.label === 'line_0_total')?.extracted).toBe(100);
    expect(bindings).toHaveLength(6);
  });
  it('unwraps a value-object for display but keeps the raw wrapper as serverValue', () => {
    // table cells stored as {value: ...} but pointer has no /value suffix
    const wrapped = { line_items: [{ total: { value: 42, confidence: 'high' } }] };
    const [b] = buildBindings(['label:line_0_total|ptr:/line_items/0/total'], wrapped);
    expect(b?.extracted).toBe(42);
    expect(b?.serverValue).toBe(wrapped.line_items[0]!.total);
  });
  it('a bare payload without wrappers is NOT_FOUND for /value pointers (server parity)', () => {
    // The server resolves against the same model tree: if /supplier_name/value
    // does not resolve here, it will not resolve there either — no fallback.
    const bare = { supplier_name: 'Acme' };
    const [b] = buildBindings(['label:supplier_name|ptr:/supplier_name/value'], bare);
    expect(b?.serverValue).toBe(NOT_FOUND);
    expect(b?.extracted).toBe(NOT_FOUND);
    const result = composeSubmission([b!], new Map());
    expect('label:supplier_name|ptr:/supplier_name/value' in result.data).toBe(false);
  });
  it('resolves snake_case schema pointers against a camelCase payload (prod shape)', () => {
    const camelBindings = buildBindings(camelSchema, camelValues);
    expect(camelBindings.find((b) => b.key.label === 'vendor_name')?.extracted).toBe('Acme Ltd');
    expect(camelBindings.find((b) => b.key.label === 'line_0_item_code')?.extracted).toBe('A1');
  });
  it('records the actually-resolved fieldPointer (camel in prod) minus a trailing /value', () => {
    const camelBindings = buildBindings(camelSchema, camelValues);
    expect(camelBindings.find((b) => b.key.label === 'vendor_name')?.fieldPointer).toBe('/vendorName');
    expect(camelBindings.find((b) => b.key.label === 'line_0_item_code')?.fieldPointer)
      .toBe('/lineItems/0/itemCode');
  });
  it('gives NOT_FOUND bindings a best-effort camelized fieldPointer', () => {
    expect(bindings.find((b) => b.key.label === 'vat_number')?.fieldPointer).toBe('/vatNumber');
  });
  it('marks NOT_FOUND, null, and primitive bindings editable', () => {
    expect(bindings.find((b) => b.key.label === 'supplier_name')?.editable).toBe(true); // primitive
    expect(bindings.find((b) => b.key.label === 'due_date')?.editable).toBe(true);      // null
    expect(bindings.find((b) => b.key.label === 'vat_number')?.editable).toBe(true);    // fill-in
  });
  it('marks container-valued bindings read-only (string edits can never score correct)', () => {
    const wrapped = { line_items: [{ total: { value: 42, confidence: 'high' } }] };
    const [w] = buildBindings(['label:line_0_total|ptr:/line_items/0/total'], wrapped);
    expect(w?.editable).toBe(false); // value-object wrapper
    const [a] = buildBindings(['label:tags|ptr:/tags'], { tags: ['a', 'b'] });
    expect(a?.editable).toBe(false); // array
  });
});

describe('indexBindingsByFieldPointer', () => {
  it('maps classifier field pointers (wrapper-level) to bindings for both pointer styles', () => {
    const map = indexBindingsByFieldPointer(buildBindings(schema, values));
    expect(map.get('/supplier_name')?.key.label).toBe('supplier_name');      // /value stripped
    expect(map.get('/line_items/0/total')?.key.label).toBe('line_0_total'); // exact
  });
  it('keys on the RESOLVED pointer, so camel classifier pointers match in prod', () => {
    const map = indexBindingsByFieldPointer(buildBindings(camelSchema, camelValues));
    expect(map.get('/vendorName')?.key.label).toBe('vendor_name');
    expect(map.get('/lineItems/0/itemCode')?.key.label).toBe('line_0_item_code');
  });
});

describe('toInputString', () => {
  it('prefills inputs from RAW values, never display formatting', () => {
    expect(toInputString(1500)).toBe('1500');           // not "1,500"
    expect(toInputString('2026-01-05')).toBe('2026-01-05'); // not a locale date
    expect(toInputString(null)).toBe('');
    expect(toInputString(NOT_FOUND)).toBe('');
    expect(toInputString(true)).toBe('true');
  });
});

describe('composeSubmission', () => {
  const bindings = buildBindings(schema, values);
  it('untouched extracted fields submit the raw value with its original type', () => {
    const result = composeSubmission(bindings, new Map());
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe(1500); // number, not "1500"
    expect(result.data['label:due_date|ptr:/due_date/value']).toBeNull();          // real null kept
    expect(result.confirmed).toBe(5);
    expect(result.corrected).toBe(0);
  });
  it('untouched never-extracted keys are omitted (no bogus "missing")', () => {
    const result = composeSubmission(bindings, new Map());
    expect('label:vat_number|ptr:/vat_number/value' in result.data).toBe(false);
  });
  it('an untouched wrapper-pointer binding submits the raw wrapper node verbatim', () => {
    const wrapped = { line_items: [{ total: { value: 42, confidence: 'high' } }] };
    const wrappedBindings = buildBindings(['label:line_0_total|ptr:/line_items/0/total'], wrapped);
    const result = composeSubmission(wrappedBindings, new Map());
    // dict-vs-dict compares equal server-side; unwrapping here would score "incorrect"
    expect(result.data['label:line_0_total|ptr:/line_items/0/total']).toBe(wrapped.line_items[0]!.total);
  });
  it('edited fields submit the typed string (server coerces types)', () => {
    const edits = new Map([['label:total_amount|ptr:/total_amount/value', '1600']]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe('1600');
    expect(result.corrected).toBe(1);
    expect(result.confirmed).toBe(4);
  });
  it('edited values are trimmed before submission', () => {
    const edits = new Map([['label:total_amount|ptr:/total_amount/value', ' 1600 ']]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe('1600');
  });
  it('a dirty-but-blank never-extracted key is omitted and not counted as corrected', () => {
    const edits = new Map([['label:vat_number|ptr:/vat_number/value', '  ']]);
    const result = composeSubmission(bindings, edits);
    expect('label:vat_number|ptr:/vat_number/value' in result.data).toBe(false);
    expect(result.corrected).toBe(0);
    expect(result.confirmed).toBe(5);
  });
  it('a filled-in never-extracted key is submitted; a cleared extracted field submits null', () => {
    const edits = new Map([
      ['label:vat_number|ptr:/vat_number/value', 'IL-5150'],
      ['label:supplier_name|ptr:/supplier_name/value', '   '],
    ]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:vat_number|ptr:/vat_number/value']).toBe('IL-5150');
    expect(result.data['label:supplier_name|ptr:/supplier_name/value']).toBeNull();
    expect(result.corrected).toBe(2);
    expect(result.confirmed).toBe(4);
  });
  it('exposes the same entries keyed by label for onComplete', () => {
    const result = composeSubmission(bindings, new Map());
    expect(result.byLabel['supplier_name']).toBe('Acme Ltd');
    expect('vat_number' in result.byLabel).toBe(false);
  });
  it('never leaks the NOT_FOUND symbol into a submission (JSON.stringify would drop it silently)', () => {
    const result = composeSubmission(bindings, new Map());
    expect(Object.values(result.data).every((v) => typeof v !== 'symbol')).toBe(true);
    expect(Object.values(result.byLabel).every((v) => typeof v !== 'symbol')).toBe(true);
  });
});

/**
 * The typed descriptors the backend publishes alongside the opaque key list
 * (`meta.validationFeedback.validationFields`). They are what turns a row of
 * text inputs into a typed form, so they must reach the binding that renders
 * the field — and their ABSENCE must be a no-op, because the component ships
 * ahead of the backend that emits them and against hosts pinned to older SDKs.
 */
describe('buildBindings — typed descriptors', () => {
  it('attaches the typed descriptor to its binding by key', () => {
    const bindings = buildBindings(
      ['label:currency|ptr:/currency'],
      { currency: 'USD' },
      [{
        key: 'label:currency|ptr:/currency',
        label: 'currency',
        type: 'string',
        format: 'iso4217',
        description: 'ISO 4217 code',
      }],
    );
    expect(bindings[0]?.field?.format).toBe('iso4217');
    expect(bindings[0]?.field?.description).toBe('ISO 4217 code');
  });

  it('leaves field undefined when the backend has not shipped validationFields', () => {
    // The deploy-gate guard: a pre-1.5.0 backend sends no descriptors, and the
    // component must degrade to untyped inputs rather than break.
    const bindings = buildBindings(['label:currency|ptr:/currency'], { currency: 'USD' });
    expect(bindings[0]?.field).toBeUndefined();
  });

  it('matches descriptors by exact key, never by label', () => {
    // Two tables can carry the same label; the opaque key is the only identity.
    const bindings = buildBindings(
      ['label:total|ptr:/line_items/0/total', 'label:total|ptr:/line_items/1/total'],
      { line_items: [{ total: 1 }, { total: 2 }] },
      [{ key: 'label:total|ptr:/line_items/1/total', label: 'total', type: 'number' }],
    );
    expect(bindings[0]?.field).toBeUndefined();
    expect(bindings[1]?.field?.type).toBe('number');
  });

  it('ignores a descriptor whose key matches no schema entry', () => {
    const bindings = buildBindings(
      ['label:currency|ptr:/currency'],
      { currency: 'USD' },
      [{ key: 'label:ghost|ptr:/ghost', label: 'ghost', type: 'string' }],
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.field).toBeUndefined();
  });
});

/**
 * Typed RENDERING without typed PARSING leaves the approval payload as
 * unusable as before: edits are strings all the way through.
 *
 * It matters on the wire because the server's `coerce_like` adopts the
 * EXTRACTED value's type before comparing — and skips coercion entirely when
 * the target is NOT_FOUND, which is exactly the never-extracted and added-row
 * cases. And it matters in `onComplete`, which hands the host the client-side
 * `byLabel` values, never the backend-normalised ones: a host receiving
 * approved data would get "12" where it expects 12.
 */
describe('composeSubmission — typed values', () => {
  const NUM_KEY = 'label:quantity|ptr:/line_items/0/quantity';
  const typed = (type: string, value: unknown) => buildBindings(
    [NUM_KEY],
    { line_items: [{ quantity: value }] },
    [{ key: NUM_KEY, label: 'quantity', type }],
  );

  it('submits a number field as a number, not a string', () => {
    const { data, byLabel } = composeSubmission(typed('number', 1), new Map([[NUM_KEY, '12']]));
    expect(data[NUM_KEY]).toBe(12);
    expect(byLabel['quantity']).toBe(12);
  });

  it('submits an integer field as a number', () => {
    const { data } = composeSubmission(typed('integer', 1), new Map([[NUM_KEY, '12']]));
    expect(data[NUM_KEY]).toBe(12);
  });

  it('strips the separators the server would have stripped anyway', () => {
    const { data } = composeSubmission(typed('number', 1), new Map([[NUM_KEY, '1,500']]));
    expect(data[NUM_KEY]).toBe(1500);
  });

  it('submits a boolean field as a boolean', () => {
    const { data } = composeSubmission(typed('boolean', false), new Map([[NUM_KEY, 'true']]));
    expect(data[NUM_KEY]).toBe(true);
    const off = composeSubmission(typed('boolean', true), new Map([[NUM_KEY, 'false']]));
    expect(off.data[NUM_KEY]).toBe(false);
  });

  it('leaves untyped fields as strings — no descriptor, no coercion', () => {
    const bindings = buildBindings([NUM_KEY], { line_items: [{ quantity: 1 }] });
    const { data } = composeSubmission(bindings, new Map([[NUM_KEY, '12']]));
    expect(data[NUM_KEY]).toBe('12');
  });

  it('leaves string and date fields as strings', () => {
    const { data } = composeSubmission(typed('date', '2026-01-01'), new Map([[NUM_KEY, '2026-08-14']]));
    expect(data[NUM_KEY]).toBe('2026-08-14');
    const asString = composeSubmission(typed('string', 'a'), new Map([[NUM_KEY, '12']]));
    expect(asString.data[NUM_KEY]).toBe('12');
  });

  it('still submits null for a cleared typed field', () => {
    // Clearing asserts absence; it must not become 0 or NaN.
    const { data } = composeSubmission(typed('number', 1), new Map([[NUM_KEY, '  ']]));
    expect(data[NUM_KEY]).toBeNull();
  });

  it('never emits NaN — an unparseable value cannot reach the wire', () => {
    // Task 6.4's gate blocks submission first, but if it were ever bypassed
    // the raw string is safer than NaN, which JSON.stringify turns into null
    // and would silently score as "absent".
    const { data } = composeSubmission(typed('number', 1), new Map([[NUM_KEY, 'twelve']]));
    expect(data[NUM_KEY]).toBe('twelve');
    expect(Number.isNaN(data[NUM_KEY] as number)).toBe(false);
  });
});
