/**
 * <GeminaVerification> — Task 17: confirm dialog + submit flow.
 *
 * Contracts pinned here:
 * - Submit click opens an in-component confirm dialog (role=dialog,
 *   aria-modal, the exact confirm-final copy); Cancel returns to review with
 *   every edit intact and NO network call.
 * - Confirm PUTs the EXACT composeSubmission body — hand-written here, not
 *   derived through composeSubmission, so this file pins the wire contract
 *   itself: untouched resolved values verbatim, edited strings trimmed,
 *   blank-edited never-extracted keys omitted (the Task 4 rules end to end).
 * - Success → done recap; onComplete({ correctedValues: byLabel, summary:
 *   result.data }) EXACTLY once.
 * - 409 → SILENT refetch → already-validated read-only review; no onError,
 *   no onComplete, progress line hidden.
 * - Failures NEVER clear edits: 500 → submit-error with the server
 *   description + inline Retry (straight back to submitting — no second
 *   confirm); 401 retries once via invalidate; 401-twice → session-expired
 *   submit-error.
 * - The review form stays MOUNTED through confirming AND submitting (the
 *   overlay covers it; a readOnly flip would visually discard edits).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const onError = vi.fn();
  const onComplete = vi.fn();
  const utils = render(
    <GeminaVerification
      extractionId="ext-1"
      tokenManager={tokenManager}
      onError={onError}
      onComplete={onComplete}
      {...extraProps}
    />,
  );
  return { ...utils, tokenManager, fetchToken, onError, onComplete };
}

/** Drain the promise chain of an in-flight (mocked, timerless) request. */
function flushMicrotasks(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

const SUPPLIER_KEY = 'label:supplier_name|ptr:/supplier_name/value';
const TOTAL_KEY = 'label:total_amount|ptr:/total_amount/value';
const CURRENCY_KEY = 'label:currency|ptr:/currency/value';

const CONFIRM_COPY =
  "Submit these values? This is final — they can be submitted once and can't be changed.";

/** A realistic ComparisonSummaryModel — threaded to onComplete VERBATIM. */
const SUMMARY = {
  accuracy: 0.5,
  byLabel: { supplier_name: 'incorrect', total_amount: 'correct' },
  correctFields: ['total_amount'],
  counts: { tp: 1, fp: 1, fn: 0, tn: 0 },
  coverage: 1,
  differences: [],
};

/** ExtractionValidationResultOutDTO shape: the summary lives at `.data`. */
const VALIDATION_RESULT = { createdAt: null, data: SUMMARY, errors: [] };

/** Load the fixture into review and dirty the supplier field. */
async function startEditedReview(
  extraProps: Partial<Parameters<typeof GeminaVerification>[0]> = {},
) {
  getDocumentExtraction.mockResolvedValueOnce(extraction());
  const utils = renderVerification(extraProps);
  const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
  fireEvent.change(supplier, { target: { value: 'Acme Ltd.' } });
  return { ...utils, supplier };
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Confirm submission' }) as HTMLButtonElement;
}

/** Open the dialog and confirm — the standard submit path. */
async function submitAndConfirm() {
  fireEvent.click(submitButton());
  fireEvent.click(confirmButton());
  await flushMicrotasks();
}

afterEach(() => {
  cleanup();
  getDocumentExtraction.mockReset();
  validateDocumentExtraction.mockReset();
  withSessionToken.mockClear();
});

describe('GeminaVerification — confirm dialog', () => {
  it('Submit opens the dialog (role, aria-modal, exact copy); Cancel keeps edits, no PUT', async () => {
    const { supplier } = await startEditedReview();

    fireEvent.click(submitButton());

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('gemina-verification__confirm-dialog')).toBe(true);
    expect(screen.getByText(CONFIRM_COPY)).toBeTruthy();
    // Focus lands on the final-action button so Enter confirms.
    expect(document.activeElement).toBe(confirmButton());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(screen.getByText('edited')).toBeTruthy();
    expect(validateDocumentExtraction).not.toHaveBeenCalled();
    // Focus returns to the button that opened the dialog.
    expect(document.activeElement).toBe(submitButton());
  });

  it('Escape cancels the dialog (review intact)', async () => {
    await startEditedReview();

    fireEvent.click(submitButton());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(validateDocumentExtraction).not.toHaveBeenCalled();
  });

  it('keeps the review form MOUNTED (edits visible) through confirming and submitting', async () => {
    let resolvePut: (value: unknown) => void = () => {};
    validateDocumentExtraction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    await startEditedReview();

    // Confirming: overlay up, form still there, edit still in the DOM.
    fireEvent.click(submitButton());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    // The progress aria-live region stays alive beneath the overlay.
    expect(document.querySelector('.gemina-verification__progress')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);

    // Submitting: STILL mounted — never a readOnly flip that discards edits.
    fireEvent.click(confirmButton());
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(screen.queryByRole('textbox', { name: 'Supplier Name' })).toBeTruthy();
    // While the PUT is in flight BOTH dialog buttons disable — Cancel too:
    // the request cannot be aborted, so "Cancel" would be a lie.
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(confirmButton().disabled).toBe(true);

    resolvePut(VALIDATION_RESULT);
    await flushMicrotasks();
    expect(screen.getByText('Submitted')).toBeTruthy();
  });

  it('Tab wraps between Cancel and Confirm while the dialog is open (focus trap)', async () => {
    await startEditedReview();

    fireEvent.click(submitButton());
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Entry focus: the final-action button.
    expect(document.activeElement).toBe(confirmButton());

    // Tab from the LAST tabbable (Confirm) wraps to the first (Cancel)…
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    // …plain Tab from Cancel would land on Confirm natively (not trapped);
    // Shift+Tab from the FIRST tabbable (Cancel) wraps back to the last.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmButton());
  });

  it('non-interactive mousedowns (scrim AND dialog interior) are default-prevented; button presses keep theirs', async () => {
    await startEditedReview();

    fireEvent.click(submitButton());
    expect(document.activeElement).toBe(confirmButton());

    // dispatchEvent returns false ⇔ preventDefault ran: the browser's
    // mousedown default (move focus to the press target — for these targets
    // a blur to <body>, which would drop the overlay's keydown handler out
    // of the focus path) is suppressed. The test env doesn't implement that
    // focus-move default, so the return value is the real assertion;
    // activeElement is the behavior it stands for.
    const overlay = document.querySelector<HTMLElement>('.gemina-verification__confirm')!;
    expect(fireEvent.mouseDown(overlay)).toBe(false);
    // The dialog's own NON-interactive interior blurs to <body> in real
    // browsers too — the guard must cover it, not just the scrim.
    expect(fireEvent.mouseDown(screen.getByText(CONFIRM_COPY))).toBe(false);
    expect(document.activeElement).toBe(confirmButton());

    // Presses on the dialog's buttons keep their default — Cancel/Confirm
    // stay normally clickable/focusable.
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Cancel' }))).toBe(true);
  });

  it('double-click Confirm submits once (button disabled while submitting)', async () => {
    let resolvePut: (value: unknown) => void = () => {};
    validateDocumentExtraction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    await startEditedReview();

    fireEvent.click(submitButton());
    fireEvent.click(confirmButton());
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());

    resolvePut(VALIDATION_RESULT);
    await flushMicrotasks();
    expect(validateDocumentExtraction).toHaveBeenCalledTimes(1);
  });
});

describe('GeminaVerification — submit success', () => {
  it('PUTs the EXACT composed body: untouched raw + trimmed edit + omitted blank-missing', async () => {
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    renderVerification();

    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    // Edited string is submitted TRIMMED (composer trims at submit time).
    fireEvent.change(supplier, { target: { value: '  Acme Ltd.  ' } });
    // Blank edit on the never-extracted po_number: nothing asserted → OMITTED.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('po_number'), {
      target: { value: '   ' },
    });

    await submitAndConfirm();

    expect(validateDocumentExtraction).toHaveBeenCalledTimes(1);
    // Hand-written expectation — the wire contract, not composeSubmission
    // round-tripped: total_amount is the RAW resolved primitive (the schema
    // pointer ends in /value), supplier is the trimmed edit, po_number and
    // nothing else appears.
    expect(validateDocumentExtraction).toHaveBeenCalledWith({
      targetDocumentExtractionId: 'ext-1',
      extractionValidationInDTO: {
        data: {
          [SUPPLIER_KEY]: 'Acme Ltd.',
          [TOTAL_KEY]: 1500,
        },
      },
    });
  });

  it('renders the done state and fires onComplete(byLabel, summary) exactly once', async () => {
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { tokenManager } = makeManager();
    const onComplete = vi.fn();
    const { container, rerender } = render(
      <GeminaVerification
        extractionId="ext-1"
        tokenManager={tokenManager}
        onComplete={onComplete}
        theme="light"
      />,
    );
    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    fireEvent.change(supplier, { target: { value: 'Acme Ltd.' } });

    await submitAndConfirm();

    // Done: checkmark state + recap (1 untouched-resolved, 1 corrected).
    const state = container.querySelector('.gemina-verification__state');
    expect(state).toBeTruthy();
    expect(screen.getByText('Submitted')).toBeTruthy();
    expect(screen.getByText('1 confirmed · 1 corrected')).toBeTruthy();
    // Announced politely, and focus lands on the state container (tabIndex
    // -1) — the dialog under the keyboard user just unmounted.
    expect(state!.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(state);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      correctedValues: { supplier_name: 'Acme Ltd.', total_amount: 1500 },
      summary: SUMMARY,
    });

    // A later unrelated re-render must not re-fire (completedRef guard).
    rerender(
      <GeminaVerification
        extractionId="ext-1"
        tokenManager={tokenManager}
        onComplete={onComplete}
        theme="dark"
      />,
    );
    await flushMicrotasks();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('GeminaVerification — submit failures (edits NEVER cleared)', () => {
  it('409 → silent refetch → already-validated read-only banner; no onError/onComplete; progress hidden', async () => {
    validateDocumentExtraction.mockRejectedValueOnce(
      httpError(409, { errorCode: 'already_validated' }),
    );
    const { onError, onComplete, container } = await startEditedReview();
    // Queued AFTER the initial load's fixture: this one serves the refetch.
    getDocumentExtraction.mockResolvedValueOnce(extraction({ meta: { validated: true } }));

    await submitAndConfirm();

    expect(
      await screen.findByText('Already verified — showing the original extraction.'),
    ).toBeTruthy();
    // Read-only landing: values as text, no inputs, no progress-line noise.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.gemina-verification__progress')).toBeNull();
    expect(getDocumentExtraction).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('500 → submit-error with the server description, edits kept; Retry re-PUTs (no second confirm) and succeeds', async () => {
    validateDocumentExtraction
      .mockRejectedValueOnce(httpError(500, { description: 'Feedback could not be stored.' }))
      .mockResolvedValueOnce(VALIDATION_RESULT);
    const { onError } = await startEditedReview();

    await submitAndConfirm();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Feedback could not be stored.');
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(screen.getByText('edited')).toBeTruthy();
    // Focus lands on Retry when the dialog unmounts into submit-error.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('submit-failed', {
      status: 500,
      errorCode: undefined,
      description: 'Feedback could not be stored.',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Straight to submitting — the confirm-final question is never re-asked.
    expect(screen.queryByText(CONFIRM_COPY)).toBeNull();
    await flushMicrotasks();

    expect(validateDocumentExtraction).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Submitted')).toBeTruthy();
  });

  it('falls back to the generic submit-error copy when the server sends no description', async () => {
    validateDocumentExtraction.mockRejectedValueOnce(httpError(500));
    await startEditedReview();

    await submitAndConfirm();

    expect(
      screen.getByText('Submission failed — your corrections are still here.'),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
  });

  it('401 then success → invalidate + re-mint (token fetched twice), submission passes', async () => {
    validateDocumentExtraction
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce(VALIDATION_RESULT);
    const { fetchToken, onError } = await startEditedReview();

    await submitAndConfirm();

    // Mint #1 served the load AND the first PUT (cache); the post-invalidate
    // retry minted #2.
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(validateDocumentExtraction).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Submitted')).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it('401 twice → session-expired submit-error with SUBMIT-side copy (no "reload"), edits kept', async () => {
    validateDocumentExtraction
      .mockRejectedValueOnce(httpError(401))
      .mockRejectedValueOnce(httpError(401));
    const { onError, onComplete } = await startEditedReview();

    await submitAndConfirm();

    // Submit-specific copy: the load-path text says "reload the page", which
    // would DESTROY the state-held edits here — this copy must never suggest
    // it, and must point at the preserved-corrections + Retry path instead.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Session expired — sign in again in another tab, then press Retry. Your corrections are still here.',
    );
    expect(alert.textContent).not.toContain('reload');
    // Edits survive: a fresh sign-in elsewhere + Retry can still succeed.
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(onError).toHaveBeenCalledWith('session-expired', {
      status: 401,
      errorCode: undefined,
      description: undefined,
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('GeminaVerification — unmount mid-submit', () => {
  /** Mount, edit, confirm-submit with the PUT held pending; return the
   * settlers so a test can resolve/reject AFTER the widget is gone. */
  async function startPendingSubmit() {
    let resolvePut: (value: unknown) => void = () => {};
    let rejectPut: (reason: unknown) => void = () => {};
    validateDocumentExtraction.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolvePut = resolve;
        rejectPut = reject;
      }),
    );
    const utils = await startEditedReview();
    fireEvent.click(submitButton());
    fireEvent.click(confirmButton());
    // The token mint is async — flush it so the PUT is genuinely IN FLIGHT
    // (not merely queued) when the test unmounts.
    await flushMicrotasks();
    expect(validateDocumentExtraction).toHaveBeenCalledTimes(1);
    return { ...utils, resolvePut, rejectPut };
  }

  it('a PUT that RESOLVES after unmount fires no onComplete and no act warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount, onComplete, onError, resolvePut } = await startPendingSubmit();

      unmount();
      resolvePut(VALIDATION_RESULT);
      await flushMicrotasks();

      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      // React act/update warnings arrive via console.error — none allowed.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a PUT that REJECTS after unmount fires no onError and no act warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount, onComplete, onError, rejectPut } = await startPendingSubmit();

      unmount();
      rejectPut(httpError(500, { description: 'too late' }));
      await flushMicrotasks();

      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * The component is a workflow step — extract, then check and correct, then
 * submit — not a feedback widget. "Feedback" told the reviewer their edits were
 * an optional opinion collected for someone else's benefit, when they are in
 * fact the values that get recorded. The word is retired from every
 * user-visible string; it survives only in code comments and in the API
 * surface (`meta.validationFeedback`, the `onError` reason names), which are
 * contract, not copy.
 */
describe('GeminaVerification — copy', () => {
  it('labels the primary action "Submit" and says "feedback" nowhere on screen', async () => {
    await startEditedReview();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(screen.queryByText(/feedback/i)).toBeNull();
  });

  it('names the completed state with the same verb as the action', async () => {
    // An action keeps its name through the whole flow: Submit -> Submitted.
    await startEditedReview();
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();
    expect(screen.getByText('Submitted')).toBeTruthy();
    expect(screen.queryByText(/feedback/i)).toBeNull();
  });

  it('the confirm dialog warns it is one-shot without the word "feedback"', async () => {
    await startEditedReview();
    fireEvent.click(submitButton());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/final/i);
    expect(dialog.textContent).not.toMatch(/feedback/i);
  });
});

/**
 * Validation is one-shot and irreversible, so an invalid value is a hard
 * blocker rather than a warning: there is no second submission to fix it in.
 */

/**
 * A review loaded WITH typed descriptors — currency as an ISO 4217 field and
 * a numeric total, so the blocking-validation gate has something to bite on.
 */
async function startTypedReview(valueOverrides: Record<string, unknown> = {}) {
  getDocumentExtraction.mockResolvedValueOnce(
    extraction({
      meta: {
        processingStatus: 'success',
        validated: false,
        purgedAt: null,
        validationFeedback: {
          validationSchema: [CURRENCY_KEY, TOTAL_KEY],
          validationFields: [
            { key: CURRENCY_KEY, label: 'currency', type: 'string', format: 'iso4217' },
            { key: TOTAL_KEY, label: 'total_amount', type: 'number' },
          ],
        },
      },
      values: { currency: { value: 'USD' }, totalAmount: { value: 1500 }, ...valueOverrides },
    }),
  );
  const utils = renderVerification();
  await screen.findByLabelText('Currency');
  return utils;
}

describe('GeminaVerification — blocking validation', () => {

  it('blocks submission while a field is invalid and says how many need attention', async () => {
    await startTypedReview();
    fireEvent.change(screen.getByRole('combobox', { name: 'Currency' }), {
      target: { value: 'dollars' },
    });

    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText('1 field needs attention')).toBeTruthy();
    // One job per element: the progress count steps aside.
    expect(screen.queryByText(/confirmed ·/)).toBeNull();
  });

  it('re-enables submission once the last invalid field is fixed', async () => {
    await startTypedReview();
    const currency = screen.getByRole('combobox', { name: 'Currency' });

    fireEvent.change(currency, { target: { value: 'dollars' } });
    expect(submitButton().disabled).toBe(true);

    fireEvent.change(currency, { target: { value: 'EUR' } });
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(/needs attention/)).toBeNull();
    expect(screen.getByText(/confirmed ·/)).toBeTruthy();
  });

  it('pluralises the count', async () => {
    await startTypedReview();
    fireEvent.change(screen.getByRole('combobox', { name: 'Currency' }), {
      target: { value: 'dollars' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Total Amount' }), {
      target: { value: 'twelve' },
    });
    expect(screen.getByText('2 fields need attention')).toBeTruthy();
  });

  it('an untouched extraction with an odd value still submits', async () => {
    // The gate reads EDITS. A value the reviewer never touched is the model's
    // output and must not trap them in a form they cannot submit.
    await startTypedReview({ currency: { value: 'dollars' } });
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });
});

/**
 * `rowSources` on the wire. Without this the whole of Phase 7 is inert: the
 * client can plan all it likes, but a body without `rowSources` is scored by a
 * backend that has no idea rows moved.
 */
describe('GeminaVerification — row alignment on the wire', () => {
  const COLS = ['description', 'unit_of_measure', 'quantity', 'item_code'];
  const ROWS = [
    { description: 'A', unit_of_measure: 'UNIT', quantity: 1, item_code: 'X' },
    { description: 'B', unit_of_measure: 'BOX', quantity: 2, item_code: 'Y' },
  ];

  async function startTableReview() {
    getDocumentExtraction.mockResolvedValueOnce(
      extraction({
        meta: {
          processingStatus: 'success',
          validated: false,
          purgedAt: null,
          validationFeedback: {
            validationSchema: ROWS.flatMap((_r, i) =>
              COLS.map((c) => `label:line_${i}_${c}|ptr:/line_items/${i}/${c}`)),
            rowMutableTables: [{
              pointer: '/line_items',
              keyTemplate: 'label:line_{index}_{field}|ptr:/line_items/{index}/{field}',
              columns: COLS.map((name) => ({ name, type: 'string' })),
            }],
          },
        },
        values: { line_items: ROWS },
      }),
    );
    const utils = renderVerification();
    await screen.findByRole('button', { name: 'Remove line 1' });
    return utils;
  }

  it('omits rowSources entirely when no row was added or removed', async () => {
    await startTableReview();
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();

    const body = validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
    // Byte-identical to the pre-row-editing request for the common path.
    expect('rowSources' in body).toBe(false);
  });

  it('sends the alignment after a row is removed, and re-indexes the payload', async () => {
    await startTableReview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();

    const body = validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
    expect(body.rowSources).toEqual([{ table: '/line_items', sources: [1] }]);
    // Row B moved up into position 0 — the payload mirrors the approved table.
    expect(body.data['label:line_0_description|ptr:/line_items/0/description']).toBe('B');
    expect('label:line_1_description|ptr:/line_items/1/description' in body.data).toBe(false);
  });

  it('sends a null source for a row the reviewer added AND filled in', async () => {
    await startTableReview();
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Line Items row 3 — Description' }),
      { target: { value: 'Widget C' } },
    );
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();

    const body = validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
    expect(body.rowSources).toEqual([{ table: '/line_items', sources: [0, 1, null] }]);
    expect(body.data['label:line_2_description|ptr:/line_items/2/description']).toBe('Widget C');
  });

  it('leaves NO trace of an added row the reviewer never typed into', async () => {
    // Clicking Add line and changing your mind is ordinary. Its cells are
    // already omitted from `data`, but a lingering null source would assert a
    // phantom line item on a record that is written exactly once.
    await startTableReview();
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();

    const body = validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
    expect('rowSources' in body).toBe(false);
  });

  it('keeps an EXTRACTED row the reviewer emptied — that is a deliberate assertion', async () => {
    await startTableReview();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Line Items row 1 — Description' }),
      { target: { value: '' } },
    );
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();

    const body = validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
    expect(body.data['label:line_0_description|ptr:/line_items/0/description']).toBeNull();
    expect('rowSources' in body).toBe(false); // no row was added or removed
  });
});

describe('the review filter does not touch the payload', () => {
  const FILTER_NAME = 'Hide high-confidence fields';

  /** Submit once and hand back the exact body that went on the wire. */
  async function submitBody(filter: boolean): Promise<unknown> {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    renderVerification();
    await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    if (filter) {
      fireEvent.click(screen.getByRole('switch', { name: FILTER_NAME }));
      // The high-confidence field is now off-screen.
      expect(screen.queryByLabelText('Supplier Name')).toBeNull();
    }
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();
    return validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
  }

  // composeSubmission walks bindings and edits, never the DOM — so hiding a
  // field cannot drop it. Asserted as byte equality of the whole body rather
  // than a key count: composeSubmission omits unresolved untouched bindings,
  // so a count would pass even if the wrong fields went.
  /** A scored table, so filtering has rows to hide as well as a header. */
  async function submitTableBody(filter: boolean): Promise<any> {
    // Four columns: the classifier renders a NARROW array as entity cards and
    // only a wide one as a table, and this test is about table identities.
    const COLS = ['description', 'unit_of_measure', 'quantity', 'item_code'];
    getDocumentExtraction.mockResolvedValueOnce(extraction({
      meta: {
        processingStatus: 'success',
        validated: false,
        purgedAt: null,
        validationFeedback: {
          validationSchema: COLS.flatMap((c) => [
            `label:line_0_${c}|ptr:/line_items/0/${c}`,
            `label:line_1_${c}|ptr:/line_items/1/${c}`,
          ]),
        },
      },
      values: {
        line_items: [
          { description: 'A', unit_of_measure: 'UNIT', quantity: 1, item_code: 'X', confidence: 'high' },
          { description: 'B', unit_of_measure: 'BOX', quantity: 2, item_code: 'Y', confidence: 'medium' },
        ],
      },
    }));
    renderVerification();
    await screen.findByRole('table');
    if (filter) {
      fireEvent.click(screen.getByRole('switch', { name: FILTER_NAME }));
      // The high-confidence ROW is now off-screen — one data row left.
      expect(screen.getAllByRole('row')).toHaveLength(2); // header + row 2
    }
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();
    return validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
  }

  // Table identities differ from header ones — edit key, submit key and
  // extracted binding are three different things under a row plan — so a
  // hidden ROW needs its own proof, not just a hidden header.
  it('submits a hidden ROW\u2019s cells unchanged', async () => {
    const unfiltered = await submitTableBody(false);
    cleanup();
    getDocumentExtraction.mockReset();
    validateDocumentExtraction.mockReset();
    const filtered = await submitTableBody(true);

    expect(filtered).toEqual(unfiltered);
    // The hidden row's cells are genuinely present, not equal-by-absence.
    const keys = Object.keys((filtered as { data: Record<string, unknown> }).data);
    expect(keys).toEqual(expect.arrayContaining([
      'label:line_0_description|ptr:/line_items/0/description',
      'label:line_0_quantity|ptr:/line_items/0/quantity',
    ]));
  });

  it('submits a byte-identical body whether or not fields are hidden', async () => {
    const unfiltered = await submitBody(false);
    cleanup();
    getDocumentExtraction.mockReset();
    validateDocumentExtraction.mockReset();
    const filtered = await submitBody(true);

    expect(filtered).toEqual(unfiltered);
    // And the hidden field is genuinely IN there, not merely equal-by-absence.
    expect(JSON.stringify(filtered)).toContain('supplier_name');
  });
});

/**
 * BOTH review filters at once, against the payload (plan Task 6).
 *
 * The two above cover the confidence filter alone; verification-load.test.tsx
 * covers the column filter alone. Neither covers the state a reviewer actually
 * reaches — both switches on, rows AND columns off screen — and F1 is the
 * safety property the whole feature rests on, so the combination gets its own
 * proof rather than an argument that two independent results compose.
 */
describe('neither review filter touches the payload', () => {
  /**
   * The wide fixture (19 declared columns, 11 blank in every row) with the
   * first two rows scored `high`, so both switches are offered on one screen.
   * Confidence has to be synthesised — no locally reachable extraction runs
   * with `evaluation` on — and it goes on the ROW, which is the only unit an
   * `invoice_line_items` extraction has to score.
   */
  function scoredWide(): Record<string, unknown> {
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

  /** Submit the wide fixture once, both filters engaged or neither, and hand
   *  back the exact body that went on the wire. */
  async function submitWideBody(filters: boolean): Promise<Record<string, unknown>> {
    getDocumentExtraction.mockResolvedValueOnce(scoredWide());
    renderVerification();
    await screen.findByLabelText('Line Items row 1 — Description');
    if (filters) {
      fireEvent.click(screen.getByRole('switch', { name: 'Hide empty columns' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Hide high-confidence fields' }));
      // Non-vacuity, both axes: a blank COLUMN's cells are gone, and so is
      // every cell of the two high-confidence ROWS.
      expect(screen.queryByLabelText('Line Items row 3 — Barcode')).toBeNull();
      expect(screen.queryByLabelText('Line Items row 1 — Description')).toBeNull();
      expect(screen.getByLabelText('Line Items row 3 — Description')).toBeTruthy();
    }
    // The SAME correction in both arms, and deliberately AFTER the switches.
    //
    // Without it this test cannot see the likeliest shape of the defect it
    // exists for. `doSubmit` is a `useCallback` keyed on `submission`, so a
    // render-derived filter added to the body it sends — but whose new
    // dependency is not added to that list — reads a closure captured before
    // the switches were touched, drops nothing, and passes. It is not benign
    // in the app: the first keystroke after filtering rebuilds the callback
    // with the filter state live, and from then on the payload really is
    // missing rows. This repo has no ESLint, so the deps-omission form is the
    // form such a change would actually ship in (F14). Editing here makes both
    // arms compose their body from a post-filter closure.
    fireEvent.change(screen.getByLabelText('Line Items row 3 — Description'), {
      target: { value: 'Cable, 2m (rev B)' },
    });
    validateDocumentExtraction.mockResolvedValueOnce(VALIDATION_RESULT);
    await submitAndConfirm();
    return validateDocumentExtraction.mock.calls[0]![0].extractionValidationInDTO;
  }

  it('submits byte-identical payloads with both filters on and both off', async () => {
    const off = await submitWideBody(false);
    cleanup();
    getDocumentExtraction.mockReset();
    validateDocumentExtraction.mockReset();
    const on = await submitWideBody(true);

    // `toEqual` for the readable diff when it fails; `JSON.stringify` for the
    // claim actually being made — key ORDER too, which toEqual is blind to.
    expect(on).toEqual(off);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));

    // …and not equality-by-absence, in BOTH directions. `composeSubmission`
    // walks bindings and edits and never the DOM, so a cell that is off screen
    // for either reason is still on the wire.
    const data = (on as { data: Record<string, unknown> }).data;
    // A hidden COLUMN, on a row that is itself hidden.
    expect('label:line_0_barcode|ptr:/line_items/0/barcode' in data).toBe(true);
    expect(data['label:line_0_barcode|ptr:/line_items/0/barcode']).toBeNull();
    // A visible column of a hidden ROW, carrying its value verbatim.
    expect(data['label:line_0_description|ptr:/line_items/0/description'])
      .toBe('Widget housing, matte');
    // A hidden column of a VISIBLE row — the third quadrant, so the pass
    // cannot come from one axis happening to cover for the other.
    expect('label:line_2_barcode|ptr:/line_items/2/barcode' in data).toBe(true);
    // The fourth: a VISIBLE column of a VISIBLE row — and specifically the
    // cell edited above, which is the only one of the four whose value the
    // reviewer produced rather than the extraction.
    //
    // Load-bearing, not tidiness. That edit is what makes this test able to
    // see a render-derived submission body whose dependency was omitted from
    // `doSubmit` (see the change site), and `getByLabelText` throwing only
    // covers the input DISAPPEARING. A regression where the change event stops
    // registering as an edit — a readOnly flip while filtering, handler
    // rewiring — hits both arms identically, leaves `toEqual` and the
    // stringify comparison green, and silently disarms this test's best
    // protection with nothing going red. Asserting the string reached the wire
    // is what closes that.
    expect(data['label:line_2_description|ptr:/line_items/2/description'])
      .toBe('Cable, 2m (rev B)');
  });
});
