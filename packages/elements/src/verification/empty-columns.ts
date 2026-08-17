/**
 * "Hide empty columns": which table columns are blank in every row of the
 * table's current row plan. (Not "which columns nothing was extracted into" —
 * see constraint 6: the plan drops rows the reviewer removed, so a column the
 * extraction populated can qualify here.)
 *
 * The second review filter, and deliberately independent of the first. A real
 * `invoice_line_items` extraction declares 19 columns and leaves 5 to 16 of
 * them blank in every single row — that is the normal state of the data, not
 * an edge case — so a reviewer reads a 19-column grid to check four values.
 *
 * Kept out of the form for the same reason `review-filter.ts` is: the rule is
 * one thing, testable without rendering, defined once. Six constraints run
 * through it, each recording a failure it prevents:
 *
 * 1. WALK WHAT RENDERS, NOT THE BINDINGS. A table with no `rowMutableTables`
 *    declaration renders any column the validation schema does not cover
 *    straight from the classified value, with no binding and no `CellView`
 *    behind it (form.tsx, TableRowView's `classified` branch). A rule derived
 *    from bindings sees nothing there and hides a column visibly full of
 *    numbers. Hence `resolveRowCell` — the renderer's own resolution — rather
 *    than a walk over `cellViews`.
 *
 * 2. BLANKNESS READS WHAT THAT CELL ACTUALLY PAINTS. Where a binding exists
 *    that is `binding.extracted`, NOT `classified.value`: the editable path
 *    renders `toInputString(binding.extracted)` and the read-only path
 *    `formatValue(binding.extracted)`. The two diverge exactly on a planned
 *    table whose column the schema misses — the planner substitutes a
 *    NOT_FOUND binding, so the cell renders as an empty input while the
 *    payload still holds a value. It is blank on screen, so it is blank here.
 *
 * 3. TOUCHED MEANS TOUCHED-EVER. `handleEdit` DELETES an edit when the value
 *    returns to pristine, so `edits.has()` means "differs from the extraction
 *    right now", not "the reviewer has been here". A reviewer who types into a
 *    blank cell and clears it again would un-touch it and the column would
 *    unmount under their cursor. The caller passes a Set that is only ever
 *    added to.
 *
 * 4. AT LEAST ONE EXTRACTED ROW. Row editing stays enabled while this filter
 *    is on, so "at least one row" is the wrong gate: the reviewer clicks
 *    "Add line" on an empty table, the new row is blank in every column, every
 *    column qualifies — and the table collapses at the exact moment they try to
 *    type into it. Added rows still take part in the walk; they just cannot be
 *    what makes a table eligible.
 *
 * 5. NEVER EMPTY A TABLE. The document-eye cell, the confidence dot and the
 *    Remove-line control are all `<td>`s of the row (form.tsx). A table whose
 *    every column qualified would lose all three along with its data, so it
 *    contributes nothing at all to the result.
 *
 * 6. INDEPENDENT OF THE CONFIDENCE FILTER. This takes no `HiddenSets`:
 *    emptiness is computed over the whole row plan, including rows the other
 *    filter is hiding. If it were not, the visible column set would shift every
 *    time the other switch toggled. The accepted cost is that a column
 *    populated only in a confidence-hidden row stays visible and reads blank —
 *    which is why the copy may not claim the columns are empty "in what you are
 *    looking at". Nor may it claim they were empty in the EXTRACTION: the plan
 *    drops rows the reviewer removed, so a column the extraction populated on a
 *    since-removed row qualifies here. What is true in every state is exactly
 *    what this function computes — blank in every row of the plan — and that is
 *    what the note says.
 */

import { toInputString } from './bindings';
import type { FieldBinding } from './bindings';
import type { ClassifiedData } from './classify';
import type { RowMutableTable } from './field-types';
import { planForTable } from './review-filter';
import { resolveRowCell, tableColumns, tableRows } from './row-cells';
import type { PlannedRow, ResolvedCell } from './row-cells';

/** Rendered table pointer -> the columns of it that may be hidden. */
export type EmptyColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** Shared "nothing is empty", so the section memos see no change. The readonly
 *  TYPE is the guarantee — a Map stays mutable at runtime — so nothing may
 *  write to this. (Same contract as `NOTHING_HIDDEN` in review-filter.ts.) */
export const NO_EMPTY_COLUMNS: EmptyColumns = new Map();

export interface EmptyColumnsInput {
  /** What the FORM renders — `withEmptyMutableTables`' output, which includes
   *  a server-declared zero-row table the classifier never saw. */
  tables: ClassifiedData['tables'];
  /** Keyed by the SERVER-declared pointer; resolved with `planForTable`. */
  plannedTables: ReadonlyMap<string, PlannedRow[]>;
  rowMutableTables: readonly RowMutableTable[];
  /** Pointer-keyed — `indexBindingsByFieldPointer`. */
  bindingIndex: ReadonlyMap<string, FieldBinding>;
  /** Edit keys typed into at ANY point this session — NOT `edits` (see 3). */
  touchedEver: ReadonlySet<string>;
  /** Empty in read-only mode: nothing renders an error and nothing can be
   *  submitted there, so a blank pair-partner has no reason to stay. */
  pairErrors: ReadonlyMap<string, string>;
}

/**
 * One cell's verdict: may this cell let its column be hidden?
 *
 * `toInputString(...).trim() === ''` is faithful to all three render paths:
 * it returns `''` for `NOT_FOUND | null | undefined`, and `formatValue` — the
 * non-editable path — only ever ADDS characters to a non-null value, rendering
 * `'-'` for a null one. So the value side needs no `'-'` special case.
 */
function qualifies(
  cell: ResolvedCell,
  touchedEver: ReadonlySet<string>,
  pairErrors: ReadonlyMap<string, string>,
): boolean {
  const { editKey } = cell;
  // An unbound cell has no edit key, so it can be neither touched nor in
  // error — the checks fall away rather than needing a branch of their own.
  if (editKey !== undefined && (touchedEver.has(editKey) || pairErrors.has(editKey))) {
    return false;
  }
  // Constraint 2, at its site: the binding WINS wherever there is one. Only a
  // cell with no binding at all renders from the classified value, and reading
  // `classified.value` first would call a planned cell populated while the
  // input beside it sits empty — the synthetic-NOT_FOUND case.
  const value = cell.binding === undefined ? cell.classified?.value : cell.binding.extracted;
  return toInputString(value).trim() === '';
}

/**
 * The columns of every rendered table that are blank in every row of its
 * current row plan.
 *
 * Say it that way, and not "the columns nothing was extracted into": the plan
 * drops rows the reviewer REMOVED, so a column the extraction did populate —
 * on a since-removed row — qualifies here. That is why the shipped note reads
 * `N columns hidden — blank in every row` rather than naming the extraction,
 * and it is the sentence a future "clarification" of this doc must not
 * quietly walk back (form.tsx has the full argument, at the note itself).
 */
export function computeEmptyColumns(input: EmptyColumnsInput): EmptyColumns {
  const {
    tables, plannedTables, rowMutableTables, bindingIndex, touchedEver, pairErrors,
  } = input;

  const empty = new Map<string, ReadonlySet<string>>();

  for (const table of tables) {
    // The SAME column list the form renders and the plan builder keyed its
    // cells by. Deriving it a third time here is what re-creates the
    // `/line_items` vs `/lineItems` silent miss v0.13.2 had to fix.
    const { columns } = tableColumns(table, rowMutableTables);
    if (columns.length === 0) {
      continue;
    }

    // The plan is what is on screen where there is one: it carries the rows the
    // reviewer added and drops the ones they removed. Resolved by
    // `planForTable` because the plan is keyed by the SERVER pointer while this
    // table carries the payload's spelling — an exact lookup silently falls
    // through to the unplanned branch and walks removed rows.
    //
    // `tableRows` is the SAME derivation TableSection renders from, not a copy
    // of it, so the rule and the grid can never disagree about which rows a
    // table has. Note this is the row PLAN, not what is on screen: per
    // constraint 6 the confidence filter may be hiding some of these rows, and
    // they are walked anyway.
    const rows = tableRows(table, planForTable(plannedTables, table.pointer));

    // Constraint 4: EXTRACTED rows, not rows. Asked of the plan's own `added`
    // flag rather than inferred from "no classified data behind it": those two
    // differ for a row whose source does not resolve, and that row IS an
    // extracted one — one whose data went missing. Treating it as added would
    // let a plan regression silently re-open every column of the table to
    // hiding, which is the shape of failure this gate exists to prevent.
    // On an unplanned table nothing is added, so this reads as "has rows".
    if (!rows.some((row) => !row.added)) {
      continue;
    }

    const hidden = new Set<string>();
    for (const column of columns) {
      const blankEverywhere = rows.every((row) => qualifies(
        resolveRowCell(row.row, column, row.planned, bindingIndex),
        touchedEver,
        pairErrors,
      ));
      if (blankEverywhere) {
        hidden.add(column);
      }
    }

    // Nothing to record: a table with no empty column contributes no entry, so
    // `emptyColumns.get(pointer)` is undefined rather than an empty Set.
    if (hidden.size === 0) {
      continue;
    }
    // Constraint 5: a table that would lose every data column keeps them all.
    if (hidden.size === columns.length) {
      continue;
    }
    // Keyed by the RENDERED pointer — the one TableSection holds — so the
    // consumer needs no pointer matching of its own.
    empty.set(table.pointer, hidden);
  }

  return empty.size === 0 ? NO_EMPTY_COLUMNS : empty;
}
