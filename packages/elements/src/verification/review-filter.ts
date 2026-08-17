/**
 * The review filter: which fields and rows the reviewer can hide because the
 * model already scored them `high`.
 *
 * Kept separate from the form so the rule is testable without rendering, and
 * so there is exactly ONE definition of "already reviewed" rather than one per
 * section component.
 *
 * Three design constraints run through this file, all learned the hard way:
 *
 * 1. Identity comes from `CellView`/`PlannedRow`, never from a pointer built
 *    by hand. Under row editing a cell's edit key, its submitted key and its
 *    extracted binding genuinely differ (see row-cells.ts), and reconstructing
 *    any of them from a JSON pointer is exactly what row planning exists to
 *    prevent. Get it wrong and an edited row is hidden anyway.
 *
 * 2. Unmeasured is not reviewed. A field with no confidence at all has not
 *    been checked by anything; hiding it would drop it from review silently.
 *    Only an explicit `high` hides.
 *
 * 3. Counting and hiding must walk the SAME units. When they disagree, the
 *    footer's "Showing X of Y" contradicts the screen — which reads to a
 *    reviewer as data having gone missing. That is why every consumer here
 *    shares the two traversals below instead of re-deriving the buckets.
 */

import { ROW_META_KEY } from './classify';
import type { ClassifiedData } from './classify';
import type { FieldBinding } from './bindings';
import { matchesTablePointer, tableRows } from './row-cells';
import type { CellView, PlannedRow } from './row-cells';

export type ConfidenceLike = { level: string; reasons: string[] } | null | undefined;

/** Only an explicit `high` hides. */
export function isHighConfidence(confidence: ConfidenceLike): boolean {
  return (confidence?.level ?? '').toLowerCase() === 'high';
}

export interface HiddenSets {
  /** Field pointers (headers, list items, entity cells). */
  fields: ReadonlySet<string>;
  /** Row keys, in the same spelling `CellView.rowKey` uses. */
  rows: ReadonlySet<string>;
}

/** Shared empty result, so "nothing hidden" is always the same object and the
 *  section memos see no change. The readonly TYPE is the guarantee — a Set
 *  stays mutable at runtime even under Object.freeze — so nothing may write to
 *  these. */
export const NOTHING_HIDDEN: HiddenSets = {
  fields: new Set<string>(),
  rows: new Set<string>(),
};

/**
 * How a row of an UNPLANNED table is addressed: its row pointer, which is what
 * `collectCellViews` derives by splitting the cell pointer.
 *
 * A planned row is addressed by `entry.id` instead, and that id is ALREADY
 * scoped with the table pointer by `initialRowPlan` (`/taxes#row-0`) — so it
 * is used verbatim. Prefixing it again would produce `/taxes#/taxes#row-0` and
 * match nothing, hiding silently.
 */
export const unplannedRowKey = (tablePointer: string, index: number): string => `${tablePointer}/${index}`;

/**
 * The plan for a RENDERED table, resolved the way its pointer actually spells.
 *
 * `plannedTables` is keyed by the SERVER-declared pointer, which need not match
 * the payload's spelling — a server `/line_items` can classify as `/lineItems`.
 * Anything holding a RENDERED table's pointer must therefore resolve it with
 * matchesTablePointer — as `tableColumns` (row-cells.ts) does to find that
 * table's declaration — rather than looking it up exactly: an exact lookup
 * silently falls through to the unplanned branch, generating `/lineItems/0`
 * keys while the rendered rows are keyed `/line_items#row-0`. Nothing would
 * ever hide, and no error would be raised — which is why this is one exported
 * function rather than a closure each caller re-writes.
 *
 * TableSection itself needs none of this (form.tsx): by then it holds the
 * DECLARATION, and `mutable.pointer` is the map key verbatim.
 */
export function planForTable(
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
  tablePointer: string,
): PlannedRow[] | undefined {
  const exact = plannedTables.get(tablePointer);
  if (exact !== undefined) return exact;
  for (const [serverPointer, planned] of plannedTables) {
    if (matchesTablePointer(serverPointer, tablePointer)) return planned;
  }
  return undefined;
}

/** The tables the FORM renders — `withEmptyMutableTables`' output, not
 *  `classified.tables`. They differ: an empty server-declared row-mutable
 *  table is promoted into the rendered list without existing in the
 *  classifier's output, and rows the reviewer adds to one would otherwise
 *  render uncounted. */
type RenderedTables = ClassifiedData['tables'];

/**
 * Every non-table review unit, once: header fields, simple-list items and
 * entity-card cells.
 *
 * One traversal shared by the hide rule, the counter and the
 * "is there anything to filter" check — when those three disagreed about which
 * buckets exist, the counter contradicted the screen.
 */
function forEachFieldUnit(
  classified: ClassifiedData,
  visit: (pointer: string, confidence: ConfidenceLike) => void,
): void {
  for (const header of classified.headers) visit(header.pointer, header.confidence);
  for (const list of classified.simpleLists) {
    for (const item of list.items) visit(item.pointer, item.confidence);
  }
  for (const entity of classified.entities) {
    for (const item of entity.items) {
      for (const cell of Object.values(item)) visit(cell.pointer, cell.confidence);
    }
  }
}

/**
 * Every table ROW the form renders, once, with the key it is addressed by.
 *
 * A row counts and hides as a whole, never per cell. The plan wins where there
 * is one: it carries the rows the reviewer added and drops the ones they
 * removed, so it — not the extracted array — is what is on screen.
 */
function forEachRowUnit(
  tables: RenderedTables,
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
  visit: (rowKey: string, confidence: ConfidenceLike, added: boolean) => void,
): void {
  const confidenceOf = (row: unknown): ConfidenceLike => {
    const meta = (row as Record<string, unknown> | undefined)?.[ROW_META_KEY] as
      { confidence?: ConfidenceLike } | undefined;
    return meta?.confidence ?? null;
  };

  for (const table of tables) {
    // `tableRows` is the one derivation of "which rows does this table have" —
    // shared with TableSection and with the empty-columns rule, so none of the
    // three can drift about which row sits at which position. Only the KEY is
    // local: its two spellings (`entry.id` for a planned row, `unplannedRowKey`
    // otherwise) are this module's own addressing scheme, and pushing them into
    // row-cells.ts would make the shared derivation import a consumer.
    for (const ref of tableRows(table, planForTable(plannedTables, table.pointer))) {
      // `ref.row` is undefined exactly for a row the reviewer ADDED: it was
      // never extracted, so it has no confidence and is not in `table.rows` at
      // all. On an unplanned table every row is extracted, so this reads false
      // throughout, which is what it did before.
      const added = ref.row === undefined;
      const rowKey = ref.planned ? ref.planned.entry.id : unplannedRowKey(table.pointer, ref.position);
      visit(rowKey, confidenceOf(ref.row), added);
    }
  }
}

interface HiddenInput {
  classified: ClassifiedData;
  /** What the form renders — see RenderedTables. */
  tables: RenderedTables;
  /** Table pointer -> planned rows. Absent entry = unplanned table. */
  plannedTables: ReadonlyMap<string, PlannedRow[]>;
  /** Authoritative cell identities (editKey + rowKey). */
  cellViews: readonly CellView[];
  /** Pointer-keyed — `indexBindingsByFieldPointer`. */
  bindingIndex: ReadonlyMap<string, FieldBinding>;
  edits: ReadonlyMap<string, string>;
  pairErrors: ReadonlyMap<string, string>;
  /** Promoted-header pointers the form does not render. Skipped, because they
   *  are excluded from the unit count too — hiding one would make
   *  `visible = total − hidden` miscount. */
  suppressed: ReadonlySet<string>;
}

/** Fields and rows the filter may hide: high-confidence AND untouched AND
 *  error-free. */
export function computeHidden(input: HiddenInput): HiddenSets {
  const {
    classified, tables, plannedTables, cellViews, bindingIndex, edits, pairErrors, suppressed,
  } = input;

  const fields = new Set<string>();
  const rows = new Set<string>();

  // "Touched" is edits OR pairErrors: a pair error arrives with ZERO edits when
  // the extraction itself is half-filled, so edits alone would hide a field
  // that is already invalid.
  const touched = (editKey: string): boolean => edits.has(editKey) || pairErrors.has(editKey);

  // rowKey -> its cells' edit keys. One pass; the row walk below only looks up.
  const editKeysByRow = new Map<string, string[]>();
  for (const view of cellViews) {
    const list = editKeysByRow.get(view.rowKey);
    if (list) list.push(view.editKey);
    else editKeysByRow.set(view.rowKey, [view.editKey]);
  }

  forEachFieldUnit(classified, (pointer, confidence) => {
    if (suppressed.has(pointer) || !isHighConfidence(confidence)) return;
    // With no binding, nothing can resolve this field's edit key, so whether it
    // was touched is unknowable. Never hide what cannot be reasoned about.
    const editKey = bindingIndex.get(pointer)?.key.raw;
    if (editKey === undefined || touched(editKey)) return;
    fields.add(pointer);
  });

  forEachRowUnit(tables, plannedTables, (rowKey, confidence, added) => {
    if (added || !isHighConfidence(confidence)) return;
    if ((editKeysByRow.get(rowKey) ?? []).some(touched)) return;
    rows.add(rowKey);
  });

  if (fields.size === 0 && rows.size === 0) return NOTHING_HIDDEN;
  return { fields, rows };
}

/**
 * How many things the reviewer can act on — the denominator of "Showing X of Y".
 *
 * Walks the same two traversals `computeHidden` does, so the two cannot drift.
 * Suppressed (promoted) headers are excluded from both.
 *
 * Note this does NOT include `unmatched` bindings: they are review units too,
 * but they live outside `ClassifiedData` and the caller adds them.
 */
export function countUnits(
  classified: ClassifiedData,
  tables: RenderedTables,
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
  suppressed: ReadonlySet<string>,
): number {
  let total = 0;
  forEachFieldUnit(classified, (pointer) => {
    if (!suppressed.has(pointer)) total += 1;
  });
  forEachRowUnit(tables, plannedTables, () => {
    total += 1;
  });
  return total;
}

/**
 * True when any FIELD or ROW carries a confidence level — i.e. whether the
 * filter has anything at all to act on.
 *
 * Overall confidence is excluded deliberately: it renders as its own summary
 * line, is not a review unit and cannot be hidden, so offering a switch on its
 * account would give the reviewer a control that does nothing. Row confidence
 * alone qualifies, because an `invoice_line_items` extraction has no header
 * fields whatsoever and scores every row.
 */
export function hasAnyConfidence(
  classified: ClassifiedData,
  tables: RenderedTables,
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
): boolean {
  let found = false;
  forEachFieldUnit(classified, (_pointer, confidence) => {
    if (confidence?.level) found = true;
  });
  if (found) return true;
  forEachRowUnit(tables, plannedTables, (_rowKey, confidence) => {
    if (confidence?.level) found = true;
  });
  return found;
}
