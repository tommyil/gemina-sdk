/**
 * <GeminaVerification> — Task 14: fetch, state machine, edge states;
 * Task 15: layout (stacked observer), flash wiring, RTL/theming, and the
 * silent image-URL refresh.
 *
 * Offline component tests with a mocked @gemina/sdk (chat.test.tsx idiom).
 * The fixture uses camelCase values against snake_case schema pointers, so
 * every happy-path assertion here also proves the C1 casing-aware binding
 * resolution end to end.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminaVerification } from '../../src/verification/index';
import { GeminaTokenManager } from '../../src/token-manager';
import { NO_EMPTY_COLUMNS } from '../../src/verification/empty-columns';
import type { EmptyColumns, EmptyColumnsInput } from '../../src/verification/empty-columns';
import { NO_PAIR_ERRORS } from '../../src/verification/form';
import type { VerificationFormProps } from '../../src/verification/form';
import { extraction, FIXTURE_IMAGE_URL, httpError, ResizeObserverStub } from './helpers';
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
 * Two TRANSPARENT recording seams for the empty-columns wiring (plan Task 3).
 *
 * Task 3 is state only — the switch that flips `hideEmptyColumns` arrives in
 * Task 5 and the column filtering in Task 4 — so nothing it computes reaches
 * the screen yet. The alternative to a seam would be inventing a UI to test
 * against, which would then have to be deleted; these two wrappers instead
 * observe what the component ALREADY hands its collaborators: the props the
 * form is rendered with, and the input the rule is computed from.
 *
 * Both delegate to the real implementation and re-export everything else
 * untouched (`withEmptyMutableTables` and `NO_EMPTY_COLUMNS` in particular —
 * index.tsx imports them from these same modules), so the rest of this file's
 * ~45 tests exercise exactly the code they did before.
 */
const { formRenders, emptyColumnsCalls } = vi.hoisted(() => ({
  formRenders: [] as VerificationFormProps[],
  // `touchedEver` is the component's LIVE ref-held Set, so a later keystroke
  // would mutate a call recorded earlier: snapshot its contents at call time.
  emptyColumnsCalls: [] as Array<{
    input: EmptyColumnsInput;
    touched: string[];
    result: EmptyColumns;
  }>,
}));

vi.mock('../../src/verification/form', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/verification/form')>();
  const RecordingForm = (props: VerificationFormProps) => {
    formRenders.push(props);
    return <actual.VerificationForm {...props} />;
  };
  return { ...actual, VerificationForm: RecordingForm };
});

vi.mock('../../src/verification/empty-columns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/verification/empty-columns')>();
  return {
    ...actual,
    computeEmptyColumns: (input: EmptyColumnsInput) => {
      const result = actual.computeEmptyColumns(input);
      emptyColumnsCalls.push({ input, touched: [...input.touchedEver], result });
      return result;
    },
  };
});

/** The props of the LAST render of the form. */
function lastFormProps(): VerificationFormProps {
  const props = formRenders.at(-1);
  if (props === undefined) {
    throw new Error('VerificationForm was never rendered');
  }
  return props;
}

/** The LAST `computeEmptyColumns` call: its input, its touched-ever set
 *  snapshotted, and what the rule returned for it. */
function lastEmptyColumnsCall(): {
  input: EmptyColumnsInput;
  touched: string[];
  result: EmptyColumns;
} {
  const call = emptyColumnsCalls.at(-1);
  if (call === undefined) {
    throw new Error('computeEmptyColumns was never called');
  }
  return call;
}

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

/** Drain the promise chain of an in-flight (mocked, timerless) fetch. */
function flushMicrotasks(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

afterEach(() => {
  cleanup();
  getDocumentExtraction.mockReset();
  validateDocumentExtraction.mockReset();
  withSessionToken.mockClear();
  formRenders.length = 0;
  emptyColumnsCalls.length = 0;
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

  it('carries the base + auto-theme classes and an explicit dir attribute by default', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();

    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    expect(root.className).toContain('gemina-verification--auto');
    expect(root.getAttribute('dir')).toBe('ltr');
    expect(root.className).not.toContain('gemina-verification--rtl');
  });
});

describe('GeminaVerification — direction (chat-parity Hebrew autodetect)', () => {
  /** Hebrew supplier value — reaches the bindings through /supplier_name/value. */
  const HEBREW_VALUES = {
    supplierName: { value: 'אקמי בע"מ', confidence: 'high' },
    totalAmount: { value: 1500 },
  };

  it('dir="auto" flips to RTL when a bound extracted value contains Hebrew', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ values: HEBREW_VALUES }));
    const { container } = renderVerification();

    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.className).toContain('gemina-verification--rtl');
  });

  it('an explicit dir="ltr" wins over Hebrew content', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ values: HEBREW_VALUES }));
    const { container } = renderVerification({ dir: 'ltr' });

    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    expect(root.getAttribute('dir')).toBe('ltr');
    expect(root.className).not.toContain('gemina-verification--rtl');
  });

  it('dir="rtl" forces RTL without any Hebrew content', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification({ dir: 'rtl' });

    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.className).toContain('gemina-verification--rtl');
  });
});

describe('GeminaVerification — detection overlays (viewer relativeRects)', () => {
  /** Two coordinate-bearing header fields — the overlay set must carry both. */
  const COORD_VALUES = {
    supplierName: {
      value: 'Acme Ltd',
      coordinates: {
        relative: [
          [0.1, 0.1],
          [0.4, 0.1],
          [0.4, 0.15],
          [0.1, 0.15],
        ],
      },
    },
    totalAmount: {
      value: 1500,
      coordinates: {
        relative: [
          [0.5, 0.6],
          [0.7, 0.6],
          [0.7, 0.65],
          [0.5, 0.65],
        ],
      },
    },
  };

  it('collects every field coordinate for the viewer: toggle enabled, boxes render', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction({ values: COORD_VALUES }));
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');

    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    // Boxes render in image space once the natural size is known.
    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 2000, configurable: true });
    fireEvent.load(img);

    fireEvent.click(toggle);
    expect(container.querySelectorAll('.gemina-verification__rect').length).toBe(2);
  });

  it('a load with no coordinates anywhere leaves the overlay toggle disabled', async () => {
    getDocumentExtraction.mockResolvedValueOnce(
      extraction({
        values: { supplierName: { value: 'Acme Ltd' }, totalAmount: { value: 1500 } },
      }),
    );
    renderVerification();
    await screen.findByLabelText('Supplier Name');

    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('GeminaVerification — eye-click flash wiring', () => {
  beforeEach(() => {
    ResizeObserverStub.instances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /**
   * Real-timer load + viewer sizing first, THEN fake timers + the viewer
   * tests' rAF shim (the travel/fade loops measure elapsed via Date.now(),
   * so Date must be faked alongside the setTimeout-backed rAF).
   */
  async function mountFlashReady() {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const utils = renderVerification();
    await screen.findByLabelText('Supplier Name');

    const img = utils.container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 2000, configurable: true });
    fireEvent.load(img);
    ResizeObserverStub.forClass('gemina-verification__canvas').resizeTo(500, 500);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    return utils;
  }

  it('an eye click flashes the field rect on the viewer; completion clears it; a re-click re-flashes', async () => {
    const { container } = await mountFlashReady();

    // Only supplierName carries coordinates in the fixture → exactly one eye.
    fireEvent.click(screen.getByRole('button', { name: 'Show on document' }));
    const rect = container.querySelector<HTMLElement>('.gemina-verification__flash-rect');
    expect(rect).not.toBeNull();
    expect(Number(rect!.style.opacity)).toBe(1);

    // The fade completes at 1500ms → the viewer clears the rect and the
    // root's onFlashComplete nulls its flash state.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();

    // Fresh-array contract: the SAME eye clicked again must flash again (a
    // root holding a stale identical reference would never restart the flash).
    fireEvent.click(screen.getByRole('button', { name: 'Show on document' }));
    expect(container.querySelector('.gemina-verification__flash-rect')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
  });

  it('a rapid second click mid-flash restarts from full opacity', async () => {
    const { container } = await mountFlashReady();

    fireEvent.click(screen.getByRole('button', { name: 'Show on document' }));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const mid = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(mid.style.opacity)).toBeLessThan(1);

    fireEvent.click(screen.getByRole('button', { name: 'Show on document' }));
    const restarted = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(restarted.style.opacity)).toBe(1);
  });
});

describe('GeminaVerification — image URL expiry (silent refresh)', () => {
  const REFRESHED_URL = 'https://cdn.example.test/doc-1.png?token=fresh';

  /** Arm the viewer's expiry gate: the current src has loaded successfully. */
  function armImage(container: HTMLElement): HTMLImageElement {
    const img = container.querySelector('img')!;
    fireEvent.load(img);
    return img as HTMLImageElement;
  }

  it('swaps ONLY the img src after an expiry refetch — data, phase and inputs untouched', async () => {
    getDocumentExtraction
      .mockResolvedValueOnce(extraction())
      // The refreshed view arrives with DIFFERENT values and validated:true —
      // none of which may leak into the review (URL-only swap contract).
      .mockResolvedValueOnce(
        extraction({
          document: { imageUrl: REFRESHED_URL },
          meta: { validated: true },
          values: { supplierName: { value: 'Poisoned Co' }, totalAmount: { value: 9999 } },
        }),
      );
    const { container, onError } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const img = armImage(container);

    fireEvent.error(img);
    // Silent: no loading phase flash while the refetch is in flight.
    expect(container.querySelector('.gemina-verification__state')).toBeNull();

    await waitFor(() => expect(img.getAttribute('src')).toBe(REFRESHED_URL));
    expect(getDocumentExtraction).toHaveBeenCalledTimes(2);
    // Same loaded snapshot: the original value, still an editable input (the
    // refreshed validated:true must NOT flip the form read-only), no banner.
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd');
    expect(container.querySelector('.gemina-verification__state')).toBeNull();
    expect(container.querySelector('.gemina-verification__banner')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('throttles: a second expiry 5s later does not refetch; the window reopens after 60s', async () => {
    getDocumentExtraction
      .mockResolvedValueOnce(extraction())
      .mockResolvedValue(extraction({ document: { imageUrl: REFRESHED_URL } }));
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const img = armImage(container);

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      fireEvent.error(img);
      await flushMicrotasks();
      expect(getDocumentExtraction).toHaveBeenCalledTimes(2);
      expect(img.getAttribute('src')).toBe(REFRESHED_URL);

      // Re-arm (the refreshed URL loads), then die again 5s later → throttled.
      fireEvent.load(img);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      fireEvent.error(img);
      await flushMicrotasks();
      expect(getDocumentExtraction).toHaveBeenCalledTimes(2);

      // 60s past the first refresh the throttle window reopens.
      act(() => {
        vi.advanceTimersByTime(56_000);
      });
      fireEvent.load(img);
      fireEvent.error(img);
      await flushMicrotasks();
      expect(getDocumentExtraction).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an img error when the image never loaded does not refetch (root-side pin)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');

    // No load event ever fired — the viewer's gate holds, the root never refetches.
    fireEvent.error(container.querySelector('img')!);
    await flushMicrotasks();
    expect(getDocumentExtraction).toHaveBeenCalledTimes(1);
  });

  it('an expiry refetch that rejects leaves the review intact (swallowed, no onError)', async () => {
    getDocumentExtraction
      .mockResolvedValueOnce(extraction())
      .mockRejectedValueOnce(httpError(500));
    const { container, onError } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const img = armImage(container);

    fireEvent.error(img);
    await flushMicrotasks();

    expect(getDocumentExtraction).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Acme Ltd');
    expect(container.querySelector('.gemina-verification__state')).toBeNull();
    expect(img.getAttribute('src')).toBe(FIXTURE_IMAGE_URL);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('GeminaVerification — stale load protection', () => {
  it('a load that lost the race to an extractionId change never writes (data or onError)', async () => {
    let resolveA!: (view: unknown) => void;
    getDocumentExtraction
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }))
      .mockResolvedValueOnce(
        extraction({
          values: { supplierName: { value: 'Bravo Industries' }, totalAmount: { value: 42 } },
        }),
      );
    const { tokenManager } = makeManager();
    const onError = vi.fn();
    const { rerender } = render(
      <GeminaVerification extractionId="ext-A" tokenManager={tokenManager} onError={onError} />,
    );
    // Let load A get its call in flight (deferred, unresolved) …
    await flushMicrotasks();
    expect(getDocumentExtraction).toHaveBeenCalledTimes(1);

    // … then switch extractions while A is still pending.
    rerender(
      <GeminaVerification extractionId="ext-B" tokenManager={tokenManager} onError={onError} />,
    );
    expect(
      (await screen.findByLabelText<HTMLInputElement>('Supplier Name')).value,
    ).toBe('Bravo Industries');

    // A resolves LATE as purged — a failed stale guard would flip the phase
    // to unavailable AND fire onError('purged').
    resolveA(extraction({ meta: { purgedAt: '2026-08-10T00:00:00Z' } }));
    await flushMicrotasks();
    expect(screen.getByLabelText<HTMLInputElement>('Supplier Name').value).toBe('Bravo Industries');
    expect(screen.queryByText('Document no longer available (retention policy).')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('GeminaVerification — stacked layout (root width observer)', () => {
  beforeEach(() => {
    ResizeObserverStub.instances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toggles --stacked below 860px of ROOT width (both boundary sides); disconnects on unmount', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container, unmount } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    const ro = ResizeObserverStub.forClass('gemina-verification');
    expect(root.className).not.toContain('gemina-verification--stacked');

    ro.resizeTo(859, 700);
    expect(root.className).toContain('gemina-verification--stacked');

    ro.resizeTo(860, 700);
    expect(root.className).not.toContain('gemina-verification--stacked');

    ro.resizeTo(320, 700);
    expect(root.className).toContain('gemina-verification--stacked');

    unmount();
    expect(ro.disconnected).toBe(true);
  });

  it('reads the BORDER box, not contentRect: 880 border / 840 content is two-column', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;
    const ro = ResizeObserverStub.forClass('gemina-verification');

    // Prove the dispatch reaches the live observer at all…
    ro.resizeTo(500, 700);
    expect(root.className).toContain('gemina-verification--stacked');

    // …then a padded host where the boxes disagree: border box 880 (≥ 860),
    // content box 840 (< 860). Border-box semantics keep two columns — a
    // revert to contentRect would stack here and fail.
    ro.resizeToBoxes(880, 840);
    expect(root.className).not.toContain('gemina-verification--stacked');
  });

  it('a zero-width measurement (hidden/unmeasured host) never forces stacking', async () => {
    getDocumentExtraction.mockResolvedValueOnce(extraction());
    const { container } = renderVerification();
    await screen.findByLabelText('Supplier Name');
    const root = container.querySelector('.gemina-verification')!;

    ResizeObserverStub.forClass('gemina-verification').resizeTo(0, 0);
    expect(root.className).not.toContain('gemina-verification--stacked');
  });
});

/**
 * "Hide empty columns" — Task 3: the state, the reset and the memo that feeds
 * them. The switch itself is Task 5 and the column filtering is Task 4, so
 * everything here is asserted through the two recording seams at the top of
 * this file rather than through the screen.
 */
describe('GeminaVerification — empty columns (state, reset, and what the rule is fed)', () => {
  /** The synthetic wide table, with row 1 half-filling the unit-size pair. */
  function pairErrorExtraction(options: { validated?: boolean } = {}): Record<string, unknown> {
    const view = wideTableExtraction();
    const values = view.values as Record<string, unknown>;
    const rows = values.line_items as Array<Record<string, unknown>>;
    // `unitSizeUom` stays null beside it — the trap §S is built around: the
    // blank half is what blocks Submit, so it must not be hidden.
    const firstRow = rows[0];
    if (firstRow === undefined) {
      throw new Error('the wide fixture must have at least one row');
    }
    firstRow.unitSize = 5;
    if (options.validated === true) {
      (view.meta as Record<string, unknown>).validated = true;
    }
    return view;
  }

  /** The edit key of row 1's `barcode` cell — `cellEditKey`, the ROW-plan
   *  spelling, not the schema key: a planned cell is keyed by its row id so it
   *  survives an insert above it. */
  const BARCODE_KEY = 'cell:/line_items#row-0|col:barcode';

  it('starts OFF: the form is handed the SHARED sentinel, and every blank column still renders', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    renderVerification();

    // Not vacuous: this fixture is 8 populated / 11 blank of 19 columns (the
    // shape Task 0 measured in prod), and `barcode` is one of the blank ones —
    // on screen, unfiltered, because the filter is off until a reviewer says
    // otherwise. `toBe`, not `toEqual`: a fresh `new Map()` per render would
    // defeat the section memos downstream.
    await screen.findByLabelText('Line Items row 1 — Description');
    expect(screen.getByText('Barcode')).toBeTruthy();
    expect(lastFormProps().emptyColumns).toBe(NO_EMPTY_COLUMNS);

    // …and the rule really did find columns to hide, end to end through the
    // component's own bindings, row plan and column lists — so the sentinel
    // above is the GATE's doing, not an empty result. (This is also the only
    // place the wiring is checked against the rule's OUTPUT: all 11 blank
    // columns of the 19, and not one populated one.)
    const { result } = lastEmptyColumnsCall();
    const hidden = result.get('/line_items');
    expect(hidden === undefined ? [] : [...hidden].sort()).toEqual([
      'barcode', 'deposit_amount', 'discount_amount', 'list_price', 'package_quantity',
      'packaging_amount', 'tax_amount', 'tax_rate', 'unit_size', 'unit_size_uom',
      'units_per_package',
    ]);
    // `discount_percentage` is populated on ONE row of four and blank on the
    // rest — the sparse-column case F15 measured 276 of in prod.
    expect(hidden?.has('discount_percentage')).toBe(false);
  });

  it('feeds the rule the RENDERED tables — including a zero-row table the classifier never saw', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction({ rows: 0 }));
    renderVerification();

    // `line_items: []` classifies as no table at all; `withEmptyMutableTables`
    // promotes it back so the reviewer can type the first line into it. Passing
    // `classified.tables` here instead would make the rule blind to it.
    await screen.findByText(/Line Items \(0 rows\)/);
    const { input } = lastEmptyColumnsCall();
    expect(input.tables.map((table) => table.pointer)).toContain('/line_items');
    expect(input.rowMutableTables.map((table) => table.pointer)).toEqual(['/line_items']);
    expect(input.plannedTables.has('/line_items')).toBe(true);
    expect(input.bindingIndex.size).toBeGreaterThan(0);
  });

  it('keeps a reverted cell in touched-ever — the edit is deleted, the touch is not (F11)', async () => {
    getDocumentExtraction.mockResolvedValueOnce(wideTableExtraction());
    const { container } = renderVerification();

    const barcode = await screen.findByLabelText<HTMLInputElement>('Line Items row 1 — Barcode');
    const before = emptyColumnsCalls.length;
    fireEvent.change(barcode, { target: { value: '7290000000001' } });
    // The memo re-runs as the reviewer types — that is what makes a column
    // stay visible under the cursor once Task 5 can turn the filter on.
    expect(emptyColumnsCalls.length).toBeGreaterThan(before);
    expect(lastEmptyColumnsCall().touched).toEqual([BARCODE_KEY]);

    // Back to the pristine string: `handleEdit` DELETES the edit (the progress
    // line is the proof — 0 corrected again)…
    fireEvent.change(barcode, { target: { value: '' } });
    expect(
      container.querySelector('.gemina-verification__progress')?.textContent,
    ).toContain('0 corrected');
    // …and touched-ever still holds the key. Handing the rule `edits` instead
    // of the ref-held set would drop it here and unmount the column.
    expect(lastEmptyColumnsCall().touched).toEqual([BARCODE_KEY]);
    // Still gated off, throughout.
    expect(lastFormProps().emptyColumns).toBe(NO_EMPTY_COLUMNS);
  });

  it('clears touched-ever when the extraction changes — a view mode belongs to ONE extraction', async () => {
    getDocumentExtraction.mockResolvedValue(wideTableExtraction());
    const { rerender, tokenManager } = renderVerification();

    const barcode = await screen.findByLabelText<HTMLInputElement>('Line Items row 1 — Barcode');
    fireEvent.change(barcode, { target: { value: '7290000000001' } });
    expect(lastEmptyColumnsCall().touched).toEqual([BARCODE_KEY]);

    rerender(
      <GeminaVerification extractionId="ext-2" tokenManager={tokenManager} />,
    );
    await flushMicrotasks();
    await screen.findByLabelText('Line Items row 1 — Barcode');
    // A touch carried across would keep a column of the NEXT extraction
    // visible for a cell the reviewer never saw.
    expect(lastEmptyColumnsCall().touched).toEqual([]);
  });

  it('feeds the rule the live pair errors while the extraction is still editable', async () => {
    getDocumentExtraction.mockResolvedValueOnce(pairErrorExtraction());
    renderVerification();

    await screen.findByLabelText('Line Items row 1 — Unit Size');
    // Both halves are keyed, and this is the non-vacuity the read-only test
    // below leans on: the SAME fixture produces errors when it is editable.
    const { input } = lastEmptyColumnsCall();
    expect(input.pairErrors.size).toBe(2);
    expect([...input.pairErrors.keys()].some((key) => key.includes('unit_size_uom'))).toBe(true);
  });

  it('drops the pair-error clause in read-only mode (§D5) — the same fixture, no errors', async () => {
    getDocumentExtraction.mockResolvedValueOnce(pairErrorExtraction({ validated: true }));
    renderVerification();

    await screen.findByText('Already verified — showing the original extraction.');
    // The BEHAVIOUR: the same fixture that produced two pair errors above
    // produces none here. Nothing renders an error in read-only mode and
    // Submit is permanently disabled, so keeping a blank pair-partner visible
    // would be a rule with no observable reason.
    const { input } = lastEmptyColumnsCall();
    expect(input.pairErrors.size).toBe(0);
    // A ride-along on the emptiness above, NOT a contract: nothing downstream
    // compares this map by reference (`areRowPropsEqual` excludes it on
    // purpose). It pins only that the root reuses the form's one "no row
    // errors" instance rather than minting a map per render.
    expect(input.pairErrors).toBe(NO_PAIR_ERRORS);
  });

  /**
   * The six tests the plan names for this task all press the switch, and the
   * switch is Task 5. They are pinned here by name — with the state they need
   * already built and reset — rather than rewritten into something weaker that
   * would pass whatever Task 5 does.
   */
  it.todo('offers no empty-columns switch when every column is populated — needs Task 5');
  it.todo('offers the switch when a table has an all-blank column — needs Task 5');
  it.todo('hides the columns only after the switch is pressed — needs Task 5');
  it.todo('resets the switch when the extraction id changes — needs Task 5');
  it.todo('keeps the switch mounted while engaged, even when nothing qualifies — needs Task 5');
  it.todo('leaves the submitted payload identical whether the filter is on or off — needs Task 5');
});
