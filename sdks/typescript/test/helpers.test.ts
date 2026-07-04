import { describe, expect, it } from 'vitest';
import {
  GeminaClient,
  GeminaError,
  GeminaProcessingError,
  GeminaTimeoutError,
  ResponseError,
  ResponseStatus,
  type DocumentApi,
  type DocumentProcessingResultOutDTO,
  type ExtractionTypeModel,
} from '../src/index';

const CORRELATION_ID = 'corr-123';

function makeResult(
  status: ResponseStatus,
  correlationId: string | null = CORRELATION_ID,
): DocumentProcessingResultOutDTO {
  return {
    status,
    data: null,
    meta: { correlationId },
  };
}

interface FakeCalls {
  submitFile: unknown[];
  submitWeb: unknown[];
  polls: Array<{ correlationId: string }>;
}

/**
 * Fake at the generated-API boundary: implements only the three DocumentApi
 * methods the helper uses. `submitResult` is returned from either submit
 * endpoint; `pollResults` are returned in order (last one repeats forever).
 */
function makeFakeDocuments(
  submitResult: DocumentProcessingResultOutDTO,
  pollResults: DocumentProcessingResultOutDTO[],
): { documents: DocumentApi; calls: FakeCalls } {
  const calls: FakeCalls = { submitFile: [], submitWeb: [], polls: [] };
  const fake = {
    async createDocumentProcessingRequest(params: unknown) {
      calls.submitFile.push(params);
      return submitResult;
    },
    async createWebDocumentProcessingRequest(params: unknown) {
      calls.submitWeb.push(params);
      return submitResult;
    },
    async getDocumentProcessingResultByCorrelationId(params: { correlationId: string }) {
      calls.polls.push(params);
      const index = Math.min(calls.polls.length - 1, pollResults.length - 1);
      const result = pollResults[index];
      if (result === undefined) {
        throw new Error('fake DocumentApi: no poll results configured');
      }
      return result;
    },
  };
  return { documents: fake as unknown as DocumentApi, calls };
}

function makeClient(documents: DocumentApi): GeminaClient {
  return new GeminaClient('test-api-key', 'https://api.example.test', {
    apis: { documents },
  });
}

/** Instant fake sleep that records every requested wait (in seconds). */
function makeFakeSleep(): { sleepFn: (seconds: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleepFn: async (seconds: number) => {
      waits.push(seconds);
    },
  };
}

const EXTRACTION_TYPES: ExtractionTypeModel[] = ['invoice_headers'];
const BLOB_SOURCE = new Blob(['fake-image-bytes'], { type: 'image/png' });

describe('GeminaClient.processDocument', () => {
  it('happy path: submit, two non-terminal polls, then success', async () => {
    const success = makeResult(ResponseStatus.Success);
    const { documents, calls } = makeFakeDocuments(makeResult(ResponseStatus.Pending), [
      makeResult(ResponseStatus.InProcess),
      makeResult(ResponseStatus.InProcess),
      success,
    ]);
    const { sleepFn, waits } = makeFakeSleep();

    const result = await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5,
    });

    expect(result).toBe(success);
    expect(result.status).toBe(ResponseStatus.Success);
    // Submitted once via the file endpoint, never via the web endpoint.
    expect(calls.submitFile).toHaveLength(1);
    expect(calls.submitWeb).toHaveLength(0);
    // Polled with the correlationId from the submit response, once per wait.
    expect(calls.polls).toHaveLength(3);
    for (const poll of calls.polls) {
      expect(poll.correlationId).toBe(CORRELATION_ID);
    }
    expect(waits).toHaveLength(3);
  });

  it('passes file, extraction types and options through to the submit endpoint', async () => {
    const { documents, calls } = makeFakeDocuments(makeResult(ResponseStatus.Success), []);

    await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      externalId: 'my-external-id',
      endUserId: 'end-user-7',
      thinking: true,
    });

    expect(calls.submitFile).toHaveLength(1);
    expect(calls.submitFile[0]).toMatchObject({
      file: BLOB_SOURCE,
      extractionTypes: EXTRACTION_TYPES,
      externalId: 'my-external-id',
      endUserId: 'end-user-7',
      thinking: true,
    });
  });

  it('auto-generates an externalId when none is provided', async () => {
    const { documents, calls } = makeFakeDocuments(makeResult(ResponseStatus.Success), []);

    await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES);

    const params = calls.submitFile[0] as { externalId: string };
    expect(typeof params.externalId).toBe('string');
    expect(params.externalId.length).toBeGreaterThan(0);
  });

  it('terminal failed poll throws GeminaProcessingError carrying the result', async () => {
    const failed = makeResult(ResponseStatus.Failed);
    failed.errors = [{ code: 'processing_error', message: 'boom' }];
    const { documents } = makeFakeDocuments(makeResult(ResponseStatus.Pending), [failed]);
    const { sleepFn } = makeFakeSleep();

    const promise = makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5,
    });

    await expect(promise).rejects.toBeInstanceOf(GeminaProcessingError);
    await expect(promise).rejects.toBeInstanceOf(GeminaError);
    const error = (await promise.catch((e: unknown) => e)) as GeminaProcessingError;
    expect(error.result).toBe(failed);
    expect(error.result.errors).toEqual([{ code: 'processing_error', message: 'boom' }]);
  });

  it('already-failed submit response throws without polling', async () => {
    const failed = makeResult(ResponseStatus.Failed);
    const { documents, calls } = makeFakeDocuments(failed, []);

    await expect(
      makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES),
    ).rejects.toBeInstanceOf(GeminaProcessingError);
    expect(calls.polls).toHaveLength(0);
  });

  it('already-terminal submit response (partial) returns without polling', async () => {
    const partial = makeResult(ResponseStatus.Partial);
    const { documents, calls } = makeFakeDocuments(partial, []);

    const result = await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES);

    expect(result).toBe(partial);
    expect(calls.polls).toHaveLength(0);
  });

  it('timeout: never-terminal polls throw GeminaTimeoutError with correlationId and lastResult', async () => {
    const { documents, calls } = makeFakeDocuments(makeResult(ResponseStatus.Pending), [
      makeResult(ResponseStatus.InProcess),
    ]);
    const { sleepFn } = makeFakeSleep();

    // random=0.5 -> jitter factor 1.0 -> waits 2, 3, 4.5, ...
    // timeout 7s: waits 2 (total 2) and 3 (total 5) fit; 4.5 would cross -> throw.
    const promise = makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      timeoutSeconds: 7,
      sleepFn,
      random: () => 0.5,
    });

    await expect(promise).rejects.toBeInstanceOf(GeminaTimeoutError);
    const error = (await promise.catch((e: unknown) => e)) as GeminaTimeoutError;
    expect(error.correlationId).toBe(CORRELATION_ID);
    expect(error.lastResult?.status).toBe(ResponseStatus.InProcess);
    expect(calls.polls).toHaveLength(2);
  });

  it('backoff schedule: waits grow x1.5 from 2.0, capped at 15.0 (jitter factor pinned to 1.0)', async () => {
    const terminalAfter = 8;
    const pollResults = [
      ...Array.from({ length: terminalAfter - 1 }, () => makeResult(ResponseStatus.InProcess)),
      makeResult(ResponseStatus.Success),
    ];
    const { documents } = makeFakeDocuments(makeResult(ResponseStatus.Pending), pollResults);
    const { sleepFn, waits } = makeFakeSleep();

    await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5, // jitter factor = 0.8 + 0.4 * 0.5 = 1.0
    });

    const expected = [2.0, 3.0, 4.5, 6.75, 10.125, 15.0, 15.0, 15.0];
    expect(waits).toHaveLength(expected.length);
    waits.forEach((wait, i) => {
      expect(wait).toBeCloseTo(expected[i]!, 9);
    });
  });

  it('backoff jitter stays within [0.8, 1.2] of the nominal schedule', async () => {
    const terminalAfter = 10;
    const pollResults = [
      ...Array.from({ length: terminalAfter - 1 }, () => makeResult(ResponseStatus.InProcess)),
      makeResult(ResponseStatus.Success),
    ];
    const { documents } = makeFakeDocuments(makeResult(ResponseStatus.Pending), pollResults);
    const { sleepFn, waits } = makeFakeSleep();

    // Deterministic pseudo-random sequence spanning [0, 1).
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      timeoutSeconds: 10_000,
      sleepFn,
      random,
    });

    let nominal = 2.0;
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(0.8 * nominal - 1e-9);
      expect(wait).toBeLessThanOrEqual(1.2 * nominal + 1e-9);
      nominal = Math.min(nominal * 1.5, 15.0);
    }
    expect(waits).toHaveLength(terminalAfter);
  });

  it('URL source routes to the web endpoint with the same fields', async () => {
    const { documents, calls } = makeFakeDocuments(makeResult(ResponseStatus.Pending), [
      makeResult(ResponseStatus.Success),
    ]);
    const { sleepFn } = makeFakeSleep();

    const result = await makeClient(documents).processDocument(
      { url: 'https://example.com/invoice.pdf' },
      EXTRACTION_TYPES,
      { externalId: 'web-doc-1', sleepFn, random: () => 0.5 },
    );

    expect(result.status).toBe(ResponseStatus.Success);
    expect(calls.submitFile).toHaveLength(0);
    expect(calls.submitWeb).toHaveLength(1);
    expect(calls.submitWeb[0]).toMatchObject({
      webDocumentUploadInDTO: {
        url: 'https://example.com/invoice.pdf',
        externalId: 'web-doc-1',
        extractionTypes: EXTRACTION_TYPES,
      },
    });
  });

  it('rejects an empty extractionTypes list', async () => {
    const { documents } = makeFakeDocuments(makeResult(ResponseStatus.Success), []);

    await expect(makeClient(documents).processDocument(BLOB_SOURCE, [])).rejects.toBeInstanceOf(
      GeminaError,
    );
  });

  it('non-terminal submit response without correlationId throws GeminaError', async () => {
    const { documents } = makeFakeDocuments(makeResult(ResponseStatus.Pending, null), []);

    const promise = makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES);
    await expect(promise).rejects.toBeInstanceOf(GeminaError);
    await expect(promise).rejects.not.toBeInstanceOf(GeminaTimeoutError);
    await expect(promise).rejects.not.toBeInstanceOf(GeminaProcessingError);
  });
});

describe('GeminaClient.processDocument — failed result delivered as HTTP 500', () => {
  const FAILED_BODY = {
    status: 'failed',
    data: null,
    meta: { correlationId: CORRELATION_ID },
    errors: [{ error_code: 'PROCESSING_ERROR', description: 'boom' }],
  };

  function makeHttpError(body: unknown, status = 500): ResponseError {
    return new ResponseError(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
      'Response returned an error code',
    );
  }

  it('poll throwing ResponseError with a failed-result body becomes GeminaProcessingError immediately (no retry)', async () => {
    let polls = 0;
    const fake = {
      async createDocumentProcessingRequest() {
        return makeResult(ResponseStatus.Pending);
      },
      async getDocumentProcessingResultByCorrelationId() {
        polls++;
        throw makeHttpError(FAILED_BODY);
      },
    } as unknown as DocumentApi;
    const { sleepFn } = makeFakeSleep();

    const promise = makeClient(fake).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5,
    });

    await expect(promise).rejects.toBeInstanceOf(GeminaProcessingError);
    const error = (await promise.catch((e: unknown) => e)) as GeminaProcessingError;
    expect(error.result.status).toBe(ResponseStatus.Failed);
    expect(error.result.meta.correlationId).toBe(CORRELATION_ID);
    expect(error.result.errors).toEqual(FAILED_BODY.errors);
    expect(polls).toBe(1); // terminal failed — the transient-retry rule must not apply
  });

  it('submit throwing ResponseError with a failed-result body becomes GeminaProcessingError', async () => {
    const fake = {
      async createDocumentProcessingRequest() {
        throw makeHttpError(FAILED_BODY);
      },
    } as unknown as DocumentApi;

    const promise = makeClient(fake).processDocument(BLOB_SOURCE, EXTRACTION_TYPES);
    await expect(promise).rejects.toBeInstanceOf(GeminaProcessingError);
    const error = (await promise.catch((e: unknown) => e)) as GeminaProcessingError;
    expect(error.result.status).toBe(ResponseStatus.Failed);
  });

  it('persistent ResponseError with a non-result JSON body is retried, then rethrown unchanged', async () => {
    let polls = 0;
    const httpError = makeHttpError({ detail: 'Internal Server Error' });
    const fake = {
      async createDocumentProcessingRequest() {
        return makeResult(ResponseStatus.Pending);
      },
      async getDocumentProcessingResultByCorrelationId() {
        polls++;
        throw httpError;
      },
    } as unknown as DocumentApi;
    const { sleepFn } = makeFakeSleep();

    const promise = makeClient(fake).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5,
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBe(httpError);
    expect(error).not.toBeInstanceOf(GeminaProcessingError);
    expect(polls).toBe(3); // transient rule: 3 consecutive failures, then rethrow
  });

  it('ResponseError with a non-JSON body is rethrown unchanged', async () => {
    const httpError = new ResponseError(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      'Response returned an error code',
    );
    const fake = {
      async createDocumentProcessingRequest() {
        throw httpError;
      },
    } as unknown as DocumentApi;

    const error = await makeClient(fake)
      .processDocument(BLOB_SOURCE, EXTRACTION_TYPES)
      .catch((e: unknown) => e);
    expect(error).toBe(httpError);
  });

  it('non-ResponseError transport errors at submit pass through unwrapped (no retry)', async () => {
    let submits = 0;
    const transportError = new TypeError('fetch failed');
    const fake = {
      async createDocumentProcessingRequest() {
        submits++;
        throw transportError;
      },
    } as unknown as DocumentApi;

    const error = await makeClient(fake)
      .processDocument(BLOB_SOURCE, EXTRACTION_TYPES)
      .catch((e: unknown) => e);
    expect(error).toBe(transportError);
    expect(submits).toBe(1); // submit errors are never retried
  });
});

describe('GeminaClient.processDocument — transient poll failures are retried', () => {
  function make503(): ResponseError {
    return new ResponseError(
      new Response('upstream connect error', { status: 503 }),
      'Response returned an error code',
    );
  }

  /** Fake whose poll behavior is scripted per attempt: an Error instance throws, a result returns. */
  function makeScriptedPoll(script: Array<Error | DocumentProcessingResultOutDTO>): {
    documents: DocumentApi;
    polls: () => number;
  } {
    let attempt = 0;
    const fake = {
      async createDocumentProcessingRequest() {
        return makeResult(ResponseStatus.Pending);
      },
      async getDocumentProcessingResultByCorrelationId() {
        const step = script[Math.min(attempt, script.length - 1)];
        attempt++;
        if (step instanceof Error) {
          throw step;
        }
        return step;
      },
    };
    return { documents: fake as unknown as DocumentApi, polls: () => attempt };
  }

  it('two transient 503s then success: returns the result on the same backoff schedule', async () => {
    const success = makeResult(ResponseStatus.Success);
    const { documents, polls } = makeScriptedPoll([make503(), make503(), success]);
    const { sleepFn, waits } = makeFakeSleep();

    const result = await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5, // jitter factor 1.0
    });

    expect(result).toBe(success);
    expect(polls()).toBe(3);
    // Failed attempts keep the schedule growing: 2.0, 3.0, 4.5.
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeCloseTo(2.0, 9);
    expect(waits[1]).toBeCloseTo(3.0, 9);
    expect(waits[2]).toBeCloseTo(4.5, 9);
  });

  it('three consecutive transient errors: the third propagates as the same instance', async () => {
    const e1 = new TypeError('fetch failed (1)');
    const e2 = make503();
    const e3 = new TypeError('fetch failed (3)');
    const { documents, polls } = makeScriptedPoll([e1, e2, e3]);
    const { sleepFn } = makeFakeSleep();

    const error = await makeClient(documents)
      .processDocument(BLOB_SOURCE, EXTRACTION_TYPES, { sleepFn, random: () => 0.5 })
      .catch((e: unknown) => e);

    expect(error).toBe(e3);
    expect(polls()).toBe(3);
  });

  it('a successful poll resets the consecutive-failure counter', async () => {
    const success = makeResult(ResponseStatus.Success);
    const { documents, polls } = makeScriptedPoll([
      make503(),
      make503(),
      makeResult(ResponseStatus.InProcess), // success (non-terminal) — resets the counter
      make503(),
      make503(),
      success,
    ]);
    const { sleepFn } = makeFakeSleep();

    const result = await makeClient(documents).processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
      sleepFn,
      random: () => 0.5,
    });

    expect(result).toBe(success);
    expect(polls()).toBe(6); // 2 failures + reset + 2 failures never reach the 3-in-a-row limit
  });

  it('transient failures still respect the overall deadline (GeminaTimeoutError wins)', async () => {
    const { documents } = makeScriptedPoll([
      make503(),
      makeResult(ResponseStatus.InProcess),
      make503(),
      makeResult(ResponseStatus.InProcess),
    ]);
    const { sleepFn } = makeFakeSleep();

    // waits (jitter 1.0): 2 + 3 fit in 7s; the third wait (4.5) crosses -> timeout.
    const error = await makeClient(documents)
      .processDocument(BLOB_SOURCE, EXTRACTION_TYPES, {
        timeoutSeconds: 7,
        sleepFn,
        random: () => 0.5,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeminaTimeoutError);
    expect((error as GeminaTimeoutError).correlationId).toBe(CORRELATION_ID);
  });
});

describe('GeminaClient construction', () => {
  it('builds an API-key configuration with the given base URL (trailing slash stripped)', () => {
    const client = new GeminaClient('my-key', 'https://api.staging.gemina.co/');
    expect(client.configuration.basePath).toBe('https://api.staging.gemina.co');
    expect(client.configuration.apiKey).toBeDefined();
    expect(client.configuration.accessToken).toBeUndefined();
  });

  it('passes user-provided default headers through to the configuration', () => {
    const client = new GeminaClient('my-key', 'https://api.gemina.co', {
      headers: { 'X-Custom': 'yes' },
    });
    expect(client.configuration.headers).toEqual({ 'X-Custom': 'yes' });
  });

  it('defaults to the production base URL', () => {
    const client = new GeminaClient('my-key');
    expect(client.configuration.basePath).toBe('https://api.gemina.co');
  });

  it('withSessionToken builds a bearer-token configuration', async () => {
    const client = GeminaClient.withSessionToken('session-token', 'https://api.staging.gemina.co');
    expect(client.configuration.basePath).toBe('https://api.staging.gemina.co');
    expect(client.configuration.apiKey).toBeUndefined();
    // The generated client sends the accessToken value verbatim as the
    // Authorization header, so it must carry the "Bearer " scheme prefix.
    expect(await client.configuration.accessToken?.('OAuth2PasswordBearer', [])).toBe(
      'Bearer session-token',
    );
  });

  it('withSessionToken does not double an existing Bearer prefix', async () => {
    const client = GeminaClient.withSessionToken('Bearer already-prefixed');
    expect(await client.configuration.accessToken?.('OAuth2PasswordBearer', [])).toBe(
      'Bearer already-prefixed',
    );
  });

  it('exposes lazily-constructed generated API groups', () => {
    const client = new GeminaClient('my-key');
    expect(client.documents).toBe(client.documents);
    expect(client.retrieval).toBe(client.retrieval);
    expect(client.chat).toBeDefined();
    expect(client.templates).toBeDefined();
    expect(client.files).toBeDefined();
    expect(client.fileTag).toBeDefined();
    expect(client.sessions).toBeDefined();
    expect(client.subscriptions).toBeDefined();
    expect(client.billing).toBeDefined();
  });
});
