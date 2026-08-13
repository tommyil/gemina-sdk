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
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { extraction, httpError } from './helpers';

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
