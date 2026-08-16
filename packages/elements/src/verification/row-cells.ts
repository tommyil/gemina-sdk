/**
 * The one model of "what cells does this table currently have".
 *
 * Four consumers need it — the form's rendering, the unit-size pair rule,
 * Phase 6's submit gate, and `composeSubmission` — and deriving it four times
 * would let them disagree about which row a cell belongs to. Under row editing
 * that disagreement is not cosmetic: it silently attributes a reviewer's
 * correction to the wrong line item.
 *
 * Every cell carries THREE identities, because they genuinely differ:
 *
 * - `editKey` follows the ROW (`cellEditKey(rowId, column)`), so an edit stays
 *   with its row when rows above it are deleted.
 * - `submitKey` follows the SUBMITTED POSITION, because the payload must mirror
 *   the approved table — row 3 of what the reviewer sees is `/line_items/2/…`
 *   on the wire regardless of where it was extracted from.
 * - `binding.key` follows the EXTRACTED position, because that is where the
 *   value and its coordinates actually live.
 *
 * For an untouched table all three agree, which is why this never mattered
 * before.
 */

import { toInputString } from './bindings';
import type { FieldBinding } from './bindings';
import type { ClassifiedCell } from './classify';
import { cellSchemaKey } from './field-types';
import type { RowMutableTable, ValidationFieldDescriptor } from './field-types';
import { NOT_FOUND, parseSchemaKey, snakeToCamel } from './pointer';
import { cellEditKey } from './row-plan';
import type { RowPlanEntry } from './row-plan';

export interface PlannedCell {
  column: string;
  /** Where this cell's edit is stored. Stable across row moves. */
  editKey: string;
  /** The raw schema key this cell is submitted under. Follows position. */
  submitKey: string;
  /** Real for an extracted row; synthesized for one the reviewer added. */
  binding: FieldBinding;
  /** True when there is no extracted value behind this cell. */
  added: boolean;
}

export interface PlannedRow {
  entry: RowPlanEntry;
  cells: PlannedCell[];
}

/**
 * A binding for a cell of a row that was never extracted.
 *
 * Deliberately the SAME shape the "Not detected" fill-in path already renders:
 * `NOT_FOUND` with `editable: true`. That is not a convenience — it is what
 * makes an added row's cells behave identically to a field the model missed,
 * which is exactly what they are.
 */
function syntheticBinding(
  submitKey: string,
  descriptor: ValidationFieldDescriptor | undefined,
): FieldBinding | null {
  const key = parseSchemaKey(submitKey);
  if (key === null) {
    return null;
  }
  return {
    key,
    serverValue: NOT_FOUND,
    extracted: NOT_FOUND,
    // No extracted node, so nothing to point at on the document.
    fieldPointer: key.pointer,
    editable: true,
    field: descriptor,
  };
}

/**
 * Resolve every cell of a row-mutable table under its current plan.
 *
 * `columns` is the display order — the classifier's for a table with rows, the
 * server's declared column list for one with none.
 */
export function planTableCells(
  table: RowMutableTable,
  plan: readonly RowPlanEntry[],
  columns: readonly string[],
  bindingsByRawKey: ReadonlyMap<string, FieldBinding>,
): PlannedRow[] {
  const descriptors = new Map<string, ValidationFieldDescriptor>();
  for (const column of table.columns) {
    if (typeof column.key === 'string') {
      descriptors.set(column.key, column);
    }
  }

  return plan.map((entry, submittedIndex) => {
    const cells: PlannedCell[] = [];
    for (const column of columns) {
      const submitKey = cellSchemaKey(table.keyTemplate, submittedIndex, column);
      const editKey = cellEditKey(entry.id, column);
      const extractedKey = entry.source === null
        ? null
        : cellSchemaKey(table.keyTemplate, entry.source, column);
      const existing = extractedKey === null ? undefined : bindingsByRawKey.get(extractedKey);
      const binding = existing ?? syntheticBinding(submitKey, descriptors.get(column));
      if (binding === null) {
        continue;
      }
      cells.push({ column, editKey, submitKey, binding, added: existing === undefined });
    }
    return { entry, cells };
  });
}

/**
 * The display columns for a table: the server's declaration, plus anything the
 * classifier saw that the server did not declare.
 *
 * The SERVER's list is canonical because it is derived from the model, so it is
 * complete and present even for a zero-row table — the case a reviewer most
 * needs, since the model found nothing at all.
 *
 * The classifier's list cannot be trusted alone: it samples column names from
 * ROW 0 ONLY (`Object.keys(first)`), so a field absent from the first row but
 * present in a later one would not appear here — and because a planned table
 * suppresses every binding under its pointer, that value would be dropped from
 * the submission entirely, silently, even with no row edits. Merging is what
 * makes the suppression safe.
 */
export function displayColumns(
  table: RowMutableTable,
  classifiedColumns: readonly string[],
): string[] {
  const declared = table.columns
    .map((column) => column.key)
    .filter((name): name is string => typeof name === 'string');
  // The schema uses model field names (snake_case), while the response DTO
  // serializes those same fields as camelCase. Exact comparison rendered the
  // entire table twice: every declared column followed by its classified
  // alias. Keep the server spelling as the canonical display/submission name,
  // and use the client's one shared casing rule only for de-duplication.
  // Declared names themselves are never collapsed, so a dynamic template that
  // genuinely declares both spellings still keeps both columns.
  const declaredAliases = new Set(declared.map(snakeToCamel));
  return [
    ...declared,
    ...classifiedColumns.filter((name) => !declaredAliases.has(snakeToCamel(name))),
  ];
}

/**
 * `/line_items` and the payload's `/lineItems` are the same table.
 *
 * Uses the SHARED casing rule rather than a local copy: two copies that drift
 * is precisely how a pointer silently stops resolving.
 */
export function matchesTablePointer(serverPointer: string, classifiedPointer: string): boolean {
  return serverPointer === classifiedPointer || snakeToCamel(serverPointer) === classifiedPointer;
}

/** As much of a classified table as pairing it with its declaration needs. */
interface ClassifiedTableLike {
  pointer: string;
  columns: string[];
}

/**
 * The one place `displayColumns` is called from.
 *
 * A table's column list is needed from BOTH ends — the form renders it, and the
 * cell planner keys `PlannedCell.editKey` by it — and the two used to derive it
 * separately with nothing forcing them to agree. `planTableCells`' output is
 * what `resolveRowCell` consults for edit keys, so a drift there attributes a
 * reviewer's correction to the wrong column rather than merely mis-rendering.
 *
 * Returns `classifiedColumns` ITSELF when there is no declaration, not a copy:
 * `areRowPropsEqual` compares `columns` by reference (form.tsx), so a defensive
 * copy here would re-render every row of the table on every keystroke.
 *
 * Deliberately NOT exported. The two wrappers below each pair a table with its
 * counterpart before calling this; an exported low-level form would let a
 * fourth caller hand it a mismatched pair and skip the pairing entirely, which
 * is the drift this whole file exists to close.
 */
function columnsForTable(
  mutable: RowMutableTable | undefined,
  classifiedColumns: string[],
): string[] {
  return mutable ? displayColumns(mutable, classifiedColumns) : classifiedColumns;
}

/**
 * Renderer direction: the classified table in hand, its declaration looked up.
 *
 * Returns the declaration too, because the caller needs it for the row controls
 * and the column descriptions — and looking it up twice is how the control and
 * the columns would come to disagree about which table this is.
 */
export function tableColumns(
  table: ClassifiedTableLike,
  rowMutableTables: readonly RowMutableTable[],
): { mutable: RowMutableTable | undefined; columns: string[] } {
  const mutable = rowMutableTables.find((entry) => matchesTablePointer(entry.pointer, table.pointer));
  return { mutable, columns: columnsForTable(mutable, table.columns) };
}

/**
 * Plan-builder direction: the declaration in hand, its classified table looked
 * up. A server-declared table the extraction found nothing in has no classified
 * counterpart at all — that is the zero-row table a reviewer types the first
 * line into, so it must still yield its declared columns.
 */
export function declaredTableColumns(
  mutable: RowMutableTable,
  classifiedTables: readonly ClassifiedTableLike[],
): string[] {
  const classified = classifiedTables.find(
    (candidate) => matchesTablePointer(mutable.pointer, candidate.pointer),
  );
  return columnsForTable(mutable, classified?.columns ?? []);
}

/** One rendered table row: the extracted data behind it, and its plan entry. */
export interface TableRowRef {
  /** The classified row — undefined for a row the reviewer added. */
  row: Record<string, ClassifiedCell> | undefined;
  /** Present ONLY for a row-mutable table. */
  planned: PlannedRow | undefined;
  /**
   * Index in the UNFILTERED collection: the plan position where there is a
   * plan, else the extracted index. It travels with the row because
   * onAddRow/onRemoveRow take a plan POSITION — renumbering after a filter
   * would target the wrong row.
   */
  position: number;
}

/**
 * Which rows a table renders, in order — the plan's where there is one, the
 * extracted array's where there is not.
 *
 * Shared rather than re-derived, for the same reason `tableColumns` is. The
 * mapping is three lines and looks too small to bother sharing, which is
 * exactly why it had been written out three times. Its failure mode is silent
 * in both directions: a rule that walks MORE rows than the form renders reads
 * values the reviewer cannot see, and one that walks FEWER calls a column
 * blank over rows it never looked at — which, for the empty-column filter,
 * makes a populated column vanish with no error anywhere.
 *
 * The row KEY (`entry.id` / `unplannedRowKey`) is deliberately NOT here: it
 * belongs to the review filter, which owns both spellings, and importing it
 * would make this module depend on a consumer.
 */
export function tableRows(
  table: { rows: ReadonlyArray<Record<string, ClassifiedCell>> },
  planned: readonly PlannedRow[] | undefined,
): TableRowRef[] {
  if (planned === undefined) {
    return table.rows.map((row, position) => ({ row, planned: undefined, position }));
  }
  return planned.map((plannedRow, position) => ({
    // An added row was never extracted, so it exists only in the plan.
    row: plannedRow.entry.source === null ? undefined : table.rows[plannedRow.entry.source],
    planned: plannedRow,
    position,
  }));
}

/** One rendered table cell: what paints, and under which key it is edited. */
export interface ResolvedCell {
  /** The classified leaf behind this column, if the payload carries one. */
  classified: ClassifiedCell | undefined;
  /** Undefined ONLY on an unplanned table whose column no schema key covers. */
  binding: FieldBinding | undefined;
  /** Undefined exactly when `binding` is — nothing can key an edit here. */
  editKey: string | undefined;
}

/**
 * What one cell of one table row actually renders from.
 *
 * Extracted from `TableRowView`'s local `cellFor` so the emptiness rule
 * (empty-columns.ts) resolves cells the SAME way the renderer does. Two copies
 * would let the rule call a cell blank while the screen shows a value — the
 * exact class of bug F4 records, and one with no symptom other than a column
 * quietly disappearing.
 *
 * Column names are matched casing-aware because the server declares them in
 * snake_case while the response DTO serialises them camelCase, and that
 * mismatch is present on EVERY row of EVERY real extraction (`unit_of_measure`
 * declared vs `unitOfMeasure` in the payload). Precedence is deliberate: an
 * EXACT key first, because a dynamic template may genuinely declare either
 * spelling; then the camelised name; then a scan for any payload key that
 * camelises to the same thing, which is what catches a payload that kept the
 * snake spelling against a camel declaration.
 *
 * The plan wins over the pointer lookup wherever there is one: a planned cell's
 * edit key follows its ROW, so after a row is removed the pointer-derived key
 * would attribute the correction to whichever row moved up into that position.
 */
export function resolveRowCell(
  row: Record<string, ClassifiedCell> | undefined,
  column: string,
  planned: PlannedRow | undefined,
  bindingIndex: ReadonlyMap<string, FieldBinding>,
): ResolvedCell {
  const direct = row?.[column];
  const alias = direct === undefined ? row?.[snakeToCamel(column)] : undefined;
  const fallbackKey = direct === undefined && alias === undefined && row !== undefined
    ? Object.keys(row).find((key) => snakeToCamel(key) === snakeToCamel(column))
    : undefined;
  const classified = direct ?? alias ?? (fallbackKey === undefined ? undefined : row?.[fallbackKey]);
  const fromPlan = planned?.cells.find((cell: PlannedCell) => cell.column === column);
  if (fromPlan) {
    return { classified, binding: fromPlan.binding, editKey: fromPlan.editKey };
  }
  const binding = classified === undefined ? undefined : bindingIndex.get(classified.pointer);
  return { classified, binding, editKey: binding?.key.raw };
}

/**
 * Every editable cell in the form, as one flat list.
 *
 * The pair rule and the submit gate both need "what can be edited, and under
 * which key" — and BOTH were previously derived from raw schema keys, which a
 * planned table cell no longer uses. Deriving them separately is how they
 * would drift apart; this is the single source they now share.
 *
 * `rowKey` groups cells that belong to the same row. For a planned table that
 * is the row's stable id; elsewhere it is the pointer prefix, which is what
 * the pre-row-editing code effectively used.
 */
export interface CellView {
  editKey: string;
  /** The raw schema key this cell goes on the wire under. */
  submitKey: string;
  column: string;
  rowKey: string;
  binding: FieldBinding;
  /** True when nothing was extracted here — a row the reviewer added. */
  added: boolean;
}

/** `/line_items/3/unit_size` -> `{ row: '/line_items/3', field: 'unit_size' }`. */
function splitPointer(pointer: string): { row: string; field: string } | null {
  const cut = pointer.lastIndexOf('/');
  return cut <= 0 ? null : { row: pointer.slice(0, cut), field: pointer.slice(cut + 1) };
}

/**
 * Flatten bindings and planned tables into one list of cell views.
 *
 * A planned table OWNS every binding under its pointer — not merely the ones
 * its surviving rows still reference. Skipping only the referenced ones leaves
 * a DELETED row's bindings in the list, and since they carry their original
 * raw key as their submit key they overwrite whichever row moved up into that
 * position: the deletion silently does nothing, and the payload claims a row
 * the reviewer removed. Ownership is by pointer prefix, so the whole table
 * comes from the plan or none of it does.
 */
export function collectCellViews(
  bindings: readonly FieldBinding[],
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
): CellView[] {
  const views: CellView[] = [];
  const ownedPrefixes = [...plannedTables.keys()].map((pointer) => `${pointer}/`);

  for (const rows of plannedTables.values()) {
    for (const row of rows) {
      for (const cell of row.cells) {
        views.push({
          editKey: cell.editKey,
          submitKey: cell.submitKey,
          column: cell.column,
          rowKey: row.entry.id,
          binding: cell.binding,
          added: cell.added,
        });
      }
    }
  }

  for (const binding of bindings) {
    if (ownedPrefixes.some((prefix) => binding.key.pointer.startsWith(prefix))) {
      continue;
    }
    const split = splitPointer(binding.key.pointer);
    views.push({
      // Outside a plan all three identities coincide, which is why none of
      // this was needed before row editing.
      editKey: binding.key.raw,
      submitKey: binding.key.raw,
      column: split?.field ?? binding.key.label,
      rowKey: split?.row ?? binding.key.raw,
      binding,
      added: false,
    });
  }
  return views;
}

/** The one cross-field rule the server enforces. Deliberately not a rules engine. */
const UNIT_SIZE = 'unit_size';
const UNIT_SIZE_UOM = 'unit_size_uom';
export const UNIT_PAIR_MESSAGE = 'Enter both value and unit';

/**
 * Rows where exactly one half of the unit-size pair is filled in.
 *
 * The server treats `unit_size` and `unit_size_uom` as both-or-nothing:
 * `_unit_size_pair_rule` (invoice_line_item.py:50-56) nulls BOTH whenever
 * either is missing, on every parse INCLUDING the scorer's. So a reviewer who
 * fills one and not the other has both silently zeroed before scoring, and
 * `onComplete` would hand the host a value the backend had already discarded.
 * Flagging it is the only way the reviewer ever learns.
 *
 * Keyed by EDIT key, and grouped by `rowKey`, so it works identically for an
 * extracted row and one the reviewer added — an added row is exactly where a
 * half-filled pair is most likely.
 *
 * Deliberately hard-coded to this pair rather than generalised. Exactly one
 * such rule exists in the models; a cross-field rules DSL would be speculative
 * flexibility with no second caller.
 */
export function unitSizePairErrors(
  cells: readonly CellView[],
  edits: ReadonlyMap<string, string>,
): Map<string, string> {
  const rows = new Map<string, { size?: CellView; uom?: CellView }>();
  for (const cell of cells) {
    if (cell.column !== UNIT_SIZE && cell.column !== UNIT_SIZE_UOM) {
      continue;
    }
    const row = rows.get(cell.rowKey) ?? {};
    if (cell.column === UNIT_SIZE) {
      row.size = cell;
    } else {
      row.uom = cell;
    }
    rows.set(cell.rowKey, row);
  }

  const errors = new Map<string, string>();
  for (const { size, uom } of rows.values()) {
    // A row missing one half of the pair from its schema entirely cannot be
    // half-filled, so there is nothing to enforce.
    if (!size || !uom) {
      continue;
    }
    const filled = (cell: CellView) =>
      (edits.get(cell.editKey) ?? toInputString(cell.binding.extracted)).trim() !== '';
    if (filled(size) !== filled(uom)) {
      errors.set(size.editKey, UNIT_PAIR_MESSAGE);
      errors.set(uom.editKey, UNIT_PAIR_MESSAGE);
    }
  }
  return errors;
}

/**
 * Drop added rows the reviewer never typed into.
 *
 * Clicking "Add line" and then changing your mind is ordinary. Every cell of
 * such a row is already omitted from `data` — but its `null` source would
 * remain in the alignment, asserting to the scorer that a row exists there.
 * On a submission that happens exactly once, that is a phantom line item on
 * the record with nothing in it.
 *
 * Only ADDED rows are pruned. An extracted row the reviewer emptied is a
 * deliberate assertion that its content is wrong, and must survive.
 */
export function pruneEmptyAddedRows(
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
  edits: ReadonlyMap<string, string>,
): Map<string, PlannedRow[]> {
  const out = new Map<string, PlannedRow[]>();
  for (const [pointer, rows] of plannedTables) {
    out.set(pointer, rows.filter((row) => {
      if (row.entry.source !== null) {
        return true;
      }
      return row.cells.some((cell) => (edits.get(cell.editKey) ?? '').trim() !== '');
    }));
  }
  return out;
}
