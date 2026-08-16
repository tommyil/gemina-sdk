/**
 * <GeminaVerification> — Task 18: the accessibility contract in one file.
 *
 * What is pinned here (design §8 + the Task 18 sweep):
 * - the viewer canvas is ONE labeled image to AT (`role="img"`,
 *   "Document image"); its inner <img>, overlay boxes and flash rects are
 *   presentation (the per-rect aria-hidden is asserted in viewer.test.tsx
 *   where the overlay/flash harnesses live);
 * - the editable pane is a real, labeled <form> landmark ("Extraction
 *   fields") that never implicitly submits;
 * - every rendered <input> carries an aria-label (FieldInput contract,
 *   across headers, tables, and the Not-detected section);
 * - confidence-dot REASONS are part of the accessible name, not only the
 *   hover-only title tooltip;
 * - the progress line is an `aria-live="polite"` region;
 * - edge states split announcement severity: thrown fetch failures
 *   (404/5xx/401-after-retry) are `role="alert"`, meta-derived "nothing to
 *   verify" landings (purged / not-completed / verification-unavailable) are
 *   calm `role="status"` — the done state is `role="status"` too (asserted in
 *   verification-submit.test.tsx where the submit harness lives).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { extraction, httpError } from './helpers';
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

function makeManager(): GeminaTokenManager {
  let n = 0;
  return new GeminaTokenManager({
    fetchToken: async () => ({
      token: `eyJhbGciOiJIUzI1NiJ9.payload${++n}.signature`,
      expiresIn: 900,
    }),
  });
}

function renderVerification() {
  return render(
    <GeminaVerification extractionId="ext-1" tokenManager={makeManager()} onError={() => {}} />,
  );
}

afterEach(() => {
  cleanup();
  getDocumentExtraction.mockReset();
  validateDocumentExtraction.mockReset();
  withSessionToken.mockClear();
});

/** Fixture with a table + a low-confidence reasoned header, so the sweep
 * covers header inputs, table-cell inputs, the Not-detected fill-in, and a
 * reasons-bearing confidence dot in one load. */
function richExtraction(): Record<string, unknown> {
  return extraction({
    values: {
      supplierName: {
        value: 'Acme Ltd',
        confidence: 'low',
        confidence_reasons: ['blurry_region'],
      },
      totalAmount: { value: 1500 },
      lineItems: [
        {
          description: { value: 'Widget' },
          qty: { value: 2 },
          unitPrice: { value: 100 },
          lineTotal: { value: 200 },
        },
      ],
    },
    meta: {
      validationFeedback: {
        validationSchema: [
          'label:supplier_name|ptr:/supplier_name/value',
          'label:total_amount|ptr:/total_amount/value',
          'label:Line 1 Description|ptr:/line_items/0/description/value',
          'label:po_number|ptr:/po_number/value',
        ],
      },
    },
  });
}

describe('GeminaVerification a11y — review structure', () => {
  it('the viewer canvas is one labeled image: role="img" named "Document image"', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');

    const canvas = container.querySelector('.gemina-verification__canvas')!;
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toBe('Document image');
    expect(screen.getByRole('img', { name: 'Document image' })).toBe(canvas);
  });

  it('the field pane is a real <form> landmark labeled "Extraction fields"', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    renderVerification();
    await screen.findByLabelText('Supplier Name');

    const form = screen.getByRole('form', { name: 'Extraction fields' });
    expect(form.tagName).toBe('FORM');
    expect(form.classList.contains('gemina-verification__form')).toBe(true);
  });

  it('every rendered input has a non-empty aria-label (headers, table cells, fill-ins)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');

    const inputs = Array.from(container.querySelectorAll('input'));
    // Sanity: the sweep really covers all three input habitats.
    expect(inputs.length).toBe(4);
    for (const input of inputs) {
      expect(input.getAttribute('aria-label'), input.outerHTML).toBeTruthy();
    }
    expect(screen.getByLabelText('Line Items row 1 — Description')).toBeTruthy();
    expect(screen.getByLabelText('po_number')).toBeTruthy();
  });

  it('confidence reasons are part of the dot accessible name, not title-only', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    renderVerification();
    await screen.findByLabelText('Supplier Name');

    expect(screen.getByRole('img', { name: 'Low confidence: Blurry Region' })).toBeTruthy();
  });

  it('the progress line is an aria-live="polite" region', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');

    const progress = container.querySelector('.gemina-verification__progress')!;
    expect(progress.getAttribute('aria-live')).toBe('polite');
  });
});

describe('GeminaVerification a11y — edge-state announcement severity', () => {
  it('loading announces politely: role="status"', () => {
    getDocumentExtraction.mockReturnValueOnce(new Promise(() => {})); // never settles
    renderVerification();

    expect(screen.getByRole('status').textContent).toBe('Loading extraction…');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['purged', { purgedAt: '2026-08-10T00:00:00Z' }, 'Document no longer available (retention policy).'],
    ['not-completed', { processingStatus: 'failed' }, 'This extraction did not complete, so there is nothing to verify.'],
    ['verification-unavailable', { validationFeedback: null }, "Verification isn't available for this extraction."],
  ])('meta-derived %s is a calm role="status", never an alert', async (_reason, meta, copy) => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ meta }));
    renderVerification();

    await screen.findByText(copy);
    const state = screen.getByRole('status');
    expect(state.textContent).toContain(copy);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['not-available (404)', () => getDocumentExtraction.mockRejectedValueOnce(httpError(404)), 'This extraction is not available.'],
    ['load-failed (500)', () => getDocumentExtraction.mockRejectedValueOnce(httpError(500)), "Couldn't load the extraction."],
    [
      'session-expired (401 twice)',
      () =>
        getDocumentExtraction
          .mockRejectedValueOnce(httpError(401))
          .mockRejectedValueOnce(httpError(401)),
      'Session expired — please reload the page or sign in again.',
    ],
  ])('thrown failure %s announces assertively: role="alert"', async (_label, arm, copy) => {
    arm();
    renderVerification();

    await screen.findByText(copy);
    const state = screen.getByRole('alert');
    expect(state.textContent).toContain(copy);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('review filter accessibility', () => {
  // The viewer toolbar's Magnifier is also role="switch", so a STABLE
  // accessible name is what makes either control findable — by AT and by test.
  const FILTER_NAME = 'Hide high-confidence fields';

  it('is a switch with a constant name whose aria-checked tracks state', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    renderVerification();

    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    // The NAME must not move with the state — only aria-checked does. The
    // visible label still equals the accessible name (WCAG 2.5.3).
    const same = screen.getByRole('switch', { name: FILTER_NAME });
    expect(same.getAttribute('aria-checked')).toBe('true');
    expect(same.textContent).toBe(FILTER_NAME);
  });

  it('announces the count politely, and only while filtering', async () => {
    getDocumentExtraction.mockResolvedValueOnce(richExtraction());
    const { container } = renderVerification();

    const toggle = await screen.findByRole('switch', { name: FILTER_NAME });
    expect(container.querySelector('.gemina-verification__filter-count')).toBeNull();

    fireEvent.click(toggle);
    const count = container.querySelector('.gemina-verification__filter-count');
    expect(count).not.toBeNull();
    expect(count!.getAttribute('aria-live')).toBe('polite');
    expect(count!.textContent).toMatch(/^Showing \d+ of \d+$/);
  });

  // The SECOND filter. Its accessible name has the same job and the same
  // hazard: three role="switch" controls now share this widget (Magnifier,
  // the confidence filter, this one), so the name is the only thing that
  // distinguishes them — to a screen reader exactly as much as to this test.
  const EMPTY_COLUMNS_NAME = 'Hide empty columns';

  it('exposes the empty-columns control as a switch with a stable accessible name', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();

    const toggle = await screen.findByRole('switch', { name: EMPTY_COLUMNS_NAME });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    // The name must NOT move with the state — only aria-checked does. A label
    // that flipped to "Show empty columns" would be re-announced every time
    // the control took focus, and would no longer name the mode it is in.
    const same = screen.getByRole('switch', { name: EMPTY_COLUMNS_NAME });
    expect(same.getAttribute('aria-checked')).toBe('true');
    // Visible label equals the accessible name (WCAG 2.5.3) — so a speech
    // user can say what they read.
    expect(same.textContent).toBe(EMPTY_COLUMNS_NAME);

    // ...and it is a DIFFERENT control from the other switches on screen: the
    // magnifier is unaffected, which a name collision would not survive.
    expect(
      screen.getByRole('switch', { name: 'Magnifier' }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  /* The §D1 note is *Add line*'s DESCRIPTION, not decoration beside it.
   *
   * A reviewer who tabs to that button while columns are hidden otherwise
   * hears "Add line" and nothing else, presses it, and finds the limit only
   * after the row exists — the same failure that ruled out a tooltip. The
   * association is what makes the sentence reachable without sight, so it is
   * asserted here rather than left to the text-presence tests in
   * form.test.tsx. */
  it('describes Add line with the limit that applies while columns are hidden', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();
    const addLine = await screen.findByRole('button', { name: 'Add line' });

    // Nothing hidden yet: no description, and no dangling id either — a
    // reference to an element that is not there is worse than none.
    expect(addLine.getAttribute('aria-describedby')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: EMPTY_COLUMNS_NAME }));
    const described = screen.getByRole('button', { name: 'Add line' });
    const describedBy = described.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'New lines can only fill the visible columns'
        + ' — turn off “Hide empty columns” to reach the rest.',
    );

    // And it comes back off with the switch: the limit does not exist when
    // every column is reachable, so neither does its description.
    fireEvent.click(screen.getByRole('switch', { name: EMPTY_COLUMNS_NAME }));
    expect(screen.getByRole('button', { name: 'Add line' }).getAttribute('aria-describedby'))
      .toBeNull();
  });

  // Row controls disappearing while filtering is pinned in form.test.tsx,
  // where a row-mutable fixture already exists. It belongs there rather than
  // here: §F9's point is that a DISABLED control could carry no accessible
  // explanation (Tip binds hover/focus handlers to its child, and a disabled
  // button dispatches neither), so the fix was to remove them — which leaves
  // nothing for an a11y sweep to assert about.
});
