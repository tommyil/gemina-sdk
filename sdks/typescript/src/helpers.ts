import {
  BillingApi,
  ChatApi,
  Configuration,
  DocumentApi,
  DocumentProcessingResultOutDTOFromJSON,
  FilesApi,
  FileTagApi,
  ResponseError,
  RetrievalApi,
  SessionsApi,
  SubscriptionsApi,
  TemplatesApi,
  ResponseStatus,
  type DocumentProcessingResultOutDTO,
  type ExtractionTypeModel,
  type FetchAPI,
  type HTTPHeaders,
  type Middleware,
  type ModelType,
} from './generated';
import { GeminaError, GeminaProcessingError, GeminaTimeoutError } from './errors';

/** Default Gemina API base URL. */
export const DEFAULT_BASE_URL = 'https://api.gemina.co';

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_INITIAL_INTERVAL_SECONDS = 2.0;
const DEFAULT_MAX_INTERVAL_SECONDS = 15.0;
const BACKOFF_MULTIPLIER = 1.5;
// Transient poll failures (the document is already submitted; a
// load-balancer blip must not orphan it) are retried up to this many
// CONSECUTIVE times before the last error is rethrown unchanged.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const JITTER_MIN = 0.8;
const JITTER_SPAN = 0.4; // jitter factor is JITTER_MIN + JITTER_SPAN * random() -> [0.8, 1.2)

const TERMINAL_STATUSES: ReadonlySet<ResponseStatus> = new Set<ResponseStatus>([
  ResponseStatus.Success,
  ResponseStatus.Partial,
  ResponseStatus.Empty,
  ResponseStatus.Failed,
]);

/** Generated API instances to use instead of lazily constructed ones (test injection). */
export interface GeminaClientApis {
  documents?: DocumentApi;
  retrieval?: RetrievalApi;
  chat?: ChatApi;
  templates?: TemplatesApi;
  files?: FilesApi;
  fileTag?: FileTagApi;
  sessions?: SessionsApi;
  subscriptions?: SubscriptionsApi;
  billing?: BillingApi;
}

/** Optional knobs for the `GeminaClient` constructor. */
export interface GeminaClientOptions {
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetchApi?: FetchAPI;
  /** Extra headers to send with every request. */
  headers?: HTTPHeaders;
  /** Generated-client middleware applied to every request. */
  middleware?: Middleware[];
  /**
   * Pre-built generated `Configuration` — overrides `apiKey`/`baseUrl`
   * entirely. Advanced/internal (used by `withSessionToken`).
   */
  configuration?: Configuration;
  /** Override the lazily constructed generated API instances (test injection). */
  apis?: GeminaClientApis;
}

/**
 * A document to process: a `Blob`/`File` (uploaded via multipart
 * `POST /v1/documents/requests`) or a `{ url }` reference (submitted via
 * `POST /v1/documents/requests/web`). In Node, wrap a `Buffer` with
 * `new Blob([buf])`.
 */
export type DocumentSource = Blob | { url: string };

/** Options for `GeminaClient.processDocument`. */
export interface ProcessDocumentOptions {
  /** External identifier for the document. Auto-generated (UUID) when omitted. */
  externalId?: string;
  /** Template ID for `custom_template` extraction. */
  templateId?: string;
  /** Model type override. */
  modelType?: ModelType;
  /** Use the Thinking model. */
  thinking?: boolean;
  /** Use the Evaluation model. */
  evaluation?: boolean;
  /** Use the Correction model. */
  correction?: boolean;
  /** Include coordinates in the extraction results. */
  includeCoordinates?: boolean;
  /** End-user ID to associate with the document. */
  endUserId?: string;

  // Polling knobs
  /** Overall deadline in seconds (default 300). */
  timeoutSeconds?: number;
  /** First poll interval in seconds (default 2.0; grows x1.5 per attempt). */
  initialIntervalSeconds?: number;
  /** Poll interval cap in seconds (default 15.0). */
  maxIntervalSeconds?: number;

  // Test injection
  /** Sleep function (seconds). Defaults to a real `setTimeout` wait. */
  sleepFn?: (seconds: number) => Promise<void>;
  /** Random source in [0, 1) for the jitter factor. Defaults to `Math.random`. */
  random?: () => number;
}

function defaultSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function generateExternalId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  // Fallback for runtimes without WebCrypto: random hex label (not for security).
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return hex;
}

function isTerminal(status: ResponseStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Convenience facade over the generated Gemina API client.
 *
 * ```ts
 * const client = new GeminaClient("YOUR_API_KEY");
 * const result = await client.processDocument(file, ["invoice_headers"]);
 * ```
 *
 * The full generated surface stays available through the lazy group
 * accessors (`client.documents`, `client.retrieval`, ...).
 */
export class GeminaClient {
  /** The generated `Configuration` used by every API group. */
  readonly configuration: Configuration;

  private readonly apiOverrides: GeminaClientApis;
  private readonly apiCache: GeminaClientApis = {};

  /**
   * @param apiKey  Gemina API key, sent as the `X-API-Key` header.
   * @param baseUrl API base URL (default `https://api.gemina.co`).
   * @param options Optional fetch/headers/middleware overrides and test hooks.
   */
  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL, options: GeminaClientOptions = {}) {
    this.configuration =
      options.configuration ??
      new Configuration({
        basePath: normalizeBaseUrl(baseUrl),
        apiKey,
        headers: options.headers,
        fetchApi: options.fetchApi,
        middleware: options.middleware,
      });
    this.apiOverrides = options.apis ?? {};
  }

  /**
   * Build a client authenticated with a short-lived session token
   * (`OAuth2PasswordBearer` bearer scheme) instead of an API key. Use this
   * in browser/session contexts — never ship the API key to a browser.
   */
  static withSessionToken(
    token: string,
    baseUrl: string = DEFAULT_BASE_URL,
    options: GeminaClientOptions = {},
  ): GeminaClient {
    // The generated client places the accessToken value VERBATIM in the
    // Authorization header (the oauth2 template adds no scheme prefix), so
    // supply the full "Bearer <token>" header value here.
    const headerValue = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    const configuration =
      options.configuration ??
      new Configuration({
        basePath: normalizeBaseUrl(baseUrl),
        accessToken: headerValue,
        headers: options.headers,
        fetchApi: options.fetchApi,
        middleware: options.middleware,
      });
    return new GeminaClient('', baseUrl, { ...options, configuration });
  }

  // --- Lazy generated API group accessors (full surface, zero wrapping) ---

  get documents(): DocumentApi {
    return (this.apiCache.documents ??=
      this.apiOverrides.documents ?? new DocumentApi(this.configuration));
  }

  get retrieval(): RetrievalApi {
    return (this.apiCache.retrieval ??=
      this.apiOverrides.retrieval ?? new RetrievalApi(this.configuration));
  }

  get chat(): ChatApi {
    return (this.apiCache.chat ??= this.apiOverrides.chat ?? new ChatApi(this.configuration));
  }

  get templates(): TemplatesApi {
    return (this.apiCache.templates ??=
      this.apiOverrides.templates ?? new TemplatesApi(this.configuration));
  }

  get files(): FilesApi {
    return (this.apiCache.files ??= this.apiOverrides.files ?? new FilesApi(this.configuration));
  }

  get fileTag(): FileTagApi {
    return (this.apiCache.fileTag ??=
      this.apiOverrides.fileTag ?? new FileTagApi(this.configuration));
  }

  get sessions(): SessionsApi {
    return (this.apiCache.sessions ??=
      this.apiOverrides.sessions ?? new SessionsApi(this.configuration));
  }

  get subscriptions(): SubscriptionsApi {
    return (this.apiCache.subscriptions ??=
      this.apiOverrides.subscriptions ?? new SubscriptionsApi(this.configuration));
  }

  get billing(): BillingApi {
    return (this.apiCache.billing ??=
      this.apiOverrides.billing ?? new BillingApi(this.configuration));
  }

  // --- The headline one-call flow ---

  /**
   * Submit a document via the async endpoints, poll with exponential
   * backoff until processing reaches a terminal status, and return the
   * typed result.
   *
   * - `success`, `partial`, `empty` → returns the result (check `status`).
   * - `failed` → throws {@link GeminaProcessingError} (carries the result).
   * - Deadline exceeded → throws {@link GeminaTimeoutError} (carries
   *   `correlationId` so you can resume polling yourself).
   * - Transient poll errors (connection blips, 5xx without a result body)
   *   are retried on the same backoff/deadline; after 3 consecutive
   *   failures the last error is rethrown unchanged. Submit errors are
   *   never retried.
   *
   * @param source          A `Blob`/`File`, or `{ url }` for a web document.
   * @param extractionTypes Non-empty list of extraction types to run.
   * @param options         Endpoint form fields + polling knobs.
   */
  async processDocument(
    source: DocumentSource,
    extractionTypes: ExtractionTypeModel[],
    options: ProcessDocumentOptions = {},
  ): Promise<DocumentProcessingResultOutDTO> {
    if (!Array.isArray(extractionTypes) || extractionTypes.length === 0) {
      throw new GeminaError('extractionTypes must be a non-empty array');
    }

    const externalId = options.externalId ?? generateExternalId();
    let submitted: DocumentProcessingResultOutDTO;

    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      try {
        submitted = await this.documents.createDocumentProcessingRequest({
          file: source,
          externalId,
          extractionTypes,
          templateId: options.templateId,
          modelType: options.modelType,
          thinking: options.thinking,
          evaluation: options.evaluation,
          correction: options.correction,
          includeCoordinates: options.includeCoordinates,
          endUserId: options.endUserId,
        });
      } catch (error) {
        throw await asProcessingErrorIfFailedResult(error);
      }
    } else if (
      typeof source === 'object' &&
      source !== null &&
      'url' in source &&
      typeof source.url === 'string'
    ) {
      try {
        submitted = await this.documents.createWebDocumentProcessingRequest({
          webDocumentUploadInDTO: {
            url: source.url,
            externalId,
            extractionTypes,
            templateId: options.templateId,
            modelType: options.modelType,
            thinking: options.thinking,
            evaluation: options.evaluation,
            correction: options.correction,
            includeCoordinates: options.includeCoordinates,
            endUserId: options.endUserId,
          },
        });
      } catch (error) {
        throw await asProcessingErrorIfFailedResult(error);
      }
    } else {
      throw new GeminaError(
        'Unsupported document source: pass a Blob/File or { url: "https://..." }. ' +
          'In Node, convert a Buffer with new Blob([buf]).',
      );
    }

    return this.pollUntilTerminal(submitted, options);
  }

  private async pollUntilTerminal(
    submitted: DocumentProcessingResultOutDTO,
    options: ProcessDocumentOptions,
  ): Promise<DocumentProcessingResultOutDTO> {
    if (isTerminal(submitted.status)) {
      return finalizeTerminal(submitted);
    }

    const correlationId = submitted.meta?.correlationId;
    if (correlationId == null || correlationId === '') {
      throw new GeminaError(
        'Malformed server response: non-terminal submit response is missing meta.correlationId',
      );
    }

    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const initialIntervalSeconds = options.initialIntervalSeconds ?? DEFAULT_INITIAL_INTERVAL_SECONDS;
    const maxIntervalSeconds = options.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    const sleepFn = options.sleepFn ?? defaultSleep;
    const random = options.random ?? Math.random;

    const startedAt = Date.now();
    let sleptSeconds = 0;
    let nominalInterval = Math.min(initialIntervalSeconds, maxIntervalSeconds);
    let lastResult = submitted;
    let consecutivePollFailures = 0;

    // Poll loop: wait (backoff + jitter), then GET /v1/documents/results/{correlationId}.
    // HTTP 202 and 200 both carry the result body.
    for (;;) {
      const wait = nominalInterval * (JITTER_MIN + JITTER_SPAN * random());
      const realElapsedSeconds = (Date.now() - startedAt) / 1000;
      const elapsedSeconds = Math.max(realElapsedSeconds, sleptSeconds);
      if (elapsedSeconds + wait > timeoutSeconds) {
        throw new GeminaTimeoutError(correlationId, lastResult);
      }

      await sleepFn(wait);
      sleptSeconds += wait;

      let polled: DocumentProcessingResultOutDTO | undefined;
      try {
        polled = await this.documents.getDocumentProcessingResultByCorrelationId({
          correlationId,
        });
        consecutivePollFailures = 0;
      } catch (error) {
        const converted = await asProcessingErrorIfFailedResult(error);
        if (converted instanceof GeminaProcessingError) {
          // Terminal `failed` delivered as an HTTP error body — not transient.
          throw converted;
        }
        // Transient poll failure (connection error / 5xx with a non-result
        // body): the document is already submitted, so keep polling on the
        // same backoff schedule and overall deadline. After
        // MAX_CONSECUTIVE_POLL_FAILURES in a row, rethrow unchanged.
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw error;
        }
      }

      if (polled !== undefined) {
        lastResult = polled;
        if (isTerminal(polled.status)) {
          return finalizeTerminal(polled);
        }
      }

      nominalInterval = Math.min(nominalInterval * BACKOFF_MULTIPLIER, maxIntervalSeconds);
    }
  }
}

function finalizeTerminal(
  result: DocumentProcessingResultOutDTO,
): DocumentProcessingResultOutDTO {
  if (result.status === ResponseStatus.Failed) {
    throw new GeminaProcessingError(result);
  }
  return result;
}

/**
 * The API reports a terminally-failed document as an HTTP 500 whose body IS
 * a `DocumentProcessingResultOutDTO` with `status: "failed"` — so the
 * generated client throws `ResponseError` before terminal handling can see
 * it. If `error` is that specific shape, return the contract-mandated
 * `GeminaProcessingError` carrying the parsed result; otherwise return the
 * original error unchanged. Callers `throw` whatever comes back.
 */
async function asProcessingErrorIfFailedResult(error: unknown): Promise<unknown> {
  if (!(error instanceof ResponseError)) {
    return error;
  }
  let json: unknown;
  try {
    // Clone so the original response body stays readable for callers that
    // inspect the rethrown ResponseError.
    json = await error.response.clone().json();
  } catch {
    return error; // non-JSON body — not a processing result
  }
  if (typeof json !== 'object' || json === null) {
    return error;
  }
  if ((json as { status?: unknown }).status !== ResponseStatus.Failed) {
    return error;
  }
  return new GeminaProcessingError(DocumentProcessingResultOutDTOFromJSON(json));
}
