/**
 * The typed validation contract must survive the generated converters.
 *
 * These converters do not pass JSON through — they RECONSTRUCT each model from
 * an object literal listing only the properties the generator knew about. So a
 * field the server sends but the client was generated without is dropped
 * silently at the SDK boundary, with no error anywhere: `@gemina/elements`
 * consumes the typed DTO, not raw JSON, and would simply fall back to untyped
 * inputs. The whole typed feature would ship dead.
 *
 * That is not hypothetical — the pre-1.5.0 `ValidationSchemaModelFromJSONTyped`
 * returned a literal containing only `validationSchema`. These tests fail if a
 * future regen is ever run against a spec that lost these fields.
 */

import { describe, expect, it } from 'vitest';
import {
  ExtractionValidationInDTOToJSON,
  ValidationSchemaModelFromJSON,
} from '../src/generated';

describe('ValidationSchemaModel converter', () => {
  it('carries validationFields through', () => {
    const parsed = ValidationSchemaModelFromJSON({
      validationSchema: ['label:currency|ptr:/currency'],
      validationFields: [{ key: 'label:currency|ptr:/currency', label: 'currency', type: 'string' }],
    });
    expect(parsed.validationFields?.[0]?.key).toBe('label:currency|ptr:/currency');
  });

  it('carries the enum and format a typed input renders from', () => {
    const parsed = ValidationSchemaModelFromJSON({
      validationSchema: ['label:currency|ptr:/currency'],
      validationFields: [{
        key: 'label:currency|ptr:/currency',
        label: 'currency',
        type: 'string',
        enum: ['ils', 'usd'],
        format: 'iso4217',
        description: 'Currency code',
      }],
    });
    const field = parsed.validationFields?.[0];
    expect(field?._enum).toEqual(['ils', 'usd']);
    expect(field?.format).toBe('iso4217');
  });

  it('carries rowMutableTables and their column metadata through', () => {
    const parsed = ValidationSchemaModelFromJSON({
      validationSchema: [],
      rowMutableTables: [{
        pointer: '/line_items',
        keyTemplate: 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}',
        columns: [{ name: 'unit_of_measure', type: 'string', enum: ['BOX', 'CARTON'] }],
      }],
    });
    const table = parsed.rowMutableTables?.[0];
    expect(table?.pointer).toBe('/line_items');
    expect(table?.keyTemplate).toContain('{index}');
    expect(table?.columns?.[0]?._enum).toContain('CARTON');
  });

  it('still accepts a pre-1.5.0 payload that carries neither array', () => {
    const parsed = ValidationSchemaModelFromJSON({ validationSchema: ['label:x|ptr:/x'] });
    expect(parsed.validationSchema).toEqual(['label:x|ptr:/x']);
    expect(parsed.validationFields).toBeUndefined();
  });
});

describe('ExtractionValidationInDTO converter', () => {
  it('serializes rowSources on the way OUT', () => {
    // The request direction matters just as much: a dropped rowSources is
    // ignored by the server (`extra="ignore"`), and inserted/deleted rows
    // mis-score permanently — validation is one-shot.
    const body = ExtractionValidationInDTOToJSON({
      data: { 'label:x|ptr:/x': 1 },
      rowSources: [{ table: '/line_items', sources: [0, null, 2] }],
    });
    expect(body.rowSources).toEqual([{ table: '/line_items', sources: [0, null, 2] }]);
  });
});
