package co.gemina.sdk;

import java.net.URI;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

import co.gemina.sdk.generated.ApiClient;
import co.gemina.sdk.generated.ApiException;
import co.gemina.sdk.generated.api.BillingApi;
import co.gemina.sdk.generated.api.ChatApi;
import co.gemina.sdk.generated.api.DocumentApi;
import co.gemina.sdk.generated.api.FileTagApi;
import co.gemina.sdk.generated.api.FilesApi;
import co.gemina.sdk.generated.api.RetrievalApi;
import co.gemina.sdk.generated.api.SessionsApi;
import co.gemina.sdk.generated.api.SubscriptionsApi;
import co.gemina.sdk.generated.api.TemplatesApi;
import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;
import co.gemina.sdk.generated.model.ExtractionTypeModel;
import co.gemina.sdk.generated.model.ResponseStatus;
import co.gemina.sdk.generated.model.WebDocumentUploadInDTO;

/**
 * The Gemina API client facade.
 *
 * <p>Construct with your API key (sent as the {@code X-API-Key} header), then
 * either call the one-shot {@link #processDocument} helper or reach the full
 * generated API surface through the group accessors ({@link #documents()},
 * {@link #retrieval()}, {@link #chat()}, ...).</p>
 *
 * <pre>{@code
 * GeminaClient client = new GeminaClient(System.getenv("GEMINA_API_KEY"));
 * DocumentProcessingResultOutDTO result = client.processDocument(
 *         GeminaDocumentSource.fromFile(new File("invoice.pdf")),
 *         Arrays.asList(ExtractionTypeModel.INVOICE_HEADERS),
 *         null);
 * }</pre>
 */
public class GeminaClient {

    /** Production API base URL. */
    public static final String DEFAULT_BASE_URL = "https://api.gemina.co";

    private static final double BACKOFF_MULTIPLIER = 1.5;
    private static final double JITTER_MIN = 0.8;
    private static final double JITTER_SPAN = 0.4; // [0.8, 1.2]

    /** Transient poll failures tolerated in a row before the last error is rethrown. */
    private static final int MAX_CONSECUTIVE_POLL_FAILURES = 3;

    /**
     * ISO-8601 date-time with an optional offset (the API serves some
     * timestamps, e.g. {@code servedAt}, without one — treated as UTC). Also
     * used for serializing, where it emits the standard offset form.
     */
    private static final DateTimeFormatter LENIENT_OFFSET_DATE_TIME = new DateTimeFormatterBuilder()
            .append(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            .optionalStart()
            .appendOffsetId()
            .optionalEnd()
            .parseDefaulting(ChronoField.OFFSET_SECONDS, 0)
            .toFormatter();

    private final ApiClient apiClient;

    private DocumentApi documentApi;
    private RetrievalApi retrievalApi;
    private ChatApi chatApi;
    private TemplatesApi templatesApi;
    private FilesApi filesApi;
    private FileTagApi fileTagApi;
    private SessionsApi sessionsApi;
    private SubscriptionsApi subscriptionsApi;
    private BillingApi billingApi;

    /** API-key client against the production base URL ({@value #DEFAULT_BASE_URL}). */
    public GeminaClient(String apiKey) {
        this(apiKey, DEFAULT_BASE_URL);
    }

    /** API-key client against a custom base URL (staging / self-hosted). */
    public GeminaClient(String apiKey, String baseUrl) {
        this(buildApiClient(baseUrl));
        if (apiKey == null || apiKey.isEmpty()) {
            throw new IllegalArgumentException("apiKey must not be null or empty");
        }
        apiClient.setApiKey(apiKey); // APIKeyHeader scheme -> X-API-Key header
    }

    /**
     * Escape hatch: wrap a pre-built generated {@link ApiClient} (custom
     * OkHttpClient, proxies, interceptors, ...). Authentication must already be
     * configured on it.
     */
    public GeminaClient(ApiClient apiClient) {
        if (apiClient == null) {
            throw new IllegalArgumentException("apiClient must not be null");
        }
        this.apiClient = apiClient;
    }

    /**
     * Session-token client (the {@code OAuth2PasswordBearer} bearer scheme)
     * against the production base URL. Used by browser/session contexts with
     * short-lived tokens minted via {@code POST /v1/sessions/token}.
     */
    public static GeminaClient withSessionToken(String token) {
        return withSessionToken(token, DEFAULT_BASE_URL);
    }

    /** Session-token client against a custom base URL. */
    public static GeminaClient withSessionToken(String token, String baseUrl) {
        if (token == null || token.isEmpty()) {
            throw new IllegalArgumentException("token must not be null or empty");
        }
        ApiClient generatedClient = buildApiClient(baseUrl);
        generatedClient.setAccessToken(token); // OAuth2PasswordBearer scheme
        return new GeminaClient(generatedClient);
    }

    private static ApiClient buildApiClient(String baseUrl) {
        if (baseUrl == null || baseUrl.isEmpty()) {
            throw new IllegalArgumentException("baseUrl must not be null or empty");
        }
        ApiClient generatedClient = new GeminaApiClient();
        generatedClient.setBasePath(trimTrailingSlash(baseUrl));
        generatedClient.setUserAgent("gemina-sdk-java/" + SdkVersion.VERSION);
        generatedClient.setOffsetDateTimeFormat(LENIENT_OFFSET_DATE_TIME);
        return generatedClient;
    }

    private static String trimTrailingSlash(String baseUrl) {
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    /** The underlying generated {@link ApiClient} (shared by all API groups). */
    public ApiClient getApiClient() {
        return apiClient;
    }

    // ------------------------------------------------------------------
    // Generated API groups — lazily constructed, full surface, zero wrapping.
    // ------------------------------------------------------------------

    public synchronized DocumentApi documents() {
        if (documentApi == null) {
            documentApi = new DocumentApi(apiClient);
        }
        return documentApi;
    }

    public synchronized RetrievalApi retrieval() {
        if (retrievalApi == null) {
            retrievalApi = new RetrievalApi(apiClient);
        }
        return retrievalApi;
    }

    public synchronized ChatApi chat() {
        if (chatApi == null) {
            chatApi = new ChatApi(apiClient);
        }
        return chatApi;
    }

    public synchronized TemplatesApi templates() {
        if (templatesApi == null) {
            templatesApi = new TemplatesApi(apiClient);
        }
        return templatesApi;
    }

    public synchronized FilesApi files() {
        if (filesApi == null) {
            filesApi = new FilesApi(apiClient);
        }
        return filesApi;
    }

    public synchronized FileTagApi fileTag() {
        if (fileTagApi == null) {
            fileTagApi = new FileTagApi(apiClient);
        }
        return fileTagApi;
    }

    public synchronized SessionsApi sessions() {
        if (sessionsApi == null) {
            sessionsApi = new SessionsApi(apiClient);
        }
        return sessionsApi;
    }

    public synchronized SubscriptionsApi subscriptions() {
        if (subscriptionsApi == null) {
            subscriptionsApi = new SubscriptionsApi(apiClient);
        }
        return subscriptionsApi;
    }

    public synchronized BillingApi billing() {
        if (billingApi == null) {
            billingApi = new BillingApi(apiClient);
        }
        return billingApi;
    }

    // Package-private setters so unit tests can swap in mocked API instances.

    synchronized void setDocumentsApi(DocumentApi documentApi) {
        this.documentApi = documentApi;
    }

    synchronized void setRetrievalApi(RetrievalApi retrievalApi) {
        this.retrievalApi = retrievalApi;
    }

    synchronized void setChatApi(ChatApi chatApi) {
        this.chatApi = chatApi;
    }

    synchronized void setTemplatesApi(TemplatesApi templatesApi) {
        this.templatesApi = templatesApi;
    }

    synchronized void setFilesApi(FilesApi filesApi) {
        this.filesApi = filesApi;
    }

    synchronized void setFileTagApi(FileTagApi fileTagApi) {
        this.fileTagApi = fileTagApi;
    }

    synchronized void setSessionsApi(SessionsApi sessionsApi) {
        this.sessionsApi = sessionsApi;
    }

    synchronized void setSubscriptionsApi(SubscriptionsApi subscriptionsApi) {
        this.subscriptionsApi = subscriptionsApi;
    }

    synchronized void setBillingApi(BillingApi billingApi) {
        this.billingApi = billingApi;
    }

    // ------------------------------------------------------------------
    // processDocument — the headline one-call flow
    // ------------------------------------------------------------------

    /** {@link #processDocument(GeminaDocumentSource, List, ProcessDocumentOptions)} with default options. */
    public DocumentProcessingResultOutDTO processDocument(
            GeminaDocumentSource source, List<ExtractionTypeModel> extractionTypes) throws ApiException {
        return processDocument(source, extractionTypes, null);
    }

    /**
     * Submit a document via the async endpoints, poll until terminal, and
     * return the typed result. Blocks the calling thread (see
     * {@link #processDocumentAsync} for a {@link CompletableFuture} variant).
     *
     * <p>Files submit via {@code POST /v1/documents/requests} (multipart); URLs
     * via {@code POST /v1/documents/requests/web}. The helper then polls
     * {@code GET /v1/documents/results/{correlationId}} with exponential
     * backoff (starting at {@code initialIntervalSeconds}, growing x1.5 per
     * attempt, capped at {@code maxIntervalSeconds}, each wait jittered by a
     * random factor in [0.8, 1.2]) until the result is terminal or the overall
     * {@code timeoutSeconds} deadline passes.</p>
     *
     * <p>Transient poll failures are retried — the document is already
     * submitted, so a load-balancer blip must not orphan it: a poll error
     * whose body is not a terminal {@code failed} result counts as a failed
     * attempt but polling continues on the same backoff schedule and overall
     * deadline. After 3 consecutive such failures the last error is rethrown
     * unchanged; any successful poll resets the counter. Submit errors are
     * never retried (nothing was accepted yet) — they pass through
     * unwrapped.</p>
     *
     * <ul>
     *   <li>{@code success} / {@code partial} / {@code empty} — the result is
     *       returned (check {@code getStatus()}; {@code partial}/{@code empty}
     *       still carry usable data/meta).</li>
     *   <li>{@code failed} — throws {@link GeminaProcessingException} carrying
     *       the full result.</li>
     *   <li>Deadline exceeded — throws {@link GeminaTimeoutException} carrying
     *       the {@code correlationId} and the last seen result.</li>
     * </ul>
     *
     * @param source          the document (file or URL)
     * @param extractionTypes required, non-empty list of extraction types
     * @param options         optional submission fields + polling knobs, or {@code null} for defaults
     * @throws ApiException transport/HTTP errors from the generated client, unwrapped
     */
    public DocumentProcessingResultOutDTO processDocument(
            GeminaDocumentSource source,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options) throws ApiException {
        if (source == null) {
            throw new IllegalArgumentException("source must not be null");
        }
        if (extractionTypes == null || extractionTypes.isEmpty()) {
            throw new IllegalArgumentException("extractionTypes must be a non-empty list");
        }
        ProcessDocumentOptions opts = options != null ? options : ProcessDocumentOptions.defaults();

        long startNanos = System.nanoTime();
        long timeoutMillis = (long) (opts.getTimeoutSeconds() * 1000.0);
        DocumentProcessingResultOutDTO result;
        try {
            result = submit(source, extractionTypes, opts);
        } catch (ApiException e) {
            throwIfFailedResult(e);
            throw e;
        }

        double intervalSeconds = opts.getInitialIntervalSeconds();
        long virtualElapsedMillis = 0; // sum of requested waits; keeps fake-Sleeper tests deterministic
        Random random = opts.getRandom();
        UUID correlationId = null;
        int consecutivePollFailures = 0;

        while (true) {
            ResponseStatus status = result.getStatus();
            if (status == ResponseStatus.FAILED) {
                throw new GeminaProcessingException(result);
            }
            if (status == ResponseStatus.SUCCESS
                    || status == ResponseStatus.PARTIAL
                    || status == ResponseStatus.EMPTY) {
                return result;
            }

            // Non-terminal (pending / in_process) — we need a correlation id to poll.
            if (correlationId == null) {
                correlationId = result.getMeta() != null ? result.getMeta().getCorrelationId() : null;
                if (correlationId == null) {
                    throw new GeminaException(
                            "Malformed server response: non-terminal result without meta.correlationId");
                }
            }

            long realElapsedMillis = (System.nanoTime() - startNanos) / 1_000_000L;
            long elapsedMillis = Math.max(realElapsedMillis, virtualElapsedMillis);
            if (elapsedMillis >= timeoutMillis) {
                throw new GeminaTimeoutException(correlationId, result);
            }

            double jitter = JITTER_MIN + random.nextDouble() * JITTER_SPAN;
            long waitMillis = Math.round(intervalSeconds * jitter * 1000.0);
            try {
                opts.getSleeper().sleep(waitMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new GeminaException("Interrupted while waiting for document processing "
                        + "(correlationId=" + correlationId + ")", e);
            }
            virtualElapsedMillis += waitMillis;
            intervalSeconds = Math.min(intervalSeconds * BACKOFF_MULTIPLIER, opts.getMaxIntervalSeconds());

            try {
                result = documents().getDocumentProcessingResultByCorrelationId(correlationId);
                consecutivePollFailures = 0; // successful poll resets the counter
            } catch (ApiException e) {
                throwIfFailedResult(e); // terminal failed-result body -> GeminaProcessingException, never retried
                // Transient poll failure (connection error / 5xx with a
                // non-result body): the document is already submitted, so keep
                // polling on the same backoff schedule and overall deadline.
                consecutivePollFailures++;
                if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                    throw e;
                }
            }
        }
    }

    /**
     * The API serves a terminally-failed processing result as an HTTP 500
     * whose body IS a {@code DocumentProcessingResultOutDTO} with
     * {@code status=failed} — the generated client surfaces that as an
     * {@link ApiException} before our terminal handling. If the error body
     * parses as such a failed result, surface it as
     * {@link GeminaProcessingException}; anything else simply returns so the
     * caller can rethrow the original {@link ApiException} unchanged.
     */
    private static void throwIfFailedResult(ApiException e) {
        String body = e.getResponseBody();
        if (body == null || body.isEmpty()) {
            return;
        }
        DocumentProcessingResultOutDTO parsed;
        try {
            parsed = DocumentProcessingResultOutDTO.fromJson(body); // generated Gson infra
        } catch (Exception notAProcessingResult) {
            return; // plain HTTP error — propagate the original ApiException
        }
        if (parsed != null && parsed.getStatus() == ResponseStatus.FAILED) {
            throw new GeminaProcessingException(parsed);
        }
    }

    /**
     * {@link CompletableFuture} variant of {@link #processDocument}. Wraps the
     * blocking submit-and-poll flow in
     * {@link CompletableFuture#supplyAsync(java.util.function.Supplier)}, so it
     * runs on {@link java.util.concurrent.ForkJoinPool#commonPool()} and
     * occupies one of its threads for the duration of the flow. Checked
     * {@link ApiException}s surface as the future's failure cause (wrapped in a
     * {@link CompletionException}).
     */
    public CompletableFuture<DocumentProcessingResultOutDTO> processDocumentAsync(
            GeminaDocumentSource source,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return processDocument(source, extractionTypes, options);
            } catch (ApiException e) {
                throw new CompletionException(e);
            }
        });
    }

    private DocumentProcessingResultOutDTO submit(
            GeminaDocumentSource source,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions opts) throws ApiException {
        // external_id is a required form field (1-100 chars); generate one when unset.
        String externalId = opts.getExternalId() != null
                ? opts.getExternalId()
                : UUID.randomUUID().toString();

        if (source.isUrl()) {
            WebDocumentUploadInDTO body = new WebDocumentUploadInDTO()
                    .url(URI.create(source.getUrl()))
                    .externalId(externalId)
                    .extractionTypes(extractionTypes)
                    .correction(opts.getCorrection())
                    .endUserId(opts.getEndUserId())
                    .evaluation(opts.getEvaluation())
                    .includeCoordinates(opts.getIncludeCoordinates())
                    .modelType(opts.getModelType())
                    .templateId(opts.getTemplateId())
                    .thinking(opts.getThinking());
            return documents().createWebDocumentProcessingRequest(body);
        }

        return documents().createDocumentProcessingRequest(
                externalId,
                extractionTypes,
                source.getFile(),
                opts.getCorrection(),
                opts.getEndUserId(),
                opts.getEvaluation(),
                opts.getIncludeCoordinates(),
                opts.getModelType(),
                opts.getTemplateId(),
                opts.getThinking());
    }
}
