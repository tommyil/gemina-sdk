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
  it('unwraps a value-object when the pointer stops at the wrapper', () => {
    // table cells stored as {value: ...} but pointer has no /value suffix
    const wrapped = { line_items: [{ total: { value: 42, confidence: 'high' } }] };
    const [b] = buildBindings(['label:line_0_total|ptr:/line_items/0/total'], wrapped);
    expect(b?.extracted).toBe(42);
  });
  it('falls back to the wrapper when /value does not resolve but the parent does', () => {
    const bare = { supplier_name: 'Acme' }; // no wrapper at all
    const [b] = buildBindings(['label:supplier_name|ptr:/supplier_name/value'], bare);
    expect(b?.extracted).toBe('Acme');
  });
});

describe('indexBindingsByFieldPointer', () => {
  it('maps classifier field pointers (wrapper-level) to bindings for both pointer styles', () => {
    const map = indexBindingsByFieldPointer(buildBindings(schema, values));
    expect(map.get('/supplier_name')?.key.label).toBe('supplier_name');      // /value stripped
    expect(map.get('/line_items/0/total')?.key.label).toBe('line_0_total'); // exact
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
  it('edited fields submit the typed string (server coerces types)', () => {
    const edits = new Map([['label:total_amount|ptr:/total_amount/value', '1600']]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:total_amount|ptr:/total_amount/value']).toBe('1600');
    expect(result.corrected).toBe(1);
    expect(result.confirmed).toBe(4);
  });
  it('a filled-in never-extracted key is submitted; a cleared extracted field submits null', () => {
    const edits = new Map([
      ['label:vat_number|ptr:/vat_number/value', 'IL-5150'],
      ['label:supplier_name|ptr:/supplier_name/value', '   '],
    ]);
    const result = composeSubmission(bindings, edits);
    expect(result.data['label:vat_number|ptr:/vat_number/value']).toBe('IL-5150');
    expect(result.data['label:supplier_name|ptr:/supplier_name/value']).toBeNull();
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
