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
import {
  collectCellViews, declaredTableColumns, displayColumns, planTableCells, tableColumns,
} from '../../src/verification/row-cells';
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

/**
 * The renderer and the plan builder used to derive a table's column list
 * separately — and nothing forced them to agree, even though `planTableCells`'
 * output is what `resolveRowCell` later consults for edit keys. A drift there
 * mis-attributes a correction rather than merely mis-rendering, so both
 * directions now bottom out in `columnsForTable`.
 */
describe('tableColumns', () => {
  it('tableColumns returns the server display order for a mutable table', () => {
    const table = {
      pointer: '/lineItems', columns: ['description'], rows: [], key: 'lineItems', overallConfidence: null,
    };
    const mutable = {
      ...TABLE,
      columns: [
        { key: 'catalog_number', type: 'string' as const },
        { key: 'description', type: 'string' as const },
      ],
    };
    expect(tableColumns(table, [mutable]).columns).toEqual(['catalog_number', 'description']);
  });

  it('tableColumns falls back to the classified columns when nothing is declared', () => {
    const table = {
      pointer: '/taxes', columns: ['rate', 'amount'], rows: [], key: 'taxes', overallConfidence: null,
    };
    const resolved = tableColumns(table, []);
    expect(resolved.columns).toEqual(['rate', 'amount']);
    expect(resolved.mutable).toBeUndefined();
    // The SAME array, not a copy. `areRowPropsEqual` compares `columns` by
    // reference (form.tsx), so a defensive copy here re-renders every row of
    // the table on every keystroke.
    expect(resolved.columns).toBe(table.columns);
  });

  it('the plan builder and the renderer derive the SAME columns for a casing mismatch', () => {
    const mutable = {
      ...TABLE,
      columns: [
        { key: 'unit_of_measure', type: 'string' as const },
        { key: 'description', type: 'string' as const },
      ],
    };
    const classified = {
      key: 'lineItems',
      pointer: '/lineItems',
      // `notes` is UNDECLARED, and it is what makes this test discriminating:
      // with every classified column an alias of a declared one, a lookup that
      // failed outright would produce the same declared-only answer and the
      // assertion would hold under the bug. The undeclared column can only
      // appear if the pointer actually resolved across the casing mismatch.
      columns: ['unitOfMeasure', 'description', 'notes'],
      rows: [],
      overallConfidence: null,
    };
    // The renderer holds the classified table and looks the declaration up;
    // the plan builder runs the other way round. Same answer either way.
    const rendered = tableColumns(classified, [mutable]).columns;
    expect(rendered).toEqual(['unit_of_measure', 'description', 'notes']);
    expect(declaredTableColumns(mutable, [classified])).toEqual(rendered);
  });

  it('declaredTableColumns keeps the declaration for a table the classifier never saw', () => {
    // F9's zero-row row-mutable table: promoted for the reviewer to type into,
    // so it has a declaration and no classified counterpart at all.
    expect(declaredTableColumns(TABLE, [])).toEqual(['description']);
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
