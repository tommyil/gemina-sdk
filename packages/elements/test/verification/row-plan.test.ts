/**
 * The row plan: which submitted row came from which extracted row.
 *
 * This is the client half of the `rowSources` contract. The backend aligns the
 * submitted table to the extracted one using it, which is what makes an
 * inserted row score `missing` and a deleted one score `extra` WITHOUT
 * cascading a correction onto every row below. Encoding the same information
 * as insert/delete ops was rejected upstream: two inserts before the same
 * index produce two identical ops whose reconstruction depends on unstated
 * ordering rules.
 *
 * Row IDENTITY is the other half. Edits are keyed by row id, not by position,
 * so a correction typed into the third row stays with that row after the first
 * one is deleted. Keying by position instead would silently move a reviewer's
 * correction onto a different line item — a data-corruption bug with no
 * visible symptom.
 */

import { describe, expect, it } from 'vitest';
import {
  cellEditKey,
  initialRowPlan,
  insertRowAfter,
  isIdentityPlan,
  nextAddedRowId,
  removeRow,
  rowSourcesOf,
} from '../../src/verification/row-plan';

describe('initialRowPlan', () => {
  it('starts as the identity mapping over the extracted rows', () => {
    expect(initialRowPlan(3).map((r) => r.source)).toEqual([0, 1, 2]);
  });

  it('is empty for an extraction that found no rows', () => {
    expect(initialRowPlan(0)).toEqual([]);
  });

  it('gives every row a distinct id', () => {
    const ids = initialRowPlan(3).map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('removeRow', () => {
  it('re-indexes rows below a removal', () => {
    const plan = removeRow(initialRowPlan(3), 1);
    expect(plan.map((r) => r.source)).toEqual([0, 2]);
  });

  it('gives every row a stable id that survives re-indexing', () => {
    // The whole point: edits follow the row, not the position.
    const plan = initialRowPlan(3);
    const after = removeRow(plan, 0);
    expect(after[0]!.id).toBe(plan[1]!.id);
  });

  it('is a no-op for a position that does not exist', () => {
    const plan = initialRowPlan(2);
    expect(removeRow(plan, 5).map((r) => r.source)).toEqual([0, 1]);
    expect(removeRow(plan, -1).map((r) => r.source)).toEqual([0, 1]);
  });

  it('can empty the table entirely', () => {
    let plan = initialRowPlan(2);
    plan = removeRow(plan, 0);
    plan = removeRow(plan, 0);
    expect(plan).toEqual([]);
  });
});

describe('insertRowAfter', () => {
  it('inserts a user-added row with no source', () => {
    const plan = insertRowAfter(initialRowPlan(2), 0);
    expect(plan.map((r) => r.source)).toEqual([0, null, 1]);
  });

  it('appends when told to insert after the last row', () => {
    const plan = insertRowAfter(initialRowPlan(2), 1);
    expect(plan.map((r) => r.source)).toEqual([0, 1, null]);
  });

  it('appends to an empty table — the zero-row case', () => {
    const plan = insertRowAfter([], -1);
    expect(plan.map((r) => r.source)).toEqual([null]);
  });

  it('gives the added row an id distinct from every existing one', () => {
    const plan = insertRowAfter(initialRowPlan(2), 0);
    expect(new Set(plan.map((r) => r.id)).size).toBe(3);
  });

  it('keeps existing rows identical', () => {
    const before = initialRowPlan(2);
    const after = insertRowAfter(before, 0);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[2]!.id).toBe(before[1]!.id);
  });
});

describe('cellEditKey', () => {
  it('follows a row when rows above it are removed', () => {
    let plan = initialRowPlan(3);
    const edits = new Map([[cellEditKey(plan[2]!.id, 'description'), 'Widget C']]);
    plan = removeRow(plan, 0);
    // Row 2 sits at position 1 now; its edit must still be found.
    expect(edits.get(cellEditKey(plan[1]!.id, 'description'))).toBe('Widget C');
  });

  it('distinguishes columns within a row and rows within a column', () => {
    const plan = initialRowPlan(2);
    const keys = [
      cellEditKey(plan[0]!.id, 'description'),
      cellEditKey(plan[0]!.id, 'quantity'),
      cellEditKey(plan[1]!.id, 'description'),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('cannot collide with a raw schema key', () => {
    // Header edits stay keyed by their raw schema key in the SAME map, so the
    // two namespaces must not overlap.
    expect(cellEditKey('r1', 'description')).not.toMatch(/^label:/);
  });
});

describe('rowSourcesOf', () => {
  it('is the plan\'s sources in submitted order', () => {
    const plan = insertRowAfter(initialRowPlan(2), 0);
    expect(rowSourcesOf(plan)).toEqual([0, null, 1]);
  });

  it('omits a removed original entirely — deletions are carried by absence', () => {
    const plan = removeRow(initialRowPlan(3), 1);
    expect(rowSourcesOf(plan)).toEqual([0, 2]);
  });

  it('survives a compound edit losslessly', () => {
    // [A, B, C] -> delete B, then add two rows between A and C.
    let plan = initialRowPlan(3);
    plan = removeRow(plan, 1);
    plan = insertRowAfter(plan, 0);
    plan = insertRowAfter(plan, 1);
    expect(rowSourcesOf(plan)).toEqual([0, null, null, 2]);
  });

  it('stays strictly increasing, as the server requires', () => {
    // RowSourcesModel rejects out-of-order or duplicate sources outright.
    let plan = initialRowPlan(4);
    plan = removeRow(plan, 2);
    plan = insertRowAfter(plan, 0);
    const present = rowSourcesOf(plan).filter((s): s is number => s !== null);
    expect(present).toEqual([...present].sort((a, b) => a - b));
    expect(new Set(present).size).toBe(present.length);
  });
});

describe('isIdentityPlan', () => {
  it('is true for an untouched plan — the un-edited payload must not change', () => {
    expect(isIdentityPlan(initialRowPlan(3), 3)).toBe(true);
    expect(isIdentityPlan([], 0)).toBe(true);
  });

  it('is false after a removal or an insertion', () => {
    expect(isIdentityPlan(removeRow(initialRowPlan(3), 1), 3)).toBe(false);
    expect(isIdentityPlan(insertRowAfter(initialRowPlan(2), 0), 2)).toBe(false);
  });

  it('is false when rows were removed from the end', () => {
    // sources [0, 1] over 3 extracted rows is NOT the identity: row 2 is gone.
    expect(isIdentityPlan(removeRow(initialRowPlan(3), 2), 3)).toBe(false);
  });
});

describe('table scoping', () => {
  it('gives two tables distinct row ids, so their edits cannot collide', () => {
    // `rowMutableTables` is a LIST. Unscoped ids would give both tables `row-0`,
    // and since every table shares one edits map, typing into one table's first
    // row would silently rewrite the other's.
    const a = initialRowPlan(2, '/line_items');
    const b = initialRowPlan(2, '/charges');
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(cellEditKey(a[0]!.id, 'description'))
      .not.toBe(cellEditKey(b[0]!.id, 'description'));
  });

  it('scopes added rows too', () => {
    const a = insertRowAfter(initialRowPlan(1, '/a'), 0, nextAddedRowId('/a'));
    const b = insertRowAfter(initialRowPlan(1, '/b'), 0, nextAddedRowId('/b'));
    expect(a[1]!.id).not.toBe(b[1]!.id);
  });

  it('accepts a caller-minted id, so the state updater can stay pure', () => {
    // React invokes updaters twice under Strict Mode; minting inside one makes
    // the id depend on how many times React chose to call it.
    const plan = insertRowAfter(initialRowPlan(1, '/t'), 0, '/t#added-fixed');
    expect(plan[1]!.id).toBe('/t#added-fixed');
  });
});
