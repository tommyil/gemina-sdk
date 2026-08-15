/**
 * Submitting a table whose rows the reviewer changed.
 *
 * The semantics are the backend's, not this file's: its alignment pass makes an
 * inserted row score `missing` and a deleted one score `extra` WITHOUT
 * cascading a correction onto every row below. The client's only job is to
 * report `sources` truthfully and key each cell by its SUBMITTED position.
 */

import { describe, expect, it } from 'vitest';
import { buildBindings, composeSubmission } from '../../src/verification/bindings';
import { collectCellViews, displayColumns, planTableCells } from '../../src/verification/row-cells';
import {
  initialRowPlan, insertRowAfter, isIdentityPlan, removeRow, rowSourcesOf,
} from '../../src/verification/row-plan';
import { cellEditKey } from '../../src/verification/row-plan';

const TEMPLATE = 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}';
const TABLE = {
  pointer: '/line_items',
  keyTemplate: TEMPLATE,
  columns: [{ key: 'description', type: 'string' as const }],
};
const COLUMNS = ['description'];

describe('displayColumns', () => {
  it('does not duplicate response camelCase aliases of declared snake_case columns', () => {
    const table = {
      ...TABLE,
      columns: [
        { key: 'unit_size_uom', type: 'string' as const },
        { key: 'unit_size', type: 'number' as const },
      ],
    };
    expect(displayColumns(table, ['unitSizeUom', 'unitSize'])).toEqual([
      'unit_size_uom',
      'unit_size',
    ]);
  });

  it('preserves two explicitly declared spellings for a dynamic template', () => {
    const table = {
      ...TABLE,
      columns: [
        { key: 'unit_size', type: 'number' as const },
        { key: 'unitSize', type: 'number' as const },
      ],
    };
    expect(displayColumns(table, ['unit_size', 'unitSize'])).toEqual(['unit_size', 'unitSize']);
  });
});

function setup(descriptions: string[]) {
  const schema = descriptions.map((_v, i) => `label:line_${i}_description|ptr:/line_items/${i}/description`);
  const values = { line_items: descriptions.map((description) => ({ description })) };
  const bindings = buildBindings(schema, values);
  const byRaw = new Map(bindings.map((b) => [b.key.raw, b]));
  return { bindings, byRaw, count: descriptions.length };
}

function submit(descriptions: string[], mutate: (plan: ReturnType<typeof initialRowPlan>) => ReturnType<typeof initialRowPlan>, edits = new Map<string, string>()) {
  const { bindings, byRaw, count } = setup(descriptions);
  const plan = mutate(initialRowPlan(count));
  const planned = new Map([[TABLE.pointer, planTableCells(TABLE, plan, COLUMNS, byRaw)]]);
  const cells = collectCellViews(bindings, planned);
  const rowSources = isIdentityPlan(plan, count)
    ? []
    : [{ table: TABLE.pointer, sources: rowSourcesOf(plan) }];
  return { ...composeSubmission(bindings, edits, { cells, rowSources }), plan };
}

const at = (i: number) => `label:line_${i}_description|ptr:/line_items/${i}/description`;

describe('composeSubmission with a row plan', () => {
  it('emits no rowSources when the row set is untouched', () => {
    const { rowSources, data } = submit(['A', 'B'], (p) => p);
    expect(rowSources).toEqual([]);
    expect(data[at(0)]).toBe('A');
    expect(data[at(1)]).toBe('B');
  });

  it('re-indexes so the payload mirrors the approved table — no trailing nulls', () => {
    // [A, A-dup, B]; the reviewer removes position 1.
    const { data } = submit(['A', 'A-dup', 'B'], (p) => removeRow(p, 1));
    expect(data[at(0)]).toBe('A');
    expect(data[at(1)]).toBe('B');
    expect(at(2) in data).toBe(false);
  });

  it('emits sources without the removed original', () => {
    const { rowSources } = submit(['A', 'A-dup', 'B'], (p) => removeRow(p, 1));
    expect(rowSources).toEqual([{ table: '/line_items', sources: [0, 2] }]);
  });

  it('emits the row plan as sources — a user-added row is null', () => {
    const { rowSources } = submit(['A', 'B'], (p) => insertRowAfter(p, 0));
    expect(rowSources).toEqual([{ table: '/line_items', sources: [0, null, 1] }]);
  });

  it('emits a compound edit losslessly', () => {
    // [A, B, C]; delete B, then add two rows between A and C.
    const { rowSources } = submit(['A', 'B', 'C'], (p) => {
      let next = removeRow(p, 1);
      next = insertRowAfter(next, 0);
      return insertRowAfter(next, 1);
    });
    expect(rowSources).toEqual([{ table: '/line_items', sources: [0, null, null, 2] }]);
  });

  it('omits an added row whose cells are all empty', () => {
    // Its aligned counterpart does not exist, so an omission cannot become an
    // `extra` — but a value invented out of nothing would be a lie.
    const { data } = submit(['A'], (p) => insertRowAfter(p, 0));
    expect(data[at(0)]).toBe('A');
    expect(at(1) in data).toBe(false);
  });

  it('submits a filled added row under its SUBMITTED position', () => {
    const { bindings, byRaw, count } = setup(['A']);
    const plan = insertRowAfter(initialRowPlan(count), 0);
    const planned = new Map([[TABLE.pointer, planTableCells(TABLE, plan, COLUMNS, byRaw)]]);
    const edits = new Map([[cellEditKey(plan[1]!.id, 'description'), 'Widget C']]);
    const { data } = composeSubmission(bindings, edits, {
      cells: collectCellViews(bindings, planned),
      rowSources: [{ table: TABLE.pointer, sources: rowSourcesOf(plan) }],
    });
    expect(data[at(1)]).toBe('Widget C');
  });

  it('an edit follows its row when a row above it is deleted', () => {
    // The whole point of keying by row id: this correction was typed into the
    // LAST row, and must still be on the last row after the first is removed.
    const { bindings, byRaw, count } = setup(['A', 'B', 'C']);
    const initial = initialRowPlan(count);
    const edits = new Map([[cellEditKey(initial[2]!.id, 'description'), 'C-fixed']]);
    const plan = removeRow(initial, 0);
    const planned = new Map([[TABLE.pointer, planTableCells(TABLE, plan, COLUMNS, byRaw)]]);
    const { data } = composeSubmission(bindings, edits, {
      cells: collectCellViews(bindings, planned),
      rowSources: [{ table: TABLE.pointer, sources: rowSourcesOf(plan) }],
    });
    expect(data[at(0)]).toBe('B');
    expect(data[at(1)]).toBe('C-fixed'); // moved from position 2 to 1
  });

  it('leaves header submission untouched by the row plan', () => {
    const bindings = buildBindings(['label:total|ptr:/total'], { total: 117 });
    const { data, rowSources } = composeSubmission(bindings, new Map());
    expect(data['label:total|ptr:/total']).toBe(117);
    expect(rowSources).toEqual([]);
  });
});
