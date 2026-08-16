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

/** How a hidden row is addressed. Row ID, never position. */
export const hiddenRowKey = (tablePointer: string, rowId: string): string => `${tablePointer}#${rowId}`;
