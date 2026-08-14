/**
 * <GeminaVerification> — Task 16: edit state + progress summary.
 *
 * Separate file from verification-load.test.tsx for two reasons: that file is
 * already ~740 lines, and the render-count probe below needs a FILE-SCOPED
 * jsx-runtime mock that must not ride along on every load test.
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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { buildBindings, composeSubmission } from '../../src/verification/bindings';
import { extraction } from './helpers';

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
 * TableRowView render probe. Every TableRowView render creates exactly one
 * clickable <tr> (row click-to-flash); the thead <tr> has no onClick and
 * nothing else in the tree creates table rows. A memo bail-out renders
 * nothing, so the counter counts actual row renders. Both automatic-runtime
 * entry points are wrapped (vitest's esbuild may emit either).
 */
const probe = vi.hoisted(() => ({ rowRenders: 0 }));

function countClickableTr(type: unknown, props: unknown): void {
  if (type === 'tr' && typeof (props as { onClick?: unknown } | null)?.onClick === 'function') {
    probe.rowRenders += 1;
  }
}

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    ...actual,
    jsx: (type: unknown, props: unknown, key?: unknown) => {
      countClickableTr(type, props);
      return actual.jsx!(type, props, key);
    },
    jsxs: (type: unknown, props: unknown, key?: unknown) => {
      countClickableTr(type, props);
      return actual.jsxs!(type, props, key);
    },
  };
});

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    ...actual,
    jsxDEV: (type: unknown, props: unknown, ...rest: unknown[]) => {
      countClickableTr(type, props);
      return actual.jsxDEV!(type, props, ...rest);
    },
  };
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
