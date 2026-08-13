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

const CONFIRM_COPY =
  'Submit verification? This is final — feedback can be submitted only once and cannot be changed.';

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
  return screen.getByRole('button', { name: 'Submit feedback' }) as HTMLButtonElement;
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
    expect(screen.getByText('Feedback submitted')).toBeTruthy();
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
    expect(screen.getByText('Feedback submitted')).toBeTruthy();
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
    expect(screen.getByText('Feedback submitted')).toBeTruthy();
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
    expect(screen.getByText('Feedback submitted')).toBeTruthy();
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
