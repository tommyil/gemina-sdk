import { describe, expect, it } from 'vitest';
import { NOT_FOUND, parseSchemaKey, resolvePointer } from '../../src/verification/pointer';

describe('parseSchemaKey', () => {
  it('parses label and pointer', () => {
    expect(parseSchemaKey('label:supplier_name|ptr:/supplier_name/value')).toEqual({
      raw: 'label:supplier_name|ptr:/supplier_name/value',
      label: 'supplier_name',
      pointer: '/supplier_name/value',
    });
  });
  it('parses row-indexed table keys', () => {
    expect(parseSchemaKey('label:line_2_total|ptr:/line_items/2/total')?.pointer).toBe(
      '/line_items/2/total',
    );
  });
  it('rejects malformed keys (returns null, mirroring the backend skip)', () => {
    expect(parseSchemaKey('supplier_name')).toBeNull();
    expect(parseSchemaKey('label:a|b|ptr:/x')).toBeNull(); // '|' not allowed in label
    expect(parseSchemaKey('label:a|ptr:x')).toBeNull();    // pointer must start with '/'
  });
});

describe('resolvePointer', () => {
  const doc = {
    supplier_name: { value: 'Acme', confidence: 'high' },
    line_items: [{ total: 100 }, { total: 250.5 }],
    'weird/key': { '~tilde': 7 },
    nothing: null,
  };
  it('resolves object paths and array indices', () => {
    expect(resolvePointer(doc, '/supplier_name/value')).toBe('Acme');
    expect(resolvePointer(doc, '/line_items/1/total')).toBe(250.5);
  });
  it('unescapes ~1 then ~0 per RFC 6901', () => {
    expect(resolvePointer(doc, '/weird~1key/~0tilde')).toBe(7);
  });
  it('distinguishes a real null from NOT_FOUND', () => {
    expect(resolvePointer(doc, '/nothing')).toBeNull();
    expect(resolvePointer(doc, '/missing')).toBe(NOT_FOUND);
    expect(resolvePointer(doc, '/line_items/9/total')).toBe(NOT_FOUND);
    expect(resolvePointer(doc, '/line_items/x')).toBe(NOT_FOUND);   // non-digit list segment
    expect(resolvePointer(doc, '/supplier_name/value/deeper')).toBe(NOT_FOUND); // through a primitive
  });
  it('empty pointer returns the doc; non-slash pointer is NOT_FOUND (backend strictness)', () => {
    expect(resolvePointer(doc, '')).toBe(doc);
    expect(resolvePointer(doc, 'supplier_name')).toBe(NOT_FOUND);
  });
});
