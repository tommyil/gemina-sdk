/**
 * The row plan — which submitted row came from which extracted row.
 *
 * Pure, no React. This is the client half of the backend's `rowSources`
 * contract: the server aligns the submitted table to the extracted one using
 * it, which is what lets an inserted row score `missing` and a deleted one
 * score `extra` WITHOUT cascading a correction onto every row below.
 *
 * Encoding the same information as insert/delete OPS was rejected: two inserts
 * before the same index produce two identical ops whose reconstruction depends
 * on unstated ordering rules. The plan is unambiguous by construction — it IS
 * the alignment, not a recipe for reproducing one.
 *
 * Row IDENTITY is the other half of the job. Edits are keyed by row id rather
 * than by position, so a correction typed into the third row stays with that
 * row after the first is deleted. Keying by position would silently move a
 * reviewer's correction onto a different line item: wrong data, no symptom.
 */

export interface RowPlanEntry {
  /** Stable for the lifetime of the plan. Edits are keyed by this. */
  id: string;
  /** Index in the EXTRACTED table, or null for a row the reviewer added. */
  source: number | null;
}

/**
 * Ids for added rows. A counter rather than a random id so a render is
 * reproducible and a test can reason about it; uniqueness is all that is
 * required of it, and it never leaves the client.
 */
let addedRowCounter = 0;

/** The identity mapping: every extracted row, in order, unmoved. */
export function initialRowPlan(extractedCount: number): RowPlanEntry[] {
  return Array.from({ length: Math.max(0, extractedCount) }, (_unused, index) => ({
    // Derived from the source index, so it is stable across re-renders without
    // any state to carry — an extracted row's identity never changes.
    id: `row-${index}`,
    source: index,
  }));
}

/** Drop the row at `position`. Out-of-range is a no-op, not a throw. */
export function removeRow(plan: RowPlanEntry[], position: number): RowPlanEntry[] {
  if (position < 0 || position >= plan.length) {
    return plan;
  }
  return plan.filter((_entry, index) => index !== position);
}

/**
 * Insert a blank user-added row after `position`.
 *
 * `-1` prepends, which is also how the zero-row table gets its first line.
 */
export function insertRowAfter(plan: RowPlanEntry[], position: number): RowPlanEntry[] {
  addedRowCounter += 1;
  const added: RowPlanEntry = { id: `added-${addedRowCounter}`, source: null };
  const at = Math.min(Math.max(position + 1, 0), plan.length);
  return [...plan.slice(0, at), added, ...plan.slice(at)];
}

/**
 * The edit-map key for one table cell.
 *
 * Table cells and header fields share ONE edits map, so this namespace must
 * not collide with a raw schema key — hence the prefix, and hence the test
 * asserting it never looks like `label:…`.
 */
export function cellEditKey(rowId: string, column: string): string {
  return `cell:${rowId}|col:${column}`;
}

/** The `sources` array for the wire, in submitted order. */
export function rowSourcesOf(plan: RowPlanEntry[]): Array<number | null> {
  return plan.map((entry) => entry.source);
}

/**
 * True when the reviewer has neither added nor removed a row.
 *
 * The wire payload for an untouched row set must be byte-identical to what it
 * was before this feature existed, so `composeSubmission` omits the table's
 * `rowSources` entry entirely in that case. Comparing against
 * `extractedCount` is what catches rows removed from the END, whose remaining
 * sources still read 0..n-1.
 */
export function isIdentityPlan(plan: RowPlanEntry[], extractedCount: number): boolean {
  return plan.length === extractedCount
    && plan.every((entry, index) => entry.source === index);
}
