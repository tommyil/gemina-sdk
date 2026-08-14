/**
 * The typed-contract boundary.
 *
 * Everything here guards a silent failure. A descriptor that fails to parse
 * does not throw — it renders as the plain text input the component always
 * had, which looks fine and quietly discards the whole typed feature.
 */

import { describe, expect, it } from 'vitest';
import { readDescriptors, validateInput } from '../../src/verification/field-types';

describe('readDescriptors', () => {
  it('reads the SDK spelling `_enum` — the generator renames the reserved word', () => {
    // The trap: reading `.enum` off a generated DTO yields undefined, so every
    // roster field would render as free text with nothing red anywhere.
    const [field] = readDescriptors([
      { key: 'label:uom|ptr:/uom', label: 'uom', type: 'string', _enum: ['UNIT', 'BOX'] },
    ]);
    expect(field?.enum).toEqual(['UNIT', 'BOX']);
  });

  it('also reads the raw-JSON spelling `enum`', () => {
    const [field] = readDescriptors([
      { key: 'label:uom|ptr:/uom', type: 'string', enum: ['UNIT'] },
    ]);
    expect(field?.enum).toEqual(['UNIT']);
  });

  it('carries type, format and description through', () => {
    const [field] = readDescriptors([
      {
        key: 'label:currency|ptr:/currency/value',
        label: 'currency',
        type: 'string',
        format: 'iso4217',
        description: 'ISO 4217 code',
      },
    ]);
    expect(field?.type).toBe('string');
    expect(field?.format).toBe('iso4217');
    expect(field?.description).toBe('ISO 4217 code');
  });

  it('returns empty for a pre-1.5.0 payload that carries no descriptors', () => {
    // The deploy-gate case: older backend, or a host on an older SDK whose
    // converter dropped the array entirely.
    expect(readDescriptors(undefined)).toEqual([]);
    expect(readDescriptors(null)).toEqual([]);
    expect(readDescriptors([])).toEqual([]);
  });

  it('drops entries with no string key — the key is the only identity', () => {
    const fields = readDescriptors([
      { label: 'no key', type: 'string' },
      null,
      'not an object',
      { key: 42 },
      { key: 'label:ok|ptr:/ok', type: 'number' },
    ]);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.key).toBe('label:ok|ptr:/ok');
  });

  it('normalises roster members to strings', () => {
    // The generator publishes enum as List[str], but a hand-rolled payload or
    // a future numeric literal must not reach a <select> as a number.
    const [field] = readDescriptors([{ key: 'k', _enum: [1, 2] }]);
    expect(field?.enum).toEqual(['1', '2']);
  });

  it('is total on a non-array', () => {
    expect(readDescriptors('nonsense')).toEqual([]);
    expect(readDescriptors({ key: 'k' })).toEqual([]);
  });
});

describe('validateInput', () => {
  it('accepts a valid ISO 4217 code', () => {
    expect(validateInput('USD', { type: 'string', format: 'iso4217' })).toBeNull();
  });

  it('accepts a lowercase code — case is a display concern, not a validity one', () => {
    expect(validateInput('ils', { type: 'string', format: 'iso4217' })).toBeNull();
  });

  it('names the fix when a currency is malformed', () => {
    expect(validateInput('dollars', { type: 'string', format: 'iso4217' }))
      .toBe('Use a 3-letter ISO 4217 code, e.g. USD');
  });

  it('rejects a non-number in a number field', () => {
    expect(validateInput('twelve', { type: 'number' })).toBe('Enter a number');
  });

  it('accepts negatives, decimals and thousands separators in a number field', () => {
    // The server strips commas and underscores before comparing
    // (`utils._strip_numeric`), so rejecting them here would block a value the
    // backend would have accepted.
    for (const value of ['-12.5', '1,500', '0']) {
      expect(validateInput(value, { type: 'number' }), value).toBeNull();
    }
  });

  it('rejects a decimal in an integer field', () => {
    expect(validateInput('1.5', { type: 'integer' })).toBe('Enter a whole number');
    expect(validateInput('12', { type: 'integer' })).toBeNull();
  });

  it('rejects an off-roster enum value', () => {
    expect(validateInput('CRATE', { type: 'string', enum: ['UNIT', 'BOX'] }))
      .toBe('Choose one of: UNIT, BOX');
  });

  it('accepts a roster member', () => {
    expect(validateInput('BOX', { type: 'string', enum: ['UNIT', 'BOX'] })).toBeNull();
  });

  it('treats an empty value as valid — clearing asserts the field is absent', () => {
    // composeSubmission already reads a cleared input as "the user asserts this
    // field is absent/wrong". Validation must not break that.
    expect(validateInput('', { type: 'number' })).toBeNull();
    expect(validateInput('   ', { type: 'number' })).toBeNull();
    expect(validateInput('', { type: 'string', enum: ['UNIT'] })).toBeNull();
  });

  it('accepts anything when there is no descriptor — untyped is not invalid', () => {
    expect(validateInput('whatever', undefined)).toBeNull();
    expect(validateInput('whatever', {})).toBeNull();
  });

  it('rejects a malformed date', () => {
    expect(validateInput('not-a-date', { type: 'date' })).toBe('Enter a date as YYYY-MM-DD');
    expect(validateInput('2026-08-14', { type: 'date' })).toBeNull();
  });

  it('rejects a calendar-impossible date that matches the shape', () => {
    expect(validateInput('2026-02-30', { type: 'date' })).toBe('Enter a date as YYYY-MM-DD');
  });
});
