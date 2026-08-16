/**
 * <GeminaVerification> — Task 16: edit state + progress summary.
 *
 * Separate file from verification-load.test.tsx because that file is already
 * ~740 lines, and because the render-count probe below needs a jsx-runtime
 * mock — which is per-FILE, so every test in whichever file declares it runs
 * under it. That is a reason to keep it off the load tests, which do not need
 * it; it is not a rule that only one file may have it. form.test.tsx declares
 * the same probe (the wrapping is shared — row-render-probe.ts) because the
 * visible-column array this comparator reads is memoized there, and a bail-out
 * is invisible in the DOM wherever you assert it from.
 *
 * Contracts pinned here:
 * - The progress line renders composeSubmission's counts VERBATIM — the tests
 *   compute the expected numbers through composeSubmission itself, so the UI
 *   can never drift from the submission semantics.
 * - Dirty tracking (Task 4 contract): the edits-map entry is DELETED when the
 *   input returns to `toInputString(binding.extracted)` — including clearing
 *   a never-extracted fill-in back to ''.
 * - Edits survive unrelated re-renders (theme flip) but RESET on extraction
 *   change (no cross-extraction bleed).
 * - Render probe (Task 13 review): one keystroke into a table cell re-renders
 *   ONLY that row — counted via a jsx-runtime passthrough that tallies
 *   clickable <tr> creations (exactly one per TableRowView render; the thead
 *   row carries no onClick).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { buildBindings, composeSubmission } from '../../src/verification/bindings';
import { UNIT_PAIR_MESSAGE } from '../../src/verification/row-cells';
import { extraction } from './helpers';
import { wideTableExtraction } from './empty-columns.fixture';

const { getDocumentExtraction, validateDocumentExtraction, withSessionToken } = vi.hoisted(() => {
  const getDocumentExtraction = vi.fn();
  const validateDocumentExtraction = vi.fn();
  const withSessionToken = vi.fn((_t: string, _b?: string) => ({
    documents: { getDocumentExtraction, validateDocumentExtraction },
  }));
  return { getDocumentExtraction, validateDocumentExtraction, withSessionToken };
});

vi.mock('@gemina/sdk', () => ({ GeminaClient: { withSessionToken } }));

/**
 * TableRowView render probe — what it counts and why it is not a DOM
 * assertion is recorded once, in row-render-probe.ts. The counter is this
 * file's own (hoisted, reset in `afterEach`); only the wrapping is shared.
 */
const probe = vi.hoisted(() => ({ rowRenders: 0 }));

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const { wrapJsxRuntime } = await import('./row-render-probe');
  return wrapJsxRuntime(await importOriginal<Record<string, (...args: unknown[]) => unknown>>(), probe);
});

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const { wrapJsxDevRuntime } = await import('./row-render-probe');
  return wrapJsxDevRuntime(await importOriginal<Record<string, (...args: unknown[]) => unknown>>(), probe);
});

function makeManager() {
  let n = 0;
  const fetchToken = vi.fn(async () => ({
    token: `eyJhbGciOiJIUzI1NiJ9.payload${++n}.signature`,
    expiresIn: 900,
  }));
  return { tokenManager: new GeminaTokenManager({ fetchToken }), fetchToken };
}

function renderVerification(extraProps: Partial<Parameters<typeof GeminaVerification>[0]> = {}) {
  const { tokenManager, fetchToken } = makeManager();
  const utils = render(
    <GeminaVerification extractionId="ext-1" tokenManager={tokenManager} {...extraProps} />,
  );
  return { ...utils, tokenManager, fetchToken };
}

/** The fixture's bindings, built the exact way the component builds them. */
function fixtureBindings(view = extraction()) {
  const meta = view.meta as { validationFeedback: { validationSchema: string[] } };
  return buildBindings(meta.validationFeedback.validationSchema, view.values);
}

/** The progress line the component must render for a given edits map. */
function expectedProgress(edits: ReadonlyMap<string, string>, view = extraction()): string {
  const { confirmed, corrected } = composeSubmission(fixtureBindings(view), edits);
  return `${confirmed} confirmed · ${corrected} corrected`;
}

function progressEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '.gemina-verification__footer .gemina-verification__progress',
  );
  if (!el) {
    throw new Error('progress line not found in the footer');
  }
  return el;
}

const SUPPLIER_KEY = 'label:supplier_name|ptr:/supplier_name/value';
const TOTAL_KEY = 'label:total_amount|ptr:/total_amount/value';
const PO_KEY = 'label:po_number|ptr:/po_number/value';

afterEach(() => {
  cleanup();
  getDocumentExtraction.mockReset();
  validateDocumentExtraction.mockReset();
  withSessionToken.mockClear();
  probe.rowRenders = 0;
});

describe('GeminaVerification — progress footer', () => {
  it('renders composeSubmission counts, aria-live polite, and an enabled Submit button', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();

    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    // Untouched: 2 resolved bindings confirmed, the NOT_FOUND po_number omitted.
    const progress = progressEl(container);
    expect(progress.textContent).toBe(expectedProgress(new Map()));
    expect(progress.textContent).toBe('2 confirmed · 0 corrected');
    expect(progress.getAttribute('aria-live')).toBe('polite');

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit.classList.contains('gemina-verification__submit')).toBe(true);
    expect(submit.closest('.gemina-verification__footer')).not.toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    // Ride-along (Task 15 review): per-input bidi — Latin values inside an
    // RTL document (and vice versa) need dir="auto" on the input itself.
    expect(supplier.getAttribute('dir')).toBe('auto');
  });

  it('typing into a bound input updates the line to composeSubmission counts (1 corrected)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();

    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    fireEvent.change(supplier, { target: { value: 'Acme Ltd.' } });

    expect(supplier.value).toBe('Acme Ltd.');
    expect(screen.getByText('edited')).toBeTruthy();
    const expected = expectedProgress(new Map([[SUPPLIER_KEY, 'Acme Ltd.']]));
    expect(expected).toBe('1 confirmed · 1 corrected');
    expect(progressEl(container).textContent).toBe(expected);
  });

  it('reverting to the initial string DELETES the edit — back to 0 corrected, badge gone', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();

    // RAW prefill string is '1500' (toInputString), so that is the revert target.
    const total = await screen.findByLabelText<HTMLInputElement>('Total Amount');
    fireEvent.change(total, { target: { value: '1600' } });
    expect(progressEl(container).textContent).toBe(
      expectedProgress(new Map([[TOTAL_KEY, '1600']])),
    );
    expect(screen.getByText('edited')).toBeTruthy();

    fireEvent.change(total, { target: { value: '1500' } });
    expect(progressEl(container).textContent).toBe('2 confirmed · 0 corrected');
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('clearing a never-extracted fill-in reverts to pristine (toInputString(NOT_FOUND) is "")', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();

    const po = await screen.findByLabelText<HTMLInputElement>('po_number');
    fireEvent.change(po, { target: { value: '42' } });
    const dirty = expectedProgress(new Map([[PO_KEY, '42']]));
    expect(dirty).toBe('2 confirmed · 1 corrected');
    expect(progressEl(container).textContent).toBe(dirty);

    fireEvent.change(po, { target: { value: '' } });
    expect(progressEl(container).textContent).toBe('2 confirmed · 0 corrected');
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('read-only (already-validated) review: Submit disabled, progress line HIDDEN', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ meta: { validated: true } }));
    const { container } = renderVerification();

    await screen.findByText('Already verified — showing the original extraction.');
    // Submit stays (disabled) for discoverability…
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // …but the progress line is gone: "0 corrected" about the ORIGINAL
    // payload would be noise on an already-verified extraction (Task 17).
    expect(container.querySelector('.gemina-verification__progress')).toBeNull();
  });
});

describe('GeminaVerification — edit persistence and reset', () => {
  it('edits survive an unrelated prop change (theme) without a reload', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { tokenManager } = makeManager();
    const { container, rerender } = render(
      <GeminaVerification extractionId="ext-1" tokenManager={tokenManager} theme="light" />,
    );

    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    fireEvent.change(supplier, { target: { value: 'Acme Ltd.' } });

    rerender(
      <GeminaVerification extractionId="ext-1" tokenManager={tokenManager} theme="dark" />,
    );

    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(screen.getByText('edited')).toBeTruthy();
    expect(progressEl(container).textContent).toBe('1 confirmed · 1 corrected');
    // Same manager, same extraction — the theme flip must not refetch.
    expect(getDocumentExtraction).toHaveBeenCalledTimes(1);
  });

  it('edits RESET when the extractionId changes (no cross-extraction bleed)', async () => {
    getDocumentExtraction
      .mockResolvedValueOnce(extraction())
      .mockResolvedValueOnce(
        extraction({
          values: { supplierName: { value: 'Bravo Industries' }, totalAmount: { value: 42 } },
        }),
      );
    const { tokenManager } = makeManager();
    const { container, rerender } = render(
      <GeminaVerification extractionId="ext-A" tokenManager={tokenManager} />,
    );

    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    fireEvent.change(supplier, { target: { value: 'Edited Co' } });
    expect(screen.getByText('edited')).toBeTruthy();

    rerender(
      <GeminaVerification extractionId="ext-B" tokenManager={tokenManager} />,
    );

    // The new load finishes: fresh values, NO stale edit, NO edited badge.
    const fresh = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    await waitFor(() => expect(fresh.value).toBe('Bravo Industries'));
    expect(screen.queryByText('edited')).toBeNull();
    expect(progressEl(container).textContent).toBe('2 confirmed · 0 corrected');
  });
});

describe('GeminaVerification — table row render isolation (probe)', () => {
  /** 4 non-meta columns (isTableArray needs > 3) with bound cells in TWO rows
   * — row 2 bailing out through the edits-slice comparator is the point. */
  const TABLE_VALUES = {
    supplierName: { value: 'Acme Ltd' },
    lineItems: [
      { description: { value: 'Widget' }, qty: { value: 2 }, unitPrice: { value: 100 }, lineTotal: { value: 200 } },
      { description: { value: 'Gadget' }, qty: { value: 1 }, unitPrice: { value: 300 }, lineTotal: { value: 300 } },
      { description: { value: 'Gizmo' }, qty: { value: 5 }, unitPrice: { value: 10 }, lineTotal: { value: 50 } },
    ],
  };
  const TABLE_META = {
    validationFeedback: {
      validationSchema: [
        'label:supplier_name|ptr:/supplier_name/value',
        'label:Line 1 Description|ptr:/line_items/0/description/value',
        'label:Line 2 Description|ptr:/line_items/1/description/value',
      ],
    },
  };

  it('one keystroke into a table cell re-renders ONLY that row', async () => {
    getDocumentExtraction.mockResolvedValueOnce(
      extraction({ values: TABLE_VALUES, meta: TABLE_META }),
    );
    renderVerification();

    const cell = await screen.findByLabelText<HTMLInputElement>('Line Items row 1 — Description');
    // Probe wired: the initial review commit rendered all three rows.
    expect(probe.rowRenders).toBe(3);

    probe.rowRenders = 0;
    fireEvent.change(cell, { target: { value: 'WidgetX' } });

    expect(cell.value).toBe('WidgetX');
    // Row 2's bound input is untouched — and its row never re-rendered.
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 2 — Description').value,
    ).toBe('Gadget');
    expect(probe.rowRenders).toBe(1);
  });
});

// The viewer toolbar's Magnifier is ALSO role="switch", so every query here
// disambiguates by accessible name.
const FILTER_NAME = 'Hide high-confidence fields';

describe('GeminaVerification: review filter', () => {
  // The default fixture scores supplierName `high` and leaves totalAmount and
  // po_number unscored — so the switch is offered, and turning it on hides
  // exactly one of the three review units.
  it('is offered, off, when the extraction carries field confidence', async () => {
    getDocumentExtraction.mockResolvedValue(extraction());
    renderVerification();
    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('.gemina-verification__filter-count')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Supplier Name' })).toBeTruthy();
  });

  it('hides the high-confidence field and reports the count', async () => {
    getDocumentExtraction.mockResolvedValue(extraction());
    renderVerification();
    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'Supplier Name' })).toBeNull();
    const count = document.querySelector('.gemina-verification__filter-count')!;
    expect(count.textContent).toBe('Showing 2 of 3');
    expect(count.getAttribute('aria-live')).toBe('polite');
    // …and turning it back off restores the field.
    fireEvent.click(toggle);
    expect(screen.getByRole('textbox', { name: 'Supplier Name' })).toBeTruthy();
  });

  // An affordance that cannot do anything is noise — same reasoning as the
  // eye button disappearing when a field has no coordinates.
  it('is absent entirely when nothing carries confidence', async () => {
    getDocumentExtraction.mockResolvedValue(extraction({
      values: { supplierName: { value: 'Acme Ltd' }, totalAmount: { value: 1500 } },
    }));
    renderVerification();
    await screen.findByRole('textbox', { name: 'Supplier Name' });
    expect(screen.queryByRole('switch', { name: FILTER_NAME })).toBeNull();
  });

  // §F10 — overall confidence is not a review unit and cannot be hidden, so a
  // switch offered on its account would do nothing at all.
  it('is absent when ONLY overall confidence is present', async () => {
    getDocumentExtraction.mockResolvedValue(extraction({
      values: {
        overallConfidence: 'high',
        supplierName: { value: 'Acme Ltd' },
        totalAmount: { value: 1500 },
      },
    }));
    renderVerification();
    await screen.findByRole('textbox', { name: 'Supplier Name' });
    expect(screen.queryByRole('switch', { name: FILTER_NAME })).toBeNull();
  });

  // The plan's global all-clear: filtering everything away would otherwise
  // leave a blank form, which is indistinguishable from a broken one.
  it('says so when the filter hides everything', async () => {
    getDocumentExtraction.mockResolvedValue(extraction({
      meta: {
        processingStatus: 'success',
        validated: false,
        purgedAt: null,
        validationFeedback: { validationSchema: ['label:supplier_name|ptr:/supplier_name/value'] },
      },
      values: { supplierName: { value: 'Acme Ltd', confidence: 'high' } },
    }));
    renderVerification();
    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    fireEvent.click(toggle);
    expect(screen.getByText('Nothing needs review — all 1 fields scored high.')).toBeTruthy();
    // …and the toggle is still there so the reviewer can get back.
    expect(screen.getByRole('switch', { name: FILTER_NAME })).toBeTruthy();
  });

  // §F11 — the same mounted component must not open the next extraction
  // already filtered; that reads as fields having gone missing.
  it('resets when a new extraction loads', async () => {
    getDocumentExtraction.mockResolvedValue(extraction());
    const { rerender, tokenManager } = renderVerification();
    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    fireEvent.click(toggle);
    expect(screen.queryByRole('textbox', { name: 'Supplier Name' })).toBeNull();

    rerender(<GeminaVerification extractionId="ext-2" tokenManager={tokenManager} />);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Supplier Name' })).toBeTruthy();
    });
    expect(screen.getByRole('switch', { name: FILTER_NAME }).getAttribute('aria-checked')).toBe('false');
  });
});

/* ---------------------------------------------------------------------------
 * The two review filters, together (plan Task 6).
 *
 * Each filter is pinned on its own elsewhere: the rule that decides which
 * columns are empty in empty-columns.test.ts, the render filter over them in
 * form.test.tsx, the state/gate/switch in verification-load.test.tsx. What is
 * NOT covered there is the pair of them engaged at once, which is where §S
 * consequence 3 lives — `computeEmptyColumns` takes no `HiddenSets`, so
 * emptiness is computed over the WHOLE row plan including the rows the
 * confidence filter is hiding.
 *
 * That independence is a decision with a visible cost (a column populated only
 * in a high-confidence row stays on screen reading blank), so it is exactly the
 * kind of thing a later reader "fixes". These tests are what stops that.
 * ------------------------------------------------------------------------- */

const CONFIDENCE_SWITCH = 'Hide high-confidence fields';
const COLUMNS_SWITCH = 'Hide empty columns';

/** The Line Items grid — the one section both filters act on. */
function lineItems(): HTMLElement {
  return screen.getByRole('region', { name: 'Line Items' });
}

/** Its DATA column headers, in render order. The eye / row-confidence /
 *  row-actions `<th>`s carry no text and drop out, which is deliberate: they
 *  are not columns and must never be counted as ones that survived. */
function dataHeaders(): string[] {
  return within(lineItems())
    .getAllByRole('columnheader')
    .map((th) => th.textContent ?? '')
    .filter((text) => text !== '');
}

function bodyRowCount(): number {
  return lineItems().querySelectorAll('tbody tr').length;
}

/**
 * The per-table "N columns hidden — blank in every row" notes.
 *
 * Filtered by text rather than read wholesale: the same class also renders
 * "Row editing is off while filtering", which the CONFIDENCE filter puts in
 * the same header, and the §D1 note beside *Add line* — so an unfiltered read
 * would silently mean something different in the tests that turn both switches
 * on. The count is the part that varies, so it is what the pattern anchors on.
 */
function columnNotes(): string[] {
  return [...document.querySelectorAll('.gemina-verification__filter-note')]
    .map((node) => node.textContent ?? '')
    .filter((text) => /^\d+ columns? hidden/.test(text));
}

/** The 8 of 19 columns the wide fixture actually populates, in server order. */
const POPULATED_HEADERS = [
  'Line Number', 'Description', 'Item Code', 'Quantity',
  'Unit Of Measure', 'Unit Price', 'Discount Percentage', 'Line Total',
];

/**
 * The wide fixture (19 declared columns, 11 blank in every row) with ROW-LEVEL
 * confidence on the first two rows, so BOTH switches are offered at once.
 *
 * Scores have to be synthesised: no local extraction has `evaluation` on, so
 * nothing reachable carries real confidence — and row confidence is what the
 * filter needs, since an `invoice_line_items` extraction has no header fields
 * to score at all.
 *
 * Rows 1 and 2 specifically, because row 2 is the ONLY row carrying
 * `discountPercentage`. That makes "populated only in a confidence-hidden row"
 * a real state of this fixture rather than a hypothetical.
 */
function scoredWideExtraction(): Record<string, unknown> {
  const view = wideTableExtraction();
  const rows = (view.values as Record<string, unknown>).line_items as Array<Record<string, unknown>>;
  for (const index of [0, 1]) {
    const row = rows[index];
    if (row === undefined) {
      throw new Error('the wide fixture must have at least two rows');
    }
    row.confidence = 'high';
  }
  return view;
}

describe('GeminaVerification: the two review filters together', () => {
  it('composes with the confidence filter without changing the column set', async () => {
    getDocumentExtraction.mockResolvedValueOnce(scoredWideExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    const columnsAlone = dataHeaders();
    expect(columnsAlone).toEqual(POPULATED_HEADERS);
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);
    expect(bodyRowCount()).toBe(4);

    // The other filter now removes ROWS underneath it — including the only row
    // `discount_percentage` was ever populated in.
    fireEvent.click(screen.getByRole('switch', { name: CONFIDENCE_SWITCH }));
    expect(bodyRowCount()).toBe(2);

    // …and the column set is byte-for-byte what it was. This is §S consequence
    // 3 as the reviewer experiences it: the two filters move different axes,
    // and neither one's structure shifts when the other is toggled. The rule
    // gets no `HiddenSets`, and the memo that runs it does not depend on
    // anything `filterOn` changes — that dependency list IS this property.
    expect(dataHeaders()).toEqual(columnsAlone);
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);

    // Engaged in the OTHER order, on the same screen: with the confidence
    // filter already on, turning the column filter off and back on lands on the
    // identical set. (Order-dependence would mean one filter had read the
    // other's output — the whole thing this pins against.)
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(dataHeaders().length).toBe(19);
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(dataHeaders()).toEqual(columnsAlone);
    expect(bodyRowCount()).toBe(2);
  });

  it('keeps a column populated ONLY in a confidence-hidden row', async () => {
    getDocumentExtraction.mockResolvedValueOnce(scoredWideExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    fireEvent.click(screen.getByRole('switch', { name: CONFIDENCE_SWITCH }));

    // THE ACCEPTED COST, pinned so nobody "fixes" it into a bug. `discount_
    // percentage` is populated on row 2 and nowhere else, and row 2 is one of
    // the two the confidence filter just took away. The column therefore stays
    // — it is not blank over the ROW PLAN, which is what the rule walks — and
    // reads blank in every row that is actually on screen.
    expect(dataHeaders()).toContain('Discount Percentage');
    // Its only value is genuinely off screen, so this is not a false-positive
    // pass from a row that quietly stayed.
    expect(screen.queryByLabelText('Line Items row 2 — Discount Percentage')).toBeNull();
    // Rows keep their PLAN positions, so the survivors are 3 and 4.
    for (const row of [3, 4]) {
      expect(
        screen.getByLabelText<HTMLInputElement>(`Line Items row ${row} — Discount Percentage`).value,
      ).toBe('');
    }

    // And the count says 11, not 12 — hiding a ROW must not make its column
    // qualify. This number is what a rule threading `HiddenSets` through would
    // move, silently and plausibly.
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);
  });

  /* REMOVING a row is the other way the two "rows" can diverge, and it is the
   * one that decided the note's copy.
   *
   * A removed row leaves the plan, so a column populated only in it becomes
   * genuinely empty over everything the rule walks — 11 -> 12, with
   * `discount_percentage` among them, in both orderings. The extraction still
   * holds that 10. So a note reading "empty in this extraction" would assert,
   * of a column the extraction populated, that nothing was extracted into it;
   * "blank in every row" stays true, because the rows it can mean — plan rows,
   * screen rows — no longer include the one that was removed.
   *
   * Sparse population is not a contrived case: F15 counted 276 nulls sitting
   * in columns that were populated elsewhere. */
  it('counts a column whose only populated row was removed — remove, then filter', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 2 — Discount Percentage').value,
    ).toBe('10');

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));

    expect(dataHeaders()).not.toContain('Discount Percentage');
    expect(columnNotes()).toEqual(['12 columns hidden — blank in every row']);
    // The claim holds against what is on screen: no row of this grid carries a
    // value in any hidden column, which is all the note says.
    expect(bodyRowCount()).toBe(3);
  });

  it('counts it the other way round too — filter, then remove, and it goes live', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);
    expect(dataHeaders()).toContain('Discount Percentage');

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));

    // The column unmounts under the reviewer — same class as the pair-error
    // unmount above, decided the same way, and here the count moving 11 -> 12
    // is the visible cause.
    expect(dataHeaders()).not.toContain('Discount Percentage');
    expect(columnNotes()).toEqual(['12 columns hidden — blank in every row']);
  });
});

/* ---------------------------------------------------------------------------
 * The column filter while the reviewer is actually working: typing, adding and
 * removing rows underneath it.
 *
 * The rule re-runs on every keystroke (that is what keeps a just-touched column
 * from unmounting), so "what the filter shows" is live state, not a snapshot
 * taken at load. These drive it through the real component — the memo chain,
 * the row plan and the DOM identity of the input under the cursor.
 * ------------------------------------------------------------------------- */
describe('GeminaVerification: hide empty columns while editing', () => {
  it('re-shows a column the moment a pair error appears in it', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    // `unit_size` and `unit_size_uom` are blank TOGETHER in all four rows —
    // the shape 23 of 29 real tables had — so both qualify and both go.
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);
    expect(dataHeaders()).not.toContain('Unit Size');
    expect(dataHeaders()).not.toContain('Unit Size Uom');

    // Half-fill the pair. The error must be raised with the filter OFF, and
    // that is not a convenience: with the filter ON a pair error can NEVER
    // newly appear in a hidden column. If the partner column holds a value
    // anywhere, the error already existed at load and the column was never
    // hidden; if the partner is blank everywhere, both halves are hidden and
    // neither has an input to type into. (The plan named this as a live
    // in-filter route; it is not one. Same correction Task 3 and Task 5 each
    // had to make about a route on this feature.)
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    fireEvent.change(screen.getByLabelText('Line Items row 1 — Unit Size'), {
      target: { value: '5' },
    });
    expect(screen.getAllByText(UNIT_PAIR_MESSAGE).length).toBe(2);

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));

    // NINE, not eleven. `unit_size` is kept by touched-ever (its extracted
    // value is still null — an edit is not a value), and `unit_size_uom` by the
    // pair-error clause alone. Hiding the blank half would remove exactly the
    // cell blocking Submit while the footer says a field needs attention: an
    // unresolvable dead end with no visible cause.
    expect(columnNotes()).toEqual(['9 columns hidden — blank in every row']);
    expect(dataHeaders()).toContain('Unit Size');
    expect(dataHeaders()).toContain('Unit Size Uom');
    expect(screen.getByLabelText('Line Items row 1 — Unit Size Uom')).toBeTruthy();
    expect(screen.getAllByText(UNIT_PAIR_MESSAGE).length).toBe(2);
    // The dead end this prevents, stated as the state it prevents it in.
    expect(
      (screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(container.querySelector('.gemina-verification__attention')).not.toBeNull();
  });

  /* The live column unmount, decided in the browser in Task 7 and pinned here.
   *
   * Resolving the pair error while the filter is on takes the partner column's
   * only reason to be visible away, and it leaves the grid in front of the
   * reviewer. Driven in chromium at 1280 (scripts/visual/probe-empty-columns
   * in the console repo, shots `unmount-before/after`): the caret does not
   * move — the cell being edited is held by touched-ever, keeps its DOM node
   * and keeps focus — the count ticks 9 -> 10, and the column that leaves is
   * blank in every row and was never typed into. It reads as the filter
   * answering the reviewer's own edit, not as data disappearing, so it stays.
   *
   * Pinned rather than left to prose because the alternative — a column that
   * became visible staying visible for the rest of the session — is the
   * plausible "fix" a later reader reaches for, and it would contradict §S,
   * which computes emptiness from current state on every render. The
   * confidence filter's same-class behaviour (F11) is on the backlog for the
   * same reason: one of these two is not the place to diverge.
   */
  it('lets a column go when the pair error that held it is resolved', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    // Raise the error with the filter off (the only order that reaches it),
    // then filter: `unit_size` is held by touched-ever, `unit_size_uom` by the
    // error alone.
    const unitSize = screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Unit Size');
    fireEvent.change(unitSize, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(columnNotes()).toEqual(['9 columns hidden — blank in every row']);
    expect(dataHeaders()).toContain('Unit Size Uom');

    const held = screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Unit Size');
    held.focus();
    fireEvent.change(held, { target: { value: '' } });

    // The partner column is gone, live, with the switch untouched.
    expect(dataHeaders()).not.toContain('Unit Size Uom');
    expect(screen.queryByLabelText('Line Items row 1 — Unit Size Uom')).toBeNull();
    expect(columnNotes()).toEqual(['10 columns hidden — blank in every row']);
    expect(screen.queryAllByText(UNIT_PAIR_MESSAGE)).toHaveLength(0);

    // …and NOT under the cursor. The cell the reviewer is in was typed into,
    // so touched-ever holds its column even though the edit was just deleted
    // by the return-to-pristine rule (F11) — same DOM node, still focused.
    expect(screen.getByLabelText('Line Items row 1 — Unit Size')).toBe(held);
    expect(document.activeElement).toBe(held);
    expect(dataHeaders()).toContain('Unit Size');
  });

  it('re-shows nothing when the reviewer edits a VISIBLE cell', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    const filtered = dataHeaders();
    expect(filtered).toEqual(POPULATED_HEADERS);

    // Engaging the filter legitimately re-rendered every row (they are handed a
    // new `columns` array), so the probe is reset AFTER it and before the
    // keystroke that is actually being measured.
    probe.rowRenders = 0;
    fireEvent.change(screen.getByLabelText('Line Items row 1 — Description'), {
      target: { value: 'Widget housing, gloss' },
    });

    // Touching a cell in a column that is already visible must not move the
    // column set at all: touched-ever grows, the rule re-runs, and it has to
    // land on exactly the same answer.
    expect(dataHeaders()).toEqual(filtered);
    expect(screen.queryByLabelText('Line Items row 1 — Barcode')).toBeNull();
    expect(columnNotes()).toEqual(['11 columns hidden — blank in every row']);

    // …and it costs ONE row render, not four. While the switch is on,
    // `emptyColumns` is derived from `edits`, so a fresh Map holding fresh Sets
    // arrives per keystroke; the positional bitmask is what keeps
    // `visibleColumns` referentially stable through that, and `columns` IS
    // compared by `areRowPropsEqual`. A dependency on the Set instead would
    // re-render every row of a 169-row table per character — with byte-
    // identical DOM, which is why this counts renders. (form.test.tsx pins the
    // same property against a hand-built harness; this is the real chain.)
    expect(probe.rowRenders).toBe(1);
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 2 — Description').value,
    ).toBe('Bracket set, steel');
  });

  it('survives a table where the plan removed the only populated row', async () => {
    // One extracted row, so removing it is what empties the extraction side of
    // the table while a row the reviewer typed remains.
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction({ rows: 1 }));
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    expect(screen.queryByLabelText('Line Items row 1 — Barcode')).toBeNull();

    // §D1: row editing stays ON under this filter, and BOTH `showControls`
    // sites have to honour that — the section-level one owns *Add line* and the
    // Row-actions header, and gating it on this filter once shipped green
    // against the whole suite (F12b).
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    fireEvent.change(screen.getByLabelText('Line Items row 2 — Description'), {
      target: { value: 'Typed by hand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));

    // F9's gate, reached the only way it can be: the table now has rows but no
    // EXTRACTED row, so it hides nothing and every column comes back. The wrong
    // gate here — "at least one row" — leaves 18 of 19 columns qualifying
    // (only the one just typed into does not), and §D4's never-empty-a-table
    // guard does NOT catch that: the grid collapses to a single column at the
    // exact moment the reviewer is filling the line in.
    expect(dataHeaders().length).toBe(19);
    expect(columnNotes()).toEqual([]);
    expect(bodyRowCount()).toBe(1);
    expect(
      screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Description').value,
    ).toBe('Typed by hand');
    // The point of it coming back: the added row's blank cells are reachable.
    const barcode = screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Barcode');
    fireEvent.change(barcode, { target: { value: '7290000000001' } });
    expect(screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Barcode').value)
      .toBe('7290000000001');
    // The switch itself stays put and still reads on — it is engaged, and a
    // control that vanished here would strand the state with no way back.
    expect(
      screen.getByRole('switch', { name: COLUMNS_SWITCH }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('never unmounts a column while it holds focus', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    const { container } = renderVerification();

    // Type into a blank column BEFORE filtering — the only order in which a
    // hidden column's cell can be reached at all.
    const typed = await screen.findByLabelText<HTMLInputElement>('Line Items row 1 — Barcode');
    fireEvent.change(typed, { target: { value: '7290000000001' } });

    fireEvent.click(screen.getByRole('switch', { name: COLUMNS_SWITCH }));
    // Ten of eleven: `barcode` survived the filter because it was touched. Its
    // extracted value is still null, so nothing about the DATA keeps it here.
    expect(columnNotes()).toEqual(['10 columns hidden — blank in every row']);
    const barcode = screen.getByLabelText<HTMLInputElement>('Line Items row 1 — Barcode');
    barcode.focus();
    expect(document.activeElement).toBe(barcode);

    // Now clear it back to the pristine string. `handleEdit` DELETES the edit
    // on return-to-pristine — the progress line is the proof — so a rule fed
    // `edits` instead of the ref-held touched-ever set would see this cell as
    // never visited, call the column empty, and unmount it out from under the
    // cursor mid-correction (F11).
    fireEvent.change(barcode, { target: { value: '' } });
    expect(
      container.querySelector('.gemina-verification__progress')?.textContent,
    ).toContain('0 corrected');

    // Same DOM node, still focused: not merely "an input with that label is on
    // screen" — a remount would satisfy that and still have thrown the caret
    // out.
    expect(screen.getByLabelText('Line Items row 1 — Barcode')).toBe(barcode);
    expect(document.activeElement).toBe(barcode);
    expect(columnNotes()).toEqual(['10 columns hidden — blank in every row']);
  });
});
