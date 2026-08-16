/**
 * SYNTHETIC fixture for the "Hide empty columns" feature (plan Task 0).
 *
 * Derived from the SHAPE of real `invoice_line_items` / `invoice_headers`
 * extractions read live on 2026-08-16 through the DI primary view. Every
 * value here is invented — no real vendor, address, item or amount appears,
 * per the plan's F10. Only the structure is real.
 *
 * What the observation established, and what this fixture therefore encodes:
 *
 * 1. WIDE DECLARED TABLE, MOSTLY BLANK. `rowMutableTables[0].columns` for
 *    `/line_items` declares 19 columns on every extraction, regardless of how
 *    many the document actually filled. Across 29 real line-item tables, the
 *    populated count ranged 3..14 of 19 — EVERY ONE had at least one column
 *    blank in every row, and the biggest tables (169 rows) had 11 of 19 blank.
 *    This fixture reproduces that exact 8-populated / 11-blank split.
 *
 * 2. BLANK IS BARE `null`. Not `''`, not a missing key, not `{ value: null }`.
 *    All 11,870 blank cells observed were literal JSON `null`, and the key was
 *    always present on the row. Populated cells are bare scalars — there is no
 *    `{ value, coordinates, confidence }` wrapper on table cells even when the
 *    extraction ran with `includeCoordinates` on.
 *
 * 3. A POPULATED COLUMN STILL CARRIES NULLS. 276 of the observed nulls sat in
 *    columns that were populated elsewhere — `discountPercentage` below is
 *    that case, and it must NOT be hidden.
 *
 * 4. CASING. The payload's table key matched the declared pointer exactly
 *    (`/line_items` on both sides) in all 35 observed tables — but the COLUMN
 *    names do not: declared `unit_of_measure` vs payload `unitOfMeasure`. That
 *    is the mismatch `displayColumns` / `resolveCasingAware` exist for, and it
 *    is live in every real extraction. `camelTablePointer: true` additionally
 *    swaps the payload key to `/lineItems` for the F3 pointer-mismatch test —
 *    that variant was NOT observed and is deliberately synthetic.
 *
 * 5. NO UNBOUND CELL WAS OBSERVED (F4). `validationSchema` enumerated exactly
 *    rows x declared-columns entries, so every rendered cell had a binding.
 *    `unboundColumn: true` synthesises the F4 case by adding a payload column
 *    the schema does not cover.
 *
 *    CAUTION — that option does NOT produce an unbound rendered cell on a
 *    row-mutable table. `planTableCells` mints a SYNTHETIC binding
 *    (`extracted: NOT_FOUND`) for every planned column the schema misses, so
 *    the cell renders as an empty editable input and its payload value never
 *    paints. It is therefore genuinely blank on screen, and a rule that walks
 *    what renders must hide it. F4's real failure mode — a POPULATED column
 *    with no binding behind it — only exists on a table with no
 *    `rowMutableTables` declaration at all, which is what `unboundTable: true`
 *    below adds.
 *
 * 6. NO CONFIDENCE. Every extraction reachable locally has `evaluation` off,
 *    so `confidence` is null on every row and cell — as it is here. Tests that
 *    need scores should add them explicitly; emptiness does not depend on them.
 */

/** The 19 columns the server declares for `/line_items`, in server order. */
export const LINE_ITEM_COLUMNS = [
  'line_number',
  'description',
  'item_code',
  'barcode',
  'quantity',
  'unit_of_measure',
  'unit_size',
  'unit_size_uom',
  'list_price',
  'unit_price',
  'discount_amount',
  'discount_percentage',
  'tax_amount',
  'tax_rate',
  'packaging_amount',
  'deposit_amount',
  'units_per_package',
  'package_quantity',
  'line_total',
] as const;

/** The 11 of those 19 that are blank in every row of this fixture. */
export const BLANK_LINE_ITEM_COLUMNS = [
  'barcode',
  'unit_size',
  'unit_size_uom',
  'list_price',
  'discount_amount',
  'tax_amount',
  'tax_rate',
  'packaging_amount',
  'deposit_amount',
  'units_per_package',
  'package_quantity',
] as const;

/**
 * `unit_size` + `unit_size_uom` are blank TOGETHER in 23 of the 29 observed
 * tables. They are the pair the unit-pair error is computed over, so they are
 * the fixture's handle on the "populated half, blank half" trap in §S.
 */
export const UNIT_PAIR_COLUMNS = ['unit_size', 'unit_size_uom'] as const;

/** The 5 columns the server declares for `/taxes` on invoice_headers. */
export const TAXES_COLUMNS = ['type', 'name', 'rate', 'amount', 'base'] as const;

/** `base` was blank on 5 of the 6 observed taxes tables. */
export const BLANK_TAXES_COLUMNS = ['base'] as const;

/**
 * A table the server neither declares as row-mutable nor covers in the
 * validation schema — so every one of its rendered cells resolves to NO
 * binding and paints straight from the classified value (F4).
 *
 * Synthetic: no such table was observed. It exists because F4's reasoning
 * about schema coverage stands on its own, and because it is the ONLY shape in
 * which an unbound cell can be populated — on a row-mutable table the planner
 * substitutes a NOT_FOUND binding instead (see note 5 above).
 */
export const CHARGES_COLUMNS = ['chargeType', 'chargeCode', 'chargeAmount', 'chargeNote'] as const;

/** The 2 of those 4 that are blank in every charges row. */
export const BLANK_CHARGES_COLUMNS = ['chargeCode', 'chargeNote'] as const;

/** Two invented charge rows. Four keys, because `isTableArray` needs >3. */
const CHARGE_ROWS: ReadonlyArray<Record<string, unknown>> = [
  { chargeType: 'Freight', chargeCode: null, chargeAmount: 12.5, chargeNote: null },
  { chargeType: 'Handling', chargeCode: null, chargeAmount: 3.25, chargeNote: null },
];

const LINE_ITEM_TYPES: Record<string, string> = {
  line_number: 'integer',
  description: 'string',
  item_code: 'string',
  barcode: 'string',
  quantity: 'number',
  unit_of_measure: 'string',
  unit_size: 'number',
  unit_size_uom: 'string',
  list_price: 'number',
  unit_price: 'number',
  discount_amount: 'number',
  discount_percentage: 'number',
  tax_amount: 'number',
  tax_rate: 'number',
  packaging_amount: 'number',
  deposit_amount: 'number',
  units_per_package: 'integer',
  package_quantity: 'number',
  line_total: 'number',
};

/** The closed roster the real `unit_of_measure` descriptor publishes. */
const UOM_ENUM = ['UNIT', 'BOX', 'CARTON', 'PACK', 'KG', 'L', 'M'];

const camel = (name: string): string =>
  name.replace(/_([a-zA-Z0-9])/g, (_unused, ch: string) => ch.toUpperCase());

/** A wire-shaped column descriptor: keyed `name`, as the DTO serialises it. */
const wireColumn = (name: string) => ({
  name,
  type: LINE_ITEM_TYPES[name] ?? 'string',
  enum: name === 'unit_of_measure' ? UOM_ENUM : null,
  format: null,
  description: `Synthetic descriptor for ${name}`,
});

/**
 * Four invented line-item rows. Populated: line_number, description,
 * item_code, quantity, unit_of_measure, unit_price, line_total — plus
 * discount_percentage on ONE row only (case 3 above). Everything else null.
 */
const LINE_ITEM_ROWS: ReadonlyArray<Record<string, unknown>> = [
  {
    lineNumber: 1,
    description: 'Widget housing, matte',
    itemCode: 'WH-2201',
    quantity: 12,
    unitOfMeasure: 'UNIT',
    unitPrice: 4.5,
    discountPercentage: null,
    lineTotal: 54,
  },
  {
    lineNumber: 2,
    description: 'Bracket set, steel',
    itemCode: 'BR-0088',
    quantity: 3,
    unitOfMeasure: 'BOX',
    unitPrice: 21,
    discountPercentage: 10,
    lineTotal: 56.7,
  },
  {
    lineNumber: 3,
    description: 'Cable, 2m',
    itemCode: 'CB-1140',
    quantity: 25,
    unitOfMeasure: 'UNIT',
    unitPrice: 1.2,
    discountPercentage: null,
    lineTotal: 30,
  },
  {
    lineNumber: 4,
    description: 'Assembly labour',
    itemCode: 'SVC-LAB',
    quantity: 2,
    unitOfMeasure: 'UNIT',
    unitPrice: 60,
    discountPercentage: null,
    lineTotal: 120,
  },
];

/** One invented tax row; `base` is the blank column. */
const TAX_ROW: Record<string, unknown> = {
  type: 'VAT',
  name: 'Standard rate',
  rate: 17,
  amount: 44.03,
  base: null,
};

export interface WideTableFixtureOptions {
  /**
   * How many of the four rows to include (default 4; 0 exercises F9).
   * The zero-row form is OBSERVED: a real extraction with no line items
   * carries `line_items: []` — the key is present with an empty array, not
   * omitted — while `rowMutableTables` still declares all 19 columns.
   */
  rows?: number;
  /** Payload key becomes `lineItems` while the declaration stays `/line_items` (F3). */
  camelTablePointer?: boolean;
  /**
   * Add a payload-only column the validationSchema does not cover (F4).
   * ALWAYS populated: on a row-mutable table the planner mints a NOT_FOUND
   * binding either way, so a blank variant of this option could distinguish
   * nothing (see the caution above).
   */
  unboundColumn?: boolean;
  /** Include the `/taxes` table beside `/line_items` (default false). */
  withTaxes?: boolean;
  /**
   * Add `/charges`: a table with NO row-mutable declaration and NO schema
   * coverage, so every cell renders unbound (F4). Two of its four columns are
   * blank in every row, two are populated in every row.
   */
  unboundTable?: boolean;
  /** Blank EVERY line-item column — the §D4 case, never observed in the wild. */
  allColumnsBlank?: boolean;
}

/** Fill every declared column, blanks as bare `null`, keys camelised. */
function buildRow(
  source: Record<string, unknown>,
  options: WideTableFixtureOptions,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of LINE_ITEM_COLUMNS) {
    const key = camel(column);
    row[key] = options.allColumnsBlank ? null : (source[key] ?? null);
  }
  if (options.unboundColumn) {
    // Payload-only: no declared column, so no validationSchema entry and no
    // binding — the cell renders through TableRowView's `classified` branch.
    row.grossLinePrice = 9.99;
  }
  // Row-level meta as the wire carries it with `evaluation` off.
  row.confidence = null;
  row.confidence_reasons = [];
  return row;
}

/** `label:line_{index}_{field}|ptr:/line_items/{index}/{field}`, expanded. */
function lineItemSchema(rowCount: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    for (const column of LINE_ITEM_COLUMNS) {
      out.push(`label:line_${index}_${column}|ptr:/line_items/${index}/${column}`);
    }
  }
  return out;
}

function taxSchema(): string[] {
  return TAXES_COLUMNS.map(
    (column) => `label:tax_0_${column}|ptr:/taxes/0/${column}`,
  );
}

/**
 * An `ExtractionPrimaryViewOutDTO`-shaped payload with a wide, mostly-blank
 * line-items table — the WIRE shape, columns keyed `name`, values camelCase
 * and unwrapped. Feed this to the component-level tests the way
 * `helpers.ts`'s `extraction()` is fed.
 */
export function wideTableExtraction(
  options: WideTableFixtureOptions = {},
): Record<string, unknown> {
  const rowCount = options.rows ?? LINE_ITEM_ROWS.length;
  const rows = LINE_ITEM_ROWS.slice(0, rowCount).map((source) => buildRow(source, options));
  const tableKey = options.camelTablePointer ? 'lineItems' : 'line_items';

  const rowMutableTables: Array<Record<string, unknown>> = [
    {
      pointer: '/line_items',
      keyTemplate: 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}',
      columns: LINE_ITEM_COLUMNS.map(wireColumn),
    },
  ];
  const validationSchema = [
    'label:supplier_name|ptr:/supplier_name',
    'label:invoice_total|ptr:/invoice_total',
    ...lineItemSchema(rowCount),
  ];

  const values: Record<string, unknown> = {
    supplierName: 'Northwind Trading Ltd',
    invoiceTotal: 260.7,
    [tableKey]: rows,
    total_lines: rowCount,
    overall_confidence: null,
    confidence_reasons: [],
  };

  if (options.withTaxes) {
    rowMutableTables.push({
      pointer: '/taxes',
      keyTemplate: 'label:tax_{index}_{field}|ptr:/taxes/{index}/{field}',
      columns: TAXES_COLUMNS.map((name) => ({
        name,
        type: name === 'rate' || name === 'amount' || name === 'base' ? 'number' : 'string',
        enum: null,
        format: null,
        description: `Synthetic descriptor for ${name}`,
      })),
    });
    validationSchema.push(...taxSchema());
    values.taxes = [{ ...TAX_ROW, confidence: null, confidence_reasons: [] }];
  }

  if (options.unboundTable) {
    // Deliberately absent from BOTH `rowMutableTables` and `validationSchema`:
    // that absence is the whole point — it is what leaves the rendered cells
    // with no binding to read `extracted` from.
    values.charges = CHARGE_ROWS.map((row) => ({ ...row }));
  }

  return {
    status: 'success',
    createdAt: '2026-08-16T09:00:00Z',
    document: {
      documentId: 'doc-empty-columns',
      imageUrl: 'https://cdn.example.test/doc-empty-columns.png',
    },
    meta: {
      processingStatus: 'success',
      extractionType: 'invoice_line_items',
      validated: false,
      purgedAt: null,
      evaluation: false,
      includeCoordinates: false,
      validationFeedback: {
        validationSchema,
        validationFields: [],
        rowMutableTables,
      },
    },
    values,
  };
}

/**
 * The same declaration in the CLIENT type's spelling — `columns[].key`, as
 * `readRowMutableTables` normalises the wire's `name`. Use this for the unit
 * tests of `computeEmptyColumns` / `tableColumns`, which take
 * `RowMutableTable[]` rather than a DTO.
 */
export function wideTableRowMutableTables(withTaxes = false): Array<{
  pointer: string;
  keyTemplate: string;
  columns: Array<{ key: string; type: string; enum: string[] | null }>;
}> {
  const tables: Array<{
    pointer: string;
    keyTemplate: string;
    columns: Array<{ key: string; type: string; enum: string[] | null }>;
  }> = [
    {
      pointer: '/line_items',
      keyTemplate: 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}',
      columns: LINE_ITEM_COLUMNS.map((key) => ({
        key: key as string,
        type: LINE_ITEM_TYPES[key] ?? 'string',
        enum: key === 'unit_of_measure' ? UOM_ENUM : null,
      })),
    },
  ];
  if (withTaxes) {
    tables.push({
      pointer: '/taxes',
      keyTemplate: 'label:tax_{index}_{field}|ptr:/taxes/{index}/{field}',
      columns: TAXES_COLUMNS.map((key) => ({
        key: key as string,
        type: key === 'type' || key === 'name' ? 'string' : 'number',
        enum: null,
      })),
    });
  }
  return tables;
}

/** The classified-table shape (payload spelling, camel keys) for row-level unit tests. */
export function wideTableClassifiedColumns(): string[] {
  return LINE_ITEM_COLUMNS.map(camel);
}
