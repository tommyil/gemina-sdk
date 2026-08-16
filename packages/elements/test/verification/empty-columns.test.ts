/**
 * The empty-column rule (plan §S).
 *
 * Every world here is built the way the COMPONENT builds one — classify the
 * payload, bind the schema, seed a row plan, plan the cells, promote empty
 * row-mutable tables — because every trap this rule has is a disagreement
 * between two of those steps. Hand-rolling a `ClassifiedData` literal would
 * test the rule against a shape the app never produces, and the casing and
 * synthetic-binding cases below would both evaporate.
 *
 * The payload itself is the synthetic wide-table fixture (plan F16): 19
 * declared columns, 11 blank in every row, camelCase values against snake_case
 * declarations — the real production shape, invented content.
 */
import { describe, expect, it } from 'vitest';
import {
  computeEmptyColumns,
  NO_EMPTY_COLUMNS,
} from '../../src/verification/empty-columns';
import type { EmptyColumnsInput } from '../../src/verification/empty-columns';
import { classifyData } from '../../src/verification/classify';
import type { ClassifiedData } from '../../src/verification/classify';
import { buildBindings, countRowsAt, indexBindingsByFieldPointer } from '../../src/verification/bindings';
import type { FieldBinding } from '../../src/verification/bindings';
import { readDescriptors, readRowMutableTables } from '../../src/verification/field-types';
import type { RowMutableTable } from '../../src/verification/field-types';
import { collectCellViews, declaredTableColumns, planTableCells, unitSizePairErrors } from '../../src/verification/row-cells';
import type { PlannedRow } from '../../src/verification/row-cells';
import { cellEditKey, initialRowPlan, insertRowAfter, removeRow } from '../../src/verification/row-plan';
import type { RowPlanEntry } from '../../src/verification/row-plan';
import { withEmptyMutableTables } from '../../src/verification/form';
import {
  BLANK_LINE_ITEM_COLUMNS,
  LINE_ITEM_COLUMNS,
  wideTableExtraction,
} from './empty-columns.fixture';
import type { WideTableFixtureOptions } from './empty-columns.fixture';

const LINE_ITEMS = '/line_items';

interface World {
  tables: ClassifiedData['tables'];
  plannedTables: ReadonlyMap<string, PlannedRow[]>;
  rowMutableTables: RowMutableTable[];
  bindingIndex: ReadonlyMap<string, FieldBinding>;
  bindings: FieldBinding[];
}

/**
 * The component's derivation chain, verbatim (index.tsx: classifyData /
 * buildBindings / seedRowPlans / declaredTableColumns + planTableCells /
 * withEmptyMutableTables).
 *
 * `tables` is the PROMOTED list, not `classified.tables` — mandatory, not
 * stylistic: a zero-row row-mutable table exists only after promotion, and F9
 * is exactly about that table.
 */
function buildWorld(
  view: Record<string, unknown>,
  replan: (pointer: string, plan: RowPlanEntry[]) => RowPlanEntry[] = (_pointer, plan) => plan,
): World {
  const { values } = view as { values: unknown };
  const feedback = (view.meta as { validationFeedback: Record<string, unknown> }).validationFeedback;
  const schema = feedback.validationSchema as string[];
  const rowMutableTables = readRowMutableTables(feedback.rowMutableTables);
  const classified = classifyData(values);
  const bindings = buildBindings(schema, values, readDescriptors(feedback.validationFields));
  const bindingsByRawKey = new Map(bindings.map((binding) => [binding.key.raw, binding]));

  const plannedTables = new Map<string, PlannedRow[]>();
  for (const table of rowMutableTables) {
    const plan = replan(
      table.pointer,
      initialRowPlan(countRowsAt(values, table.pointer), table.pointer),
    );
    plannedTables.set(
      table.pointer,
      planTableCells(table, plan, declaredTableColumns(table, classified.tables), bindingsByRawKey),
    );
  }

  return {
    tables: withEmptyMutableTables(classified, rowMutableTables).tables,
    plannedTables,
    rowMutableTables,
    bindingIndex: indexBindingsByFieldPointer(bindings),
    bindings,
  };
}

function fixtureWorld(
  options: WideTableFixtureOptions = {},
  replan?: (pointer: string, plan: RowPlanEntry[]) => RowPlanEntry[],
): World {
  return buildWorld(wideTableExtraction(options), replan);
}

function run(world: World, over: Partial<EmptyColumnsInput> = {}) {
  return computeEmptyColumns({
    tables: world.tables,
    plannedTables: world.plannedTables,
    rowMutableTables: world.rowMutableTables,
    bindingIndex: world.bindingIndex,
    touchedEver: new Set<string>(),
    pairErrors: new Map<string, string>(),
    ...over,
  });
}

/**
 * A cell's edit key, taken from the PLANNER rather than spelled out. The
 * `cell:…|col:…` format is row-plan's business; a literal here would keep
 * passing after the rule stopped agreeing with the planner about it.
 */
function editKeyAt(world: World, pointer: string, rowIndex: number, column: string): string {
  const rows = world.plannedTables.get(pointer);
  const cell = rows?.[rowIndex]?.cells.find((candidate) => candidate.column === column);
  if (cell === undefined) {
    throw new Error(`no planned cell ${pointer}[${rowIndex}].${column}`);
  }
  return cell.editKey;
}

const sorted = (columns: Iterable<string> | undefined): string[] => [...(columns ?? [])].sort();
const blanks = sorted(BLANK_LINE_ITEM_COLUMNS);
const blanksExcept = (...kept: string[]): string[] =>
  blanks.filter((column) => !kept.includes(column));

// --- the base rule ----------------------------------------------------------

describe('computeEmptyColumns — blankness', () => {
  it('hides a column blank in every row', () => {
    const empty = run(fixtureWorld());
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanks);
  });

  it('keeps a column with one populated cell', () => {
    // `discount_percentage` is 10 on row 2 and null on the other three — the
    // 276 sparse nulls F15 counted in real, populated columns.
    const empty = run(fixtureWorld());
    expect(empty.get(LINE_ITEMS)?.has('discount_percentage')).toBe(false);
    expect(sorted(empty.get(LINE_ITEMS))).not.toContain('description');
  });

  it('returns the shared NO_EMPTY_COLUMNS when nothing is empty', () => {
    // Every blank column touched in one row disqualifies all of them.
    const world = fixtureWorld();
    const touchedEver = new Set(
      BLANK_LINE_ITEM_COLUMNS.map((column) => editKeyAt(world, LINE_ITEMS, 0, column)),
    );
    // Identity, not equality: the consumer's section memos compare by
    // reference, so a fresh empty Map per render would re-render every table.
    expect(run(world, { touchedEver })).toBe(NO_EMPTY_COLUMNS);
  });
});

// --- touched-ever (F11) -----------------------------------------------------

describe('computeEmptyColumns — touched', () => {
  it('keeps a column the reviewer edited, even to empty string', () => {
    // The VALUE is irrelevant: an edit to '' leaves the cell blank, and the
    // column must still stay put. Only the touch counts.
    const world = fixtureWorld();
    const touchedEver = new Set([editKeyAt(world, LINE_ITEMS, 0, 'barcode')]);
    const empty = run(world, { touchedEver });
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanksExcept('barcode'));
  });

  it('keeps a column the reviewer typed into and then cleared back to pristine', () => {
    // F11: `handleEdit` DELETES the edit when the value returns to pristine, so
    // at this exact moment `edits` no longer holds the key — this is the state
    // an `edits.has()` rule would read as untouched and unmount the column
    // under the reviewer's cursor. `touchedEver` still holds it, and the module
    // takes no `edits` at all, so the only way to get this wrong is to drop the
    // clause: hence the control below.
    const world = fixtureWorld();
    const editKey = editKeyAt(world, LINE_ITEMS, 2, 'tax_rate');
    expect(sorted(run(world, { touchedEver: new Set([editKey]) }).get(LINE_ITEMS)))
      .toEqual(blanksExcept('tax_rate'));
    // Control: the same world with nothing ever touched DOES hide it, so the
    // assertion above is the touch and not an accident of the fixture.
    expect(sorted(run(world).get(LINE_ITEMS))).toContain('tax_rate');
  });

  it('keeps a column an added row was typed into', () => {
    // Added rows walk like any other row — they just cannot make a table
    // eligible (F9). A cell typed into an added row while the filter was off
    // must keep its column visible when the filter comes on.
    const addedId = `${LINE_ITEMS}#added-typed`;
    const world = fixtureWorld({}, (_pointer, plan) => insertRowAfter(plan, plan.length - 1, addedId));
    const touchedEver = new Set([cellEditKey(addedId, 'barcode')]);
    const empty = run(world, { touchedEver });
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanksExcept('barcode'));
  });
});

// --- pair errors (§S, §D5) --------------------------------------------------

describe('computeEmptyColumns — pair errors', () => {
  /** Row 0's `unit_size` filled in, `unit_size_uom` left blank: the trap. */
  function halfFilledPair() {
    const world = fixtureWorld();
    const sizeKey = editKeyAt(world, LINE_ITEMS, 0, 'unit_size');
    const edits = new Map([[sizeKey, '12']]);
    const pairErrors = unitSizePairErrors(
      collectCellViews(world.bindings, world.plannedTables),
      edits,
    );
    return { world, sizeKey, pairErrors };
  }

  it('keeps a column carrying a pair error', () => {
    const { world, sizeKey, pairErrors } = halfFilledPair();
    expect(pairErrors.size).toBe(2); // the fixture really does raise one
    const empty = run(world, { touchedEver: new Set([sizeKey]), pairErrors });
    // `unit_size` is kept because it was touched; `unit_size_uom` is kept ONLY
    // because it carries the error. Hiding it would hide the very cell
    // blocking Submit while the footer reads "1 field needs attention".
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanksExcept('unit_size', 'unit_size_uom'));
  });

  it('ignores pair errors in read-only mode', () => {
    // §D5: an already-validated extraction renders no errors and can submit
    // nothing, so the caller passes an EMPTY pairErrors map. Same world as
    // above — if the rule computed the pair errors itself instead of taking
    // them, this would keep the column and fail.
    const { world } = halfFilledPair();
    const empty = run(world, { touchedEver: new Set(), pairErrors: new Map() });
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanks);
  });
});

// --- §D4: never empty a table ----------------------------------------------

describe('computeEmptyColumns — §D4', () => {
  it('hides nothing in a table where EVERY column qualifies', () => {
    // The eye button, the confidence dot and Remove-line are all <td>s of the
    // grid (F12). Hiding every data column would take them down with it.
    const empty = run(fixtureWorld({ allColumnsBlank: true, withTaxes: true }));
    expect(empty.has(LINE_ITEMS)).toBe(false);
    // …and only THAT table is dropped: the neighbour still reports its blank
    // column, so the guard is per-table and not a bail-out.
    expect(sorted(empty.get('/taxes'))).toEqual(['base']);
  });
});

// --- F9: at least one extracted row ----------------------------------------

describe('computeEmptyColumns — F9', () => {
  it('hides nothing in a zero-row table', () => {
    // `line_items: []` with all 19 columns still declared — observed in the
    // wild. Emptiness over zero rows is vacuous. (Doubly protected: §D4 would
    // also drop this table, so the F9 gate's own weight is carried by the
    // added-rows test below.)
    expect(run(fixtureWorld({ rows: 0 }))).toBe(NO_EMPTY_COLUMNS);
  });

  it('hides nothing in a table whose only rows the reviewer added', () => {
    // The mid-filter "Add line" dead end. Row editing stays on (§D1), so the
    // reviewer clicks Add line on an empty table and types into one cell.
    // Without the "at least one EXTRACTED row" gate the other 18 columns all
    // qualify — §D4 does not save it, because the typed column keeps one — and
    // the table collapses at the exact moment they are filling it in.
    const addedId = `${LINE_ITEMS}#added-first`;
    const world = fixtureWorld({ rows: 0 }, (_pointer, plan) => insertRowAfter(plan, -1, addedId));
    const touchedEver = new Set([cellEditKey(addedId, 'description')]);
    expect(run(world, { touchedEver })).toBe(NO_EMPTY_COLUMNS);
  });
});

// --- F4: walk what renders, not the bindings --------------------------------

describe('computeEmptyColumns — F4', () => {
  it('hides a blank column whose cells have NO binding', () => {
    // `/charges` is declared nowhere and covered by no schema entry, so every
    // one of its cells renders through TableRowView's classified branch with
    // zero CellViews behind it.
    const empty = run(fixtureWorld({ unboundTable: true }));
    expect(sorted(empty.get('/charges'))).toEqual(['chargeCode', 'chargeNote']);
  });

  it('keeps a POPULATED column whose cells have no binding', () => {
    // The real failure mode: a rule walking bindings sees nothing here and
    // hides a column that is visibly full of numbers on screen.
    const empty = run(fixtureWorld({ unboundTable: true }));
    expect(empty.get('/charges')?.has('chargeType')).toBe(false);
    expect(empty.get('/charges')?.has('chargeAmount')).toBe(false);
  });

  it('hides an unbound column of a PLANNED table, whose cells render blank', () => {
    // The other half of F4, and the reason `unboundColumn` cannot test the case
    // above: on a row-mutable table `planTableCells` mints a synthetic
    // NOT_FOUND binding for a schema-uncovered column, so the cell renders as
    // an EMPTY input and the payload's 9.99 never paints. Blank on screen,
    // therefore hidden — F5 reads `binding.extracted`, not `classified.value`.
    const empty = run(fixtureWorld({ unboundColumn: true }));
    expect(empty.get(LINE_ITEMS)?.has('grossLinePrice')).toBe(true);
  });
});

// --- the row plan -----------------------------------------------------------

describe('computeEmptyColumns — the row plan', () => {
  it('walks planned rows when a plan exists, ignoring removed rows', () => {
    // Row 2 is the only one populating `discount_percentage`. Remove it and the
    // column is blank in every row the reviewer can see — so it may hide. A
    // rule walking `table.rows` instead of the plan would still see the removed
    // row's 10 and keep the column.
    const world = fixtureWorld({}, (_pointer, plan) => removeRow(plan, 1));
    expect(sorted(run(world).get(LINE_ITEMS)))
      .toEqual([...blanks, 'discount_percentage'].sort());
  });

  it('resolves the plan through a casing mismatch (/line_items vs /lineItems)', () => {
    // F3: `plannedTables` is keyed by the SERVER pointer while the rendered
    // table carries the PAYLOAD spelling. An exact `.get` falls through to the
    // unplanned branch — which walks `table.rows`, removed row and all — so the
    // removed row is what makes this test discriminating rather than the
    // casing alone (blank columns hide down either path).
    const world = fixtureWorld({ camelTablePointer: true }, (_pointer, plan) => removeRow(plan, 1));
    const empty = run(world);
    // Keyed by the RENDERED pointer, so TableSection needs no matching at all.
    expect(empty.has(LINE_ITEMS)).toBe(false);
    expect(sorted(empty.get('/lineItems')))
      .toEqual([...blanks, 'discount_percentage'].sort());
  });
});

// --- §S consequence 3: independent of the confidence filter -----------------

describe('computeEmptyColumns — the confidence filter', () => {
  it('counts a row hidden by the confidence filter', () => {
    // The rule takes no HiddenSets: if it did, the column set would shift every
    // time the OTHER filter toggled. Row 2 scores `high` — the confidence
    // filter would hide it — and it is the only row populating
    // `discount_percentage`, which therefore stays visible (and, with both
    // filters on, reads blank; that is §S's accepted cost).
    const view = wideTableExtraction();
    const rows = (view.values as { line_items: Array<Record<string, unknown>> }).line_items;
    rows[1]!.confidence = 'high';
    const empty = run(buildWorld(view));
    expect(sorted(empty.get(LINE_ITEMS))).toEqual(blanks);
    expect(empty.get(LINE_ITEMS)?.has('discount_percentage')).toBe(false);
  });
});

// --- shape ------------------------------------------------------------------

describe('computeEmptyColumns — shape', () => {
  it('names only declared columns, in the declared spelling', () => {
    // The payload spells them camelCase; the hidden set must use the DISPLAY
    // names TableSection filters by, or nothing matches and nothing hides.
    const empty = run(fixtureWorld());
    for (const column of empty.get(LINE_ITEMS) ?? []) {
      expect(LINE_ITEM_COLUMNS as readonly string[]).toContain(column);
    }
  });
});
