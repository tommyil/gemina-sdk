/**
 * The review filter: which fields and rows the reviewer can hide because the
 * model already scored them `high`.
 *
 * Kept separate from the form so the rule is testable without rendering, and
 * so there is exactly ONE definition of "already reviewed" rather than one per
 * section component.
 *
 * Two design constraints run through this file, both learned the hard way:
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
 */

import { ROW_META_KEY } from './classify';
import type { ClassifiedData } from './classify';
import type { FieldBinding } from './bindings';
import type { CellView, PlannedRow } from './row-cells';

export type ConfidenceLike = { level: string; reasons: string[] } | null | undefined;

/** Only an explicit `high` hides. See the plan's §F7. */
export function isHighConfidence(confidence: ConfidenceLike): boolean {
  return (confidence?.level ?? '').toLowerCase() === 'high';
}

export interface HiddenSets {
  /** Field pointers (headers, list items, entity cells). */
  fields: ReadonlySet<string>;
  /** `${tablePointer}#${rowId}` — row ID, NOT position, so a hidden row stays
   *  hidden when a row above it is deleted. */
  rows: ReadonlySet<string>;
}

/** Shared empty result, so "nothing hidden" is always the same object and the
 *  section memos see no change. (A Set is mutable even under Object.freeze —
 *  the guarantee here is the readonly TYPE plus never mutating it, not the
 *  runtime.) */
export const NOTHING_HIDDEN: HiddenSets = {
  fields: new Set<string>(),
  rows: new Set<string>(),
};

/**
 * How a hidden row is addressed: by the SAME key `CellView.rowKey` uses, so
 * the two can never disagree.
 *
 * For a planned table that is `entry.id`, which `initialRowPlan` already
 * scopes with the table pointer (`/taxes#row-0`) — prefixing it again would
 * produce `/taxes#/taxes#row-0` and match nothing. For an unplanned table it
 * is the row pointer (`/taxes/0`), which is what `collectCellViews` derives
 * by splitting the cell pointer.
 */
export const unplannedRowKey = (tablePointer: string, index: number): string => `${tablePointer}/${index}`;

interface HiddenInput {
  classified: ClassifiedData;
  /** Table pointer -> planned rows. Absent entry = unplanned table. */
  plannedTables: ReadonlyMap<string, PlannedRow[]>;
  /** Authoritative cell identities (editKey + rowKey) — index.tsx:584. */
  cellViews: readonly CellView[];
  /** Pointer-keyed — `indexBindingsByFieldPointer`, index.tsx:427. */
  bindingIndex: ReadonlyMap<string, FieldBinding>;
  edits: ReadonlyMap<string, string>;
  pairErrors: ReadonlyMap<string, string>;
  /** Promoted-header pointers the form does not render. Skipped, because they
   *  are excluded from the unit count too — hiding one would make
   *  `visible = total − hidden` miscount. */
  suppressed: ReadonlySet<string>;
}

/** Fields and rows the filter may hide. Hide iff high-confidence AND untouched
 *  AND error-free (§F7). */
export function computeHidden(input: HiddenInput): HiddenSets {
  const { classified, plannedTables, cellViews, bindingIndex, edits, pairErrors, suppressed } = input;

  const fields = new Set<string>();
  const rows = new Set<string>();

  // An edit key is "touched" if the reviewer changed it OR it arrived broken.
  // pairErrors can be non-empty with zero edits, so edits alone is not enough.
  const touched = (editKey: string | undefined): boolean =>
    editKey !== undefined && (edits.has(editKey) || pairErrors.has(editKey));

  // rowKey -> its cells' edit keys. One pass; the row loops below only look up.
  const editKeysByRow = new Map<string, string[]>();
  for (const view of cellViews) {
    const list = editKeysByRow.get(view.rowKey);
    if (list) list.push(view.editKey);
    else editKeysByRow.set(view.rowKey, [view.editKey]);
  }

  const considerField = (pointer: string, confidence: ConfidenceLike): void => {
    if (suppressed.has(pointer)) return;
    if (!isHighConfidence(confidence)) return;
    // No binding means nothing can resolve this field's edit key, so we cannot
    // tell whether it was touched. Never hide what we cannot reason about.
    const editKey = bindingIndex.get(pointer)?.key.raw;
    if (editKey === undefined || touched(editKey)) return;
    fields.add(pointer);
  };

  for (const header of classified.headers) {
    considerField(header.pointer, header.confidence);
  }
  for (const list of classified.simpleLists) {
    for (const item of list.items) considerField(item.pointer, item.confidence);
  }
  for (const entity of classified.entities) {
    for (const item of entity.items) {
      for (const entityCell of Object.values(item)) considerField(entityCell.pointer, entityCell.confidence);
    }
  }

  const rowConfidence = (row: Record<string, unknown> | undefined): ConfidenceLike => {
    const meta = row?.[ROW_META_KEY] as { confidence?: ConfidenceLike } | undefined;
    return meta?.confidence ?? null;
  };

  const rowIsHidable = (rowKey: string): boolean =>
    !(editKeysByRow.get(rowKey) ?? []).some((editKey) => touched(editKey));

  for (const table of classified.tables) {
    const planned = plannedTables.get(table.pointer);
    if (planned) {
      for (const plannedRow of planned) {
        // An added row was never extracted, so it carries no confidence and
        // must always stay visible. It is not in table.rows at all.
        if (plannedRow.entry.source === null) continue;
        if (!isHighConfidence(rowConfidence(table.rows[plannedRow.entry.source] as Record<string, unknown>))) continue;
        if (!rowIsHidable(plannedRow.entry.id)) continue;
        rows.add(plannedRow.entry.id);
      }
      continue;
    }
    table.rows.forEach((row, index) => {
      if (!isHighConfidence(rowConfidence(row as Record<string, unknown>))) return;
      const key = unplannedRowKey(table.pointer, index);
      if (!rowIsHidable(key)) return;
      rows.add(key);
    });
  }

  if (fields.size === 0 && rows.size === 0) return NOTHING_HIDDEN;
  return { fields, rows };
}

/**
 * How many things the reviewer can act on.
 *
 * A "review unit" is one header field, one simple-list item, one entity-card
 * cell, or one TABLE ROW — a row counts once, not once per cell, because rows
 * hide whole or not at all.
 *
 * Suppressed (promoted) headers are excluded, so `total − hidden` stays honest:
 * `computeHidden` skips them too, and counting them in one place but not the
 * other is what makes "Showing 6 of 29" drift.
 */
export function countUnits(
  classified: ClassifiedData,
  plannedTables: ReadonlyMap<string, PlannedRow[]>,
  suppressed: ReadonlySet<string>,
): number {
  let total = 0;
  total += classified.headers.filter((header) => !suppressed.has(header.pointer)).length;
  for (const list of classified.simpleLists) {
    total += list.items.filter((item) => !suppressed.has(item.pointer)).length;
  }
  for (const entity of classified.entities) {
    for (const item of entity.items) {
      total += Object.values(item).filter((entityCell) => !suppressed.has(entityCell.pointer)).length;
    }
  }
  for (const table of classified.tables) {
    // The plan is the source of truth when there is one: it includes rows the
    // reviewer added and excludes ones they removed.
    total += plannedTables.get(table.pointer)?.length ?? table.rows.length;
  }
  return total;
}

/**
 * True when any FIELD or ROW carries a confidence level.
 *
 * Overall confidence is excluded deliberately: it is rendered as its own
 * summary line, is not a review unit, and cannot be hidden — counting it would
 * offer a switch that does nothing. Row confidence alone is enough, because an
 * `invoice_line_items` extraction has no header fields at all and scores
 * every row.
 */
export function hasAnyConfidence(classified: ClassifiedData): boolean {
  if (classified.headers.some((header) => header.confidence?.level)) return true;
  if (classified.simpleLists.some((list) => list.items.some((item) => item.confidence?.level))) return true;
  if (classified.entities.some((entity) => entity.items.some(
    (item) => Object.values(item).some((entityCell) => entityCell.confidence?.level),
  ))) return true;
  return classified.tables.some((table) => table.rows.some((row) => {
    const meta = (row as Record<string, unknown>)[ROW_META_KEY] as { confidence?: ConfidenceLike } | undefined;
    return Boolean(meta?.confidence?.level);
  }));
}
