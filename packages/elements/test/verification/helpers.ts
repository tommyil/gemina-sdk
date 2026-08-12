/**
 * Shared helpers for the GeminaVerification component tests.
 */

/**
 * A ResponseError-shaped rejection whose `.response` behaves like the raw fetch
 * Response the SDK throws: a `status`, a `Retry-After` header, and a JSON body
 * carrying the standard `{ errors: [{ error_code, description }] }` envelope.
 * (Copied from chat.test.tsx so both widgets' tests share one error shape.)
 */
export function httpError(
  status: number,
  opts: { errorCode?: string; description?: string; retryAfter?: number } = {},
): Error {
  const error = new Error(`Response returned an error code (${status})`);
  const body =
    opts.errorCode !== undefined || opts.description !== undefined
      ? {
          status: 'failed',
          errors: [{ error_code: opts.errorCode, description: opts.description }],
        }
      : undefined;
  const response = {
    status,
    headers: {
      get(name: string): string | null {
        if (opts.retryAfter !== undefined && name.toLowerCase() === 'retry-after') {
          return String(opts.retryAfter);
        }
        return null;
      },
    },
    clone() {
      return this;
    },
    async json(): Promise<unknown> {
      if (body === undefined) {
        throw new Error('no body'); // mirrors an empty / non-JSON error body
      }
      return body;
    },
  };
  (error as unknown as { response: unknown }).response = response;
  return error;
}

export interface ExtractionFixtureOverrides {
  /** Shallow-merged into the default meta (set `validationFeedback: null` etc.). */
  meta?: Record<string, unknown>;
  /** Shallow-merged into the default document meta. */
  document?: Record<string, unknown>;
  /** Replaces the default values payload entirely (null/garbage allowed). */
  values?: unknown;
}

/** The default fixture's document image URL, exported for assertions. */
export const FIXTURE_IMAGE_URL = 'https://cdn.example.test/doc-1.png';

/**
 * A realistic `ExtractionPrimaryViewOutDTO`-shaped fixture.
 *
 * Deliberately camelCase VALUES against snake_case schema pointers — the prod
 * shape — so every load test exercises the casing-aware binding resolution
 * (review C1) end to end. `po_number` resolves nowhere: it is the standing
 * "model missed the whole field" binding that must land in Not detected.
 */
export function extraction(overrides: ExtractionFixtureOverrides = {}): Record<string, unknown> {
  return {
    status: 'success',
    createdAt: '2026-08-01T10:00:00Z',
    document: {
      documentId: 'doc-1',
      imageUrl: FIXTURE_IMAGE_URL,
      ...overrides.document,
    },
    meta: {
      processingStatus: 'success',
      validated: false,
      purgedAt: null,
      validationFeedback: {
        validationSchema: [
          'label:supplier_name|ptr:/supplier_name/value',
          'label:total_amount|ptr:/total_amount/value',
          'label:po_number|ptr:/po_number/value',
        ],
      },
      ...overrides.meta,
    },
    values:
      'values' in overrides
        ? overrides.values
        : {
            supplierName: {
              value: 'Acme Ltd',
              confidence: 'high',
              coordinates: {
                relative: [
                  [0.1, 0.1],
                  [0.4, 0.1],
                  [0.4, 0.15],
                  [0.1, 0.15],
                ],
              },
            },
            totalAmount: { value: 1500 },
          },
  };
}
