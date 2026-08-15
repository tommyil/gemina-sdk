import { describe, expect, it } from 'vitest';
import {
  ROW_META_KEY,
  classifyData,
  extractConfidence,
  extractCoordinates,
  extractValue,
  formatLabel,
  formatValue,
  isEntityArray,
  isPrimitiveArray,
  isSimpleValueArray,
  isTableArray,
  isValueObject,
} from '../../src/verification/classify';
import { resolvePointer } from '../../src/verification/pointer';

describe('formatLabel', () => {
  it('converts snake_case with acronym handling', () => {
    expect(formatLabel('vat_amount')).toBe('VAT Amount');
    expect(formatLabel('ocr_text')).toBe('OCR Text');
  });
  it('converts camelCase', () => {
    expect(formatLabel('supplierName')).toBe('Supplier Name');
    expect(formatLabel('businessNumber')).toBe('Business Number');
  });
});

describe('formatValue (display only)', () => {
  it('formats numbers with thousand separators', () => {
    expect(formatValue(1234.5)).toBe('1,234.5');
  });
  it('keeps identifier-named numbers unformatted', () => {
    expect(formatValue(123456, 'invoice_number')).toBe('123456');
  });
  it('formats ISO dates as locale dates', () => {
    expect(formatValue('2026-01-05')).toBe(new Date('2026-01-05').toLocaleDateString());
  });
  it('formats booleans and null', () => {
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(null)).toBe('-');
  });
});

describe('predicates', () => {
  it('isValueObject requires a value property on a non-array object', () => {
    expect(isValueObject({ value: 1 })).toBe(true);
    expect(isValueObject({ val: 1 })).toBe(false);
    expect(isValueObject([{ value: 1 }])).toBe(false);
    expect(isValueObject(null)).toBe(false);
  });
  it('isPrimitiveArray / isSimpleValueArray / isTableArray / isEntityArray bucket correctly', () => {
    expect(isPrimitiveArray(['a', 1, null])).toBe(true);
    expect(isSimpleValueArray([{ value: 'a', confidence: 'high' }])).toBe(true);
    // >3 non-meta fields, all primitive or value objects -> table
    expect(isTableArray([{ a: 1, b: 2, c: 3, d: { value: 4 } }])).toBe(true);
    // few fields -> entity, not table
    const entities = [{ name: { value: 'A' }, role: 'buyer' }];
    expect(isTableArray(entities)).toBe(false);
    expect(isEntityArray(entities)).toBe(true);
  });
});

describe('extractors', () => {
  const field = {
    value: 'Acme',
    coordinates: { relative: [[0, 0], [1, 1]] },
    confidence: 'high',
    confidence_reasons: ['clear print'],
  };
  it('unwraps value objects and passes through primitives', () => {
    expect(extractValue(field)).toBe('Acme');
    expect(extractValue('plain')).toBe('plain');
  });
  it('maps coordinates.relative to { points }', () => {
    expect(extractCoordinates(field)).toEqual({ points: [[0, 0], [1, 1]] });
    expect(extractCoordinates({ value: 1 })).toBeNull();
  });
  it('extracts confidence with reasons defaulting to []', () => {
    expect(extractConfidence(field)).toEqual({ level: 'high', reasons: ['clear print'] });
    expect(extractConfidence({ value: 1, confidence: 'low' })).toEqual({ level: 'low', reasons: [] });
  });
});

describe('classifyData: headers', () => {
  const payload = {
    supplier_name: {
      value: 'Acme Corp',
      coordinates: { relative: [[0.1, 0.2], [0.3, 0.4]] },
      confidence: 'high',
      confidence_reasons: ['clear print'],
    },
    total: 100,
  };
  it('emits value-object wrappers as headers with the WRAPPER pointer', () => {
    const result = classifyData(payload);
    expect(result.headers).toHaveLength(2);
    const supplier = result.headers.find((h) => h.key === 'supplier_name');
    expect(supplier).toBeDefined();
    expect(supplier!.pointer).toBe('/supplier_name');
    expect(supplier!.value).toBe('Acme Corp');
    expect(supplier!.coordinates).toEqual({ points: [[0.1, 0.2], [0.3, 0.4]] });
    expect(supplier!.confidence).toEqual({ level: 'high', reasons: ['clear print'] });
  });
  it('non-wrapped payload pointers have no prefix', () => {
    const result = classifyData(payload);
    const total = result.headers.find((h) => h.key === 'total');
    expect(total!.pointer).toBe('/total');
    expect(total!.value).toBe(100);
  });
});

describe('classifyData: { data: ... } wrapper (the trap)', () => {
  it('inner field pointers keep the /data prefix so server pointers resolve', () => {
    const payload = {
      data: {
        invoice_number: { value: 'INV-42', confidence: 'medium' },
      },
      overall_confidence: 'high',
      total_lines: 3,
    };
    const result = classifyData(payload);
    const inv = result.headers.find((h) => h.key === 'invoice_number');
    expect(inv!.pointer).toBe('/data/invoice_number');
    expect(inv!.value).toBe('INV-42');
    // top-level non-data field is processed with no /data prefix
    const lines = result.headers.find((h) => h.key === 'total_lines');
    expect(lines!.pointer).toBe('/total_lines');
    // overall_confidence is a skipped meta field, never a header
    expect(result.headers.find((h) => h.key === 'overall_confidence')).toBeUndefined();
    expect(result.overallConfidence).toEqual({ level: 'high', reasons: [] });
  });

  it('recognises camel-case overall confidence without rendering it as a field', () => {
    const result = classifyData({
      overallConfidence: 'medium',
      confidenceReasons: ['ambiguous total'],
      invoice_number: 'INV-42',
    });
    expect(result.overallConfidence).toEqual({
      level: 'medium',
      reasons: ['ambiguous total'],
    });
    expect(result.headers.find((h) => h.key === 'overallConfidence')).toBeUndefined();
  });
});

describe('classifyData: tables', () => {
  const row = (desc: string, qty: number, price: number, total: number, conf?: string) => ({
    description: { value: desc },
    quantity: qty,
    unit_price: { value: price },
    total: { value: total, coordinates: { relative: [[0, 0], [1, 1]] } },
    ...(conf ? { confidence: conf, confidence_reasons: ['blurry row'] } : {}),
  });
  const payload = {
    line_items: [row('Widget', 2, 50, 100), row('Gadget', 1, 250.5, 250.5, 'low')],
    line_items_confidence: 'medium',
    line_items_confidence_reasons: ['partial occlusion'],
    overall_confidence: 'high',
  };
  it('classifies arrays of >3-field flat objects as tables with cell pointers', () => {
    const result = classifyData(payload);
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0]!;
    expect(table.key).toBe('line_items');
    expect(table.pointer).toBe('/line_items');
    expect(table.columns).toEqual(['description', 'quantity', 'unit_price', 'total']);
    expect(table.rows[1]!['total']!.pointer).toBe('/line_items/1/total');
    expect(table.rows[1]!['total']!.value).toBe(250.5);
    expect(table.rows[0]!['quantity']!.value).toBe(2);
    expect(table.rows[0]!['quantity']!.pointer).toBe('/line_items/0/quantity');
  });
  it('excludes meta fields from columns and captures row confidence as _rowMeta', () => {
    const result = classifyData(payload);
    const table = result.tables[0]!;
    expect(table.columns).not.toContain('confidence');
    expect(table.columns).not.toContain('confidence_reasons');
    expect(table.rows[0]!['_rowMeta']).toBeUndefined();
    expect(table.rows[1]!['_rowMeta']!.confidence).toEqual({
      level: 'low',
      reasons: ['blurry row'],
    });
  });
  it('resolves {key}_confidence sibling into overallConfidence (preferred over overall_confidence)', () => {
    const result = classifyData(payload);
    expect(result.tables[0]!.overallConfidence).toEqual({
      level: 'medium',
      reasons: ['partial occlusion'],
    });
  });
  it('keeps global overall confidence out of a table with no specific confidence', () => {
    const result = classifyData({
      line_items: [row('Widget', 2, 50, 100)],
      overall_confidence: 'high',
      confidence_reasons: ['good scan'],
    });
    expect(result.overallConfidence).toEqual({
      level: 'high',
      reasons: ['good scan'],
    });
    expect(result.tables[0]!.overallConfidence).toBeNull();
  });
});

describe('classifyData: entities', () => {
  it('classifies arrays of few-field objects as entities with per-field pointers', () => {
    const payload = {
      parties: [
        { name: { value: 'Alice' }, role: 'buyer', confidence: 'high' },
        { name: { value: 'Bob' }, role: 'seller' },
      ],
    };
    const result = classifyData(payload);
    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0]!;
    expect(entity.key).toBe('parties');
    expect(entity.pointer).toBe('/parties');
    expect(entity.items[0]!['name']!.pointer).toBe('/parties/0/name');
    expect(entity.items[0]!['name']!.value).toBe('Alice');
    expect(entity.items[1]!['role']!.pointer).toBe('/parties/1/role');
    // item-level meta fields are skipped
    expect(entity.items[0]!['confidence']).toBeUndefined();
  });
});

describe('classifyData: simple lists', () => {
  it('classifies primitive arrays as simpleLists with indexed pointers', () => {
    const result = classifyData({ tags: ['urgent', 'paid'] });
    expect(result.simpleLists).toHaveLength(1);
    const list = result.simpleLists[0]!;
    expect(list.key).toBe('tags');
    expect(list.pointer).toBe('/tags');
    expect(list.items[0]!.pointer).toBe('/tags/0');
    expect(list.items[0]!.value).toBe('urgent');
    expect(list.items[1]!.pointer).toBe('/tags/1');
  });
  it('classifies simple value arrays as simpleLists with wrapper pointers', () => {
    const result = classifyData({
      phones: [{ value: '03-1234567', confidence: 'high' }],
    });
    const list = result.simpleLists[0]!;
    expect(list.items[0]!.pointer).toBe('/phones/0');
    expect(list.items[0]!.value).toBe('03-1234567');
    expect(list.items[0]!.confidence).toEqual({ level: 'high', reasons: [] });
  });
});

describe('classifyData: nested objects and fallback', () => {
  it('flattens small nested objects into headers with dotted labels and slash pointers', () => {
    const result = classifyData({
      bank: { branch: { value: '12' }, account: '99' },
    });
    const branch = result.headers.find((h) => h.key === 'bank.branch');
    expect(branch!.pointer).toBe('/bank/branch');
    expect(branch!.value).toBe('12');
    const account = result.headers.find((h) => h.key === 'bank.account');
    expect(account!.pointer).toBe('/bank/account');
  });
  it('sends unrecognized nested blobs to fallback', () => {
    const blob = { matrix: [[1, 2], [3, 4]] };
    const result = classifyData(blob);
    expect(result.fallback).toHaveLength(1);
    expect(result.fallback[0]!.key).toBe('matrix');
    expect(result.fallback[0]!.data).toEqual([[1, 2], [3, 4]]);
  });
});

describe('classifyData: totality (garbage in, empty buckets or degraded fields out — never a throw)', () => {
  const empty = {
    overallConfidence: null,
    headers: [],
    simpleLists: [],
    entities: [],
    tables: [],
    fallback: [],
  };
  it('degenerate roots yield empty buckets', () => {
    expect(classifyData(null)).toEqual(empty);
    expect(classifyData(undefined)).toEqual(empty);
    expect(classifyData(42)).toEqual(empty);
    expect(classifyData('x')).toEqual(empty);
    expect(classifyData([1, 2])).toEqual(empty);
  });
  it('{data: null} degrades to a null header instead of throwing', () => {
    const result = classifyData({ data: null, total_lines: 3 });
    const dataHeader = result.headers.find((h) => h.key === 'data');
    expect(dataHeader).toBeDefined();
    expect(dataHeader!.value).toBeNull();
    expect(dataHeader!.pointer).toBe('/data');
    expect(result.headers.find((h) => h.key === 'total_lines')!.value).toBe(3);
  });
  it('a null row inside a table array does not throw; cells emit with undefined values', () => {
    const result = classifyData({
      items: [{ a: 1, b: 2, c: 3, d: 4 }, null],
    });
    expect(result.tables).toHaveLength(1);
    const table = result.tables[0]!;
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]!['a']!.value).toBeUndefined();
    expect(table.rows[1]!['a']!.pointer).toBe('/items/1/a');
    // working row unchanged
    expect(table.rows[0]!['a']!.value).toBe(1);
  });
  it('a null item inside an entity array emits an empty entity (index alignment kept)', () => {
    const result = classifyData({
      parties: [{ name: { value: 'A' }, role: 'x' }, null, { name: { value: 'B' }, role: 'y' }],
    });
    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0]!;
    expect(entity.items).toHaveLength(3);
    expect(entity.items[1]).toEqual({});
    // index 2 pointer still matches the original payload position
    expect(entity.items[2]!['name']!.pointer).toBe('/parties/2/name');
  });
});

describe('ROW_META_KEY', () => {
  it('is the key under which synthetic row meta is stored', () => {
    expect(ROW_META_KEY).toBe('_rowMeta');
    const result = classifyData({
      line_items: [{ a: 1, b: 2, c: 3, d: 4, confidence: 'low', confidence_reasons: ['r'] }],
    });
    expect(result.tables[0]!.rows[0]![ROW_META_KEY]!.confidence).toEqual({
      level: 'low',
      reasons: ['r'],
    });
  });
});

describe('classifyData: pointer escaping round-trips through resolvePointer', () => {
  it('escapes / and ~ in keys so emitted pointers resolve against the original payload', () => {
    const payload = { 'net/gross~ratio': { value: 0.5 } };
    const result = classifyData(payload);
    const header = result.headers[0]!;
    expect(header.pointer).toBe('/net~1gross~0ratio');
    expect(resolvePointer(payload, header.pointer)).toEqual({ value: 0.5 });
  });
  it('escapes / in table column keys so cell pointers resolve to the cell value', () => {
    const payload = {
      items: [{ 'net/gross': { value: 0.5 }, a: 1, b: 2, c: 3 }],
    };
    const result = classifyData(payload);
    const cell = result.tables[0]!.rows[0]!['net/gross']!;
    expect(cell.pointer).toBe('/items/0/net~1gross');
    const resolved = resolvePointer(payload, cell.pointer);
    expect(resolved).toEqual({ value: 0.5 });
    expect(extractValue(resolved)).toBe(cell.value);
  });
});
