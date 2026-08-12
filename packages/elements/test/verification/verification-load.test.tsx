/**
 * <GeminaVerification> — Task 14: fetch, state machine, edge states.
 *
 * Offline component tests with a mocked @gemina/sdk (chat.test.tsx idiom).
 * The fixture uses camelCase values against snake_case schema pointers, so
 * every happy-path assertion here also proves the C1 casing-aware binding
 * resolution end to end.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { extraction, FIXTURE_IMAGE_URL, httpError } from './helpers';

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
  const utils = render(
    <GeminaVerification
      extractionId="ext-1"
      tokenManager={tokenManager}
      onError={onError}
      {...extraProps}
    />,
  );
  return { ...utils, tokenManager, fetchToken, onError };
}

afterEach(() => {
  cleanup();
  getDocumentExtraction.mockReset();
  validateDocumentExtraction.mockReset();
  withSessionToken.mockClear();
});

describe('GeminaVerification — loading', () => {
  it('shows the loading state while the fetch is in flight', () => {
    getDocumentExtraction.mockReturnValueOnce(new Promise(() => {})); // never settles
    const { container } = renderVerification();

    const state = container.querySelector('.gemina-verification__state');
    expect(state?.textContent).toBe('Loading extraction…');
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('GeminaVerification — happy load (camel values, snake schema pointers)', () => {
  it('renders the two panes: viewer image and bound form inputs', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container, fetchToken, onError } = renderVerification({
      baseUrl: 'https://api.example.test',
    });

    // Casing path (C1): /supplier_name/value resolved against camel payload.
    const supplier = await screen.findByLabelText<HTMLInputElement>('Supplier Name');
    expect(supplier.value).toBe('Acme Ltd');
    // RAW prefill, never locale-formatted (toInputString contract).
    expect(screen.getByLabelText<HTMLInputElement>('Total Amount').value).toBe('1500');

    // Viewer pane: the main document image at the fixture URL.
    expect(screen.getByAltText<HTMLImageElement>('Document').getAttribute('src')).toBe(
      FIXTURE_IMAGE_URL,
    );
    expect(container.querySelector('.gemina-verification__panes')).toBeTruthy();
    expect(container.querySelector('.gemina-verification__banner')).toBeNull();

    // Token from the manager (a JWT, never an API key), base URL forwarded.
    expect(fetchToken).toHaveBeenCalledTimes(1);
    const [token, baseUrl] = withSessionToken.mock.calls[0] ?? [];
    expect(token?.split('.')).toHaveLength(3);
    expect(baseUrl).toBe('https://api.example.test');
    expect(getDocumentExtraction).toHaveBeenCalledWith({ documentExtractionId: 'ext-1' });

    expect(onError).not.toHaveBeenCalled();
  });

  it('renders bindings that matched no rendered field in "Not detected"', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    renderVerification();

    await screen.findByText('Not detected');
    // Schema labels render verbatim (already human text, no formatLabel).
    expect(screen.getByText('po_number')).toBeTruthy();
    const missed = screen.getByLabelText<HTMLInputElement>('po_number');
    expect(missed.value).toBe('');
    expect(missed.placeholder).toBe('Not detected — fill in if present');
  });

  it('omits the viewer pane when the document has no imageUrl', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ document: { imageUrl: null } }));
    const { container } = renderVerification();

    await screen.findByLabelText('Supplier Name');
    expect(container.querySelector('.gemina-verification__panes')).toBeTruthy();
    expect(container.querySelector('.gemina-verification__viewer')).toBeNull();
  });
});

describe('GeminaVerification — result mapping (meta-derived edge states)', () => {
  it('purgedAt set → purged, even when processingStatus also failed (purge before status)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(
      extraction({ meta: { purgedAt: new Date('2026-08-10T00:00:00Z'), processingStatus: 'failed' } }),
    );
    const { onError } = renderVerification();

    expect(
      await screen.findByText('Document no longer available (retention policy).'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('purged', undefined);
  });

  it.each(['failed', 'partial', 'pending'])(
    'processingStatus %s → not-completed',
    async (processingStatus) => {
      getDocumentExtraction.mockResolvedValueOnce(extraction({ meta: { processingStatus } }));
      const { onError } = renderVerification();

      expect(
        await screen.findByText('This extraction did not complete, so there is nothing to verify.'),
      ).toBeTruthy();
      expect(onError).toHaveBeenCalledWith('not-completed', undefined);
    },
  );

  it('validated → read-only review with the banner, and NO onError', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ meta: { validated: true } }));
    const { container, onError } = renderVerification();

    expect(
      await screen.findByText('Already verified — showing the original extraction.'),
    ).toBeTruthy();
    expect(container.querySelector('.gemina-verification__banner')).toBeTruthy();
    // Read-only: values render as text, never as inputs.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Acme Ltd')).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it('validated with a null schema → STILL read-only review (validated before schema)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(
      extraction({ meta: { validated: true, validationFeedback: null } }),
    );
    const { onError } = renderVerification();

    expect(
      await screen.findByText('Already verified — showing the original extraction.'),
    ).toBeTruthy();
    expect(screen.queryByText("Verification isn't available for this extraction.")).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['validationFeedback null', { validationFeedback: null }],
    ['validationSchema empty', { validationFeedback: { validationSchema: [] } }],
  ])('%s → verification-unavailable', async (_label, meta) => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ meta }));
    const { onError } = renderVerification();

    expect(
      await screen.findByText("Verification isn't available for this extraction."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(onError).toHaveBeenCalledWith('verification-unavailable', undefined);
  });
});

describe('GeminaVerification — fetch errors', () => {
  it('404 → not-available, no Retry, detail carries the envelope', async () => {
    getDocumentExtraction.mockRejectedValueOnce(
      httpError(404, { errorCode: 'NOT_FOUND_ERROR', description: 'No such extraction.' }),
    );
    const { onError } = renderVerification();

    expect(await screen.findByText('This extraction is not available.')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('not-available', {
      status: 404,
      errorCode: 'NOT_FOUND_ERROR',
      description: 'No such extraction.',
    });
  });

  it('5xx → load-failed with a Retry button', async () => {
    getDocumentExtraction.mockRejectedValueOnce(httpError(500));
    const { onError } = renderVerification();

    expect(await screen.findByText("Couldn't load the extraction.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(
      'load-failed',
      expect.objectContaining({ status: 500 }),
    );
  });

  it('a network-level failure (no response) → load-failed with a Retry', async () => {
    getDocumentExtraction.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { onError } = renderVerification();

    expect(await screen.findByText("Couldn't load the extraction.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(
      'load-failed',
      expect.objectContaining({ status: undefined }),
    );
  });

  it('a tokenManager whose mint rejects (no HTTP status) → load-failed', async () => {
    const tokenManager = new GeminaTokenManager({
      fetchToken: vi.fn(async () => {
        throw new Error('tenant backend down');
      }),
    });
    const onError = vi.fn();
    render(
      <GeminaVerification extractionId="ext-1" tokenManager={tokenManager} onError={onError} />,
    );

    expect(await screen.findByText("Couldn't load the extraction.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(getDocumentExtraction).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'load-failed',
      expect.objectContaining({ status: undefined }),
    );
  });
});

describe('GeminaVerification — 401 handling (invalidate + retry once)', () => {
  it('401 then success: re-mints, retries once, loads fine — no error UI', async () => {
    getDocumentExtraction
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce(extraction());
    const { fetchToken, onError } = renderVerification();

    expect(await screen.findByLabelText('Supplier Name')).toBeTruthy();
    // Two mints (initial + post-invalidate), two clients, different tokens.
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(withSessionToken).toHaveBeenCalledTimes(2);
    expect(withSessionToken.mock.calls[0]?.[0]).not.toBe(withSessionToken.mock.calls[1]?.[0]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('401 twice → session-expired, stops retrying, no Retry button', async () => {
    getDocumentExtraction
      .mockRejectedValueOnce(httpError(401))
      .mockRejectedValueOnce(httpError(401));
    const { fetchToken, onError } = renderVerification();

    expect(
      await screen.findByText('Session expired — please reload the page or sign in again.'),
    ).toBeTruthy();
    expect(getDocumentExtraction).toHaveBeenCalledTimes(2); // exactly one retry
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'session-expired',
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe('GeminaVerification — Retry', () => {
  it('re-runs the load and can succeed', async () => {
    getDocumentExtraction
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce(extraction());
    renderVerification();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Supplier Name')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getDocumentExtraction).toHaveBeenCalledTimes(2);
  });

  it('a retry that fails again RE-FIRES onError (once per terminal-state entry)', async () => {
    getDocumentExtraction
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(503));
    const { onError } = renderVerification();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenNthCalledWith(
      1,
      'load-failed',
      expect.objectContaining({ status: 500 }),
    );
    expect(onError).toHaveBeenNthCalledWith(
      2,
      'load-failed',
      expect.objectContaining({ status: 503 }),
    );
  });
});

describe('GeminaVerification — chrome', () => {
  it('injects the verification stylesheet once and applies theme + className', async () => {
    getDocumentExtraction.mockResolvedValue(extraction());
    const { container } = renderVerification({ theme: 'dark', className: 'host-class' });
    renderVerification();

    await screen.findAllByLabelText('Supplier Name');
    const styles = document.head.querySelectorAll('style[data-gemina-verification]');
    expect(styles.length).toBe(1);
    const root = container.querySelector('.gemina-verification');
    expect(root?.className).toContain('gemina-verification--dark');
    expect(root?.className).toContain('host-class');
  });

  it('classifyData is total: null values still render the review shell', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ values: null }));
    const { container, onError } = renderVerification();

    // Nothing classified, nothing matched — all three schema keys land in
    // Not detected as fill-in inputs.
    await screen.findByText('Not detected');
    expect(container.querySelector('.gemina-verification__panes')).toBeTruthy();
    expect(screen.getByLabelText('supplier_name')).toBeTruthy();
    expect(screen.getByLabelText('total_amount')).toBeTruthy();
    expect(screen.getByLabelText('po_number')).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });
});
