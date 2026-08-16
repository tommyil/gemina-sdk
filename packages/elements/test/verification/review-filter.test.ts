import { describe, expect, it } from 'vitest';
import {
  computeHidden,
  hasAnyConfidence,
  isHighConfidence,
  NOTHING_HIDDEN,
} from '../../src/verification/review-filter';
import { ROW_META_KEY } from '../../src/verification/classify';
import type { ClassifiedData } from '../../src/verification/classify';
import type { CellView, PlannedRow } from '../../src/verification/row-cells';

const conf = (level: string | null) => (level ? { level, reasons: [] } : null);

describe('isHighConfidence', () => {
  it('is true only for an explicit high level', () => {
    expect(isHighConfidence(conf('high'))).toBe(true);
    expect(isHighConfidence(conf('HIGH'))).toBe(true);
  });

  // Unmeasured is not "reviewed and fine" — hiding it would drop it silently.
  it('is false for null, medium, low and anything unrecognised', () => {
    for (const level of [null, 'medium', 'low', 'certain', '']) {
      expect(isHighConfidence(conf(level))).toBe(false);
    }
  });

  it('is false for undefined', () => {
    expect(isHighConfidence(undefined)).toBe(false);
  });
});

// --- fixtures ---------------------------------------------------------------
// Shapes mirror what classifyData actually produces; values are synthetic.
// Note the row ids: `initialRowPlan` scopes them with the table pointer
// (row-plan.ts:43), so an extracted row's id is ALREADY `/taxes#row-0`.

const field = (key: string, level: string | null) => ({
  key,
  pointer: `/${key}`,
  value: 'x',
  coordinates: null,
  confidence: conf(level),
});

const cell = (pointer: string, level: string | null) => ({
  pointer,
  value: 'x',
  coordinates: null,
  confidence: conf(level),
});

const taxRow = (level: string | null) => ({
  rate: cell('/taxes/0/rate', null),
  ...(level ? { [ROW_META_KEY]: { pointer: '', value: null, coordinates: null, confidence: conf(level) } } : {}),
});

function classified(over: Partial<ClassifiedData> = {}): ClassifiedData {
  return {
    overallConfidence: null,
    headers: [],
    simpleLists: [],
    entities: [],
    tables: [],
    fallback: [],
    ...over,
  } as ClassifiedData;
}

const binding = (raw: string) => ({ key: { raw, label: raw } }) as any;

const cellView = (editKey: string, rowKey: string): CellView => ({ editKey, rowKey }) as CellView;

function run(over: {
  classified?: ClassifiedData;
  plannedTables?: ReadonlyMap<string, PlannedRow[]>;
  cellViews?: readonly CellView[];
  bindingIndex?: ReadonlyMap<string, any>;
  edits?: ReadonlyMap<string, string>;
  pairErrors?: ReadonlyMap<string, string>;
  suppressed?: ReadonlySet<string>;
} = {}) {
  return computeHidden({
    classified: over.classified ?? classified(),
    plannedTables: over.plannedTables ?? new Map(),
    cellViews: over.cellViews ?? [],
    bindingIndex: over.bindingIndex ?? new Map(),
    edits: over.edits ?? new Map(),
    pairErrors: over.pairErrors ?? new Map(),
    suppressed: over.suppressed ?? new Set(),
  });
}

// --- fields -----------------------------------------------------------------

describe('computeHidden — fields', () => {
  const headers = [field('a', 'high'), field('b', 'low'), field('c', null), field('d', 'medium')];
  const bindingIndex = new Map([
    ['/a', binding('/a')], ['/b', binding('/b')], ['/c', binding('/c')], ['/d', binding('/d')],
  ]);

  it('hides a high-confidence header, keeps low, medium and unscored', () => {
    const { fields } = run({ classified: classified({ headers }), bindingIndex });
    expect([...fields]).toEqual(['/a']);
  });

  it('keeps a high header the reviewer edited', () => {
    const { fields } = run({
      classified: classified({ headers }),
      bindingIndex,
      edits: new Map([['/a', 'typed']]),
    });
    expect(fields.size).toBe(0);
  });

  // §F6 — a pair error arrives with ZERO edits when the extraction itself is
  // half-filled, so "untouched" cannot mean "absent from edits".
  it('keeps a high header carrying an error and no edit', () => {
    const { fields } = run({
      classified: classified({ headers }),
      bindingIndex,
      pairErrors: new Map([['/a', 'needs a unit']]),
    });
    expect(fields.size).toBe(0);
  });

  it('never hides a field with no resolvable binding', () => {
    const { fields } = run({ classified: classified({ headers }), bindingIndex: new Map() });
    expect(fields.size).toBe(0);
  });

  // Rev 2.1a — suppressed headers are excluded from totalUnits, so hiding one
  // would make `visible = total − hidden` miscount.
  it('skips suppressed pointers entirely', () => {
    const { fields } = run({
      classified: classified({ headers }),
      bindingIndex,
      suppressed: new Set(['/a']),
    });
    expect(fields.size).toBe(0);
  });

  it('hides high-confidence simple-list items and entity cells', () => {
    const data = classified({
      simpleLists: [{ key: 'tags', pointer: '/tags', items: [cell('/tags/0', 'high'), cell('/tags/1', 'low')] }],
      entities: [{ key: 'parties', pointer: '/parties', items: [{ name: cell('/parties/0/name', 'high') }] }],
    });
    const { fields } = run({
      classified: data,
      bindingIndex: new Map([
        ['/tags/0', binding('/tags/0')],
        ['/tags/1', binding('/tags/1')],
        ['/parties/0/name', binding('/parties/0/name')],
      ]),
    });
    expect([...fields].sort()).toEqual(['/parties/0/name', '/tags/0']);
  });
});

// --- rows -------------------------------------------------------------------

describe('computeHidden — rows', () => {
  const table = {
    key: 'taxes', pointer: '/taxes', columns: ['rate'], overallConfidence: null,
    rows: [taxRow('high'), taxRow('low')],
  };
  const data = classified({ tables: [table] as any });

  // Extracted row ids are ALREADY table-scoped by initialRowPlan.
  const planned: PlannedRow[] = [
    { entry: { id: '/taxes#row-0', source: 0 }, cells: [] } as any,
    { entry: { id: '/taxes#row-1', source: 1 }, cells: [] } as any,
  ];
  const plannedTables = new Map([['/taxes', planned]]);
  const views = [
    cellView('cell:/taxes#row-0|col:rate', '/taxes#row-0'),
    cellView('cell:/taxes#row-1|col:rate', '/taxes#row-1'),
  ];

  it('hides the high row and keeps the low one', () => {
    const { rows } = run({ classified: data, plannedTables, cellViews: views });
    expect([...rows]).toEqual(['/taxes#row-0']);
  });

  it('keeps a high row when ANY of its cells was edited', () => {
    const { rows } = run({
      classified: data, plannedTables, cellViews: views,
      edits: new Map([['cell:/taxes#row-0|col:rate', '19']]),
    });
    expect(rows.size).toBe(0);
  });

  // §F6 again, at row level.
  it('keeps a high row carrying a pair error and no edit', () => {
    const { rows } = run({
      classified: data, plannedTables, cellViews: views,
      pairErrors: new Map([['cell:/taxes#row-0|col:rate', 'needs a unit']]),
    });
    expect(rows.size).toBe(0);
  });

  // §R2 — the bug that would have hidden the reviewer's own new row. An added
  // row is not in table.rows at all, so a filter over table.rows misses it.
  it('never hides an added row, even when every extracted row is high', () => {
    const allHigh = { ...table, rows: [taxRow('high')] };
    const withAdded: PlannedRow[] = [
      { entry: { id: '/taxes#row-0', source: 0 }, cells: [] } as any,
      { entry: { id: '/taxes#added-1', source: null }, cells: [] } as any,
    ];
    const { rows } = run({
      classified: classified({ tables: [allHigh] as any }),
      plannedTables: new Map([['/taxes', withAdded]]),
      cellViews: [cellView('cell:/taxes#row-0|col:rate', '/taxes#row-0')],
    });
    expect([...rows]).toEqual(['/taxes#row-0']);
  });

  // With no plan the form renders table.rows directly, and CellView.rowKey is
  // the row POINTER rather than a plan id.
  it('falls back to the row pointer for a table with no plan', () => {
    const { rows } = run({
      classified: data,
      cellViews: [cellView('/taxes/0/rate', '/taxes/0')],
    });
    expect([...rows]).toEqual(['/taxes/0']);
  });

  it('returns the shared empty result when nothing is hidden', () => {
    const result = run();
    expect(result.fields).toBe(NOTHING_HIDDEN.fields);
    expect(result.rows).toBe(NOTHING_HIDDEN.rows);
  });
});

// --- hasAnyConfidence -------------------------------------------------------

describe('hasAnyConfidence', () => {
  it('is true when a header is scored', () => {
    expect(hasAnyConfidence(classified({ headers: [field('a', 'high')] }))).toBe(true);
  });

  // §F12 — invoice_line_items extractions have NO headers and a null overall
  // confidence; every score is row-level. A rows-only extraction must still
  // offer the switch.
  it('is true for a rows-only extraction', () => {
    const table = { key: 'lineItems', pointer: '/line_items', columns: [], overallConfidence: null, rows: [taxRow('high')] };
    expect(hasAnyConfidence(classified({ tables: [table] as any }))).toBe(true);
  });

  // §F10 — overall confidence is not a review unit and cannot be hidden, so
  // counting it would offer a switch that does nothing.
  it('is FALSE when only overall confidence is present', () => {
    const table = { key: 'taxes', pointer: '/taxes', columns: [], overallConfidence: conf('high'), rows: [taxRow(null)] };
    expect(hasAnyConfidence(classified({ overallConfidence: conf('high'), tables: [table] as any }))).toBe(false);
  });

  it('is false for an unscored extraction', () => {
    expect(hasAnyConfidence(classified({ headers: [field('a', null)] }))).toBe(false);
  });
});
