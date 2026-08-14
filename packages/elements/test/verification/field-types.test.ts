/**
 * The typed-contract boundary.
 *
 * Everything here guards a silent failure. A descriptor that fails to parse
 * does not throw — it renders as the plain text input the component always
 * had, which looks fine and quietly discards the whole typed feature.
 */

import { describe, expect, it } from 'vitest';
import { readDescriptors } from '../../src/verification/field-types';

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
