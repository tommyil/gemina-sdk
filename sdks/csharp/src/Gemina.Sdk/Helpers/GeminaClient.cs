using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Api;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;

namespace Gemina.Sdk
{
    /// <summary>
    /// A stateful chat conversation that threads the server-issued
    /// <c>sessionId</c> across turns, so follow-up questions keep context — you
    /// never touch the id. Create one with
    /// <see cref="GeminaClient.Conversation(string)"/>.
    /// </summary>
    /// <remarks>
    /// <code>
    /// var chat = client.Conversation();
    /// await chat.SendAsync("How much did I spend at Acme in Q1?");
    /// await chat.SendAsync("And the biggest invoice?"); // remembers Acme / Q1
    /// await chat.DeleteAsync();                          // end it server-side
    /// </code>
    /// A turn that carries a stale session (24h idle TTL, or after
    /// <see cref="Reset"/>) fails with the API's 404
    /// <c>CHAT_SESSION_NOT_FOUND</c>; catch it, call <see cref="Reset"/>, and
    /// resend to continue in a fresh conversation.
    /// </remarks>
    public class GeminaChatConversation
    {
        private readonly IChatApi _chat;
        private readonly string _endUserId;
        private Guid? _currentSessionId;

        internal GeminaChatConversation(IChatApi chat, string endUserId = null)
        {
            _chat = chat;
            _endUserId = endUserId;
        }

        /// <summary>
        /// The current conversation id — <c>null</c> before the first turn or
        /// after a <see cref="Reset"/>.
        /// </summary>
        public Guid? SessionId => _currentSessionId;

        /// <summary>Sends one turn; its answer continues this conversation.</summary>
        /// <param name="message">The natural-language question to ask.</param>
        /// <param name="cancellationToken">Cancels the request.</param>
        public async Task<ChatQueryOutDTO> SendAsync(
            string message,
            CancellationToken cancellationToken = default)
        {
            // sessionId is null on the first turn (a new conversation) and the
            // threaded id thereafter; a null value is omitted from the request.
            var request = new ChatQueryInDTO(
                endUserId: _endUserId,
                message: message,
                sessionId: _currentSessionId);

            var result = await _chat
                .ChatQueryAsync(request, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            _currentSessionId = result.SessionId;
            return result;
        }

        /// <summary>
        /// Forgets the conversation locally; the next <see cref="SendAsync"/>
        /// starts a new one.
        /// </summary>
        public void Reset()
        {
            _currentSessionId = null;
        }

        /// <summary>
        /// Ends the conversation: deletes it server-side (mirrors a "New chat"
        /// action) and forgets it locally. No-op if no turn has been sent yet.
        /// </summary>
        /// <param name="cancellationToken">Cancels the request.</param>
        public async Task DeleteAsync(CancellationToken cancellationToken = default)
        {
            var sessionId = _currentSessionId;
            _currentSessionId = null;
            if (sessionId.HasValue)
            {
                await _chat
                    .DeleteChatSessionAsync(sessionId.Value, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Facade over the generated Gemina API client: one-line construction
    /// with an API key, lazily-built accessors for every API group, and the
    /// <see cref="ProcessDocumentAsync(GeminaDocumentSource, List{ExtractionTypeModel}, ProcessDocumentOptions, CancellationToken)"/>
    /// submit-and-poll convenience flow.
    /// </summary>
    public class GeminaClient
    {
        /// <summary>The production Gemina API base URL.</summary>
        public const string DefaultBaseUrl = "https://api.gemina.co";

        private IDocumentApi _documents;
        private IRetrievalApi _retrieval;
        private IChatApi _chat;
        private ITemplatesApi _templates;
        private IFilesApi _files;
        private IFileTagApi _fileTag;
        private ISessionsApi _sessions;
        private ISubscriptionsApi _subscriptions;
        private IBillingApi _billing;
        private IDocumentTransport _documentTransport;

        private static readonly Random SharedRandom = new Random();

        /// <summary>
        /// The configuration handed to every generated API group. Tweak it
        /// (timeouts, proxy, default headers, …) before first use of a group
        /// accessor.
        /// </summary>
        public Configuration Configuration { get; }

        /// <summary>
        /// Creates a client authenticating with an API key (sent as the
        /// <c>X-API-Key</c> header).
        /// </summary>
        /// <param name="apiKey">Your Gemina API key (console.gemina.co).</param>
        /// <param name="baseUrl">API base URL; override for staging or self-hosted deployments.</param>
        public GeminaClient(string apiKey, string baseUrl = DefaultBaseUrl)
        {
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                throw new ArgumentException("apiKey must be a non-empty string.", nameof(apiKey));
            }

            Configuration = BuildConfiguration(baseUrl);
            Configuration.ApiKey["X-API-Key"] = apiKey;
        }

        private GeminaClient(Configuration configuration)
        {
            Configuration = configuration;
        }

        /// <summary>
        /// Creates a client authenticating with a short-lived session token
        /// (sent as a bearer <c>Authorization</c> header) instead of an API
        /// key — used by browser/session contexts.
        /// </summary>
        /// <param name="token">Session token minted via <c>POST /v1/sessions/token</c>.</param>
        /// <param name="baseUrl">API base URL; override for staging or self-hosted deployments.</param>
        public static GeminaClient WithSessionToken(string token, string baseUrl = DefaultBaseUrl)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                throw new ArgumentException("token must be a non-empty string.", nameof(token));
            }

            var configuration = BuildConfiguration(baseUrl);
            configuration.AccessToken = token;
            return new GeminaClient(configuration);
        }

        private static Configuration BuildConfiguration(string baseUrl)
        {
            if (string.IsNullOrWhiteSpace(baseUrl))
            {
                throw new ArgumentException("baseUrl must be a non-empty string.", nameof(baseUrl));
            }

            return new Configuration
            {
                BasePath = baseUrl.TrimEnd('/'),
                UserAgent = "gemina-sdk-csharp/" + SdkVersion.Version,
            };
        }

        /// <summary>Document upload, processing results, views and purging.</summary>
        public IDocumentApi Documents
        {
            get => _documents ?? (_documents = new DocumentApi(Configuration));
            internal set => _documents = value;
        }

        /// <summary>Search and aggregate over your processed documents.</summary>
        public IRetrievalApi Retrieval
        {
            get => _retrieval ?? (_retrieval = new RetrievalApi(Configuration));
            internal set => _retrieval = value;
        }

        /// <summary>Chat over your processed documents.</summary>
        public IChatApi Chat
        {
            get => _chat ?? (_chat = new ChatApi(Configuration));
            internal set => _chat = value;
        }

        /// <summary>Custom extraction template management.</summary>
        public ITemplatesApi Templates
        {
            get => _templates ?? (_templates = new TemplatesApi(Configuration));
            internal set => _templates = value;
        }

        /// <summary>File upload slots for the Files flow.</summary>
        public IFilesApi Files
        {
            get => _files ?? (_files = new FilesApi(Configuration));
            internal set => _files = value;
        }

        /// <summary>FileTag document tagging.</summary>
        public IFileTagApi FileTag
        {
            get => _fileTag ?? (_fileTag = new FileTagApi(Configuration));
            internal set => _fileTag = value;
        }

        /// <summary>Short-lived session tokens for browser embedding.</summary>
        public ISessionsApi Sessions
        {
            get => _sessions ?? (_sessions = new SessionsApi(Configuration));
            internal set => _sessions = value;
        }

        /// <summary>Subscription plans and checkout.</summary>
        public ISubscriptionsApi Subscriptions
        {
            get => _subscriptions ?? (_subscriptions = new SubscriptionsApi(Configuration));
            internal set => _subscriptions = value;
        }

        /// <summary>Usage, credit transactions and invoices.</summary>
        public IBillingApi Billing
        {
            get => _billing ?? (_billing = new BillingApi(Configuration));
            internal set => _billing = value;
        }

        // ---- Stateful chat convenience ----

        /// <summary>
        /// Starts a stateful <see cref="GeminaChatConversation"/> that threads
        /// the server-issued <c>sessionId</c> across turns for you, so follow-up
        /// questions keep context. The full one-shot surface stays on
        /// <see cref="Chat"/>.
        /// </summary>
        /// <param name="endUserId">
        /// End-user id forwarded with each turn (API-key path only; on the
        /// session-token path the token's signed scope wins server-side).
        /// </param>
        public GeminaChatConversation Conversation(string endUserId = null)
        {
            return new GeminaChatConversation(Chat, endUserId);
        }

        /// <summary>
        /// The transport used by
        /// <see cref="ProcessDocumentAsync(GeminaDocumentSource, List{ExtractionTypeModel}, ProcessDocumentOptions, CancellationToken)"/>
        /// for the multipart submit and result polling; see
        /// <see cref="DocumentTransport"/> for why these bypass the generated
        /// <c>DocumentApi</c> methods. Injectable in tests.
        /// </summary>
        internal IDocumentTransport Transport
        {
            get => _documentTransport ?? (_documentTransport = new DocumentTransport(Configuration));
            set => _documentTransport = value;
        }

        /// <summary>
        /// Processes a document stream end to end: submits it to the async
        /// endpoint, polls with backoff until a terminal status, and returns
        /// the typed result. See
        /// <see cref="ProcessDocumentAsync(GeminaDocumentSource, List{ExtractionTypeModel}, ProcessDocumentOptions, CancellationToken)"/>.
        /// </summary>
        /// <param name="file">A readable stream of the document (image or PDF).</param>
        /// <param name="extractionTypes">Non-empty list of extractions to run.</param>
        /// <param name="options">Form-field and polling options.</param>
        /// <param name="cancellationToken">Cancels both the HTTP calls and the waits.</param>
        public Task<DocumentProcessingResultOutDTO> ProcessDocumentAsync(
            Stream file,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options = null,
            CancellationToken cancellationToken = default)
        {
            if (file == null)
            {
                throw new ArgumentNullException(nameof(file));
            }

            return ProcessDocumentAsync(GeminaDocumentSource.FromStream(file), extractionTypes, options, cancellationToken);
        }

        /// <summary>
        /// Processes a document end to end: submits it to the async endpoint
        /// (<c>POST /v1/documents/requests</c> for streams/files,
        /// <c>POST /v1/documents/requests/web</c> for URLs), polls
        /// <c>GET /v1/documents/results/{correlationId}</c> with exponential
        /// backoff and jitter until a terminal status, and returns the typed
        /// result.
        /// </summary>
        /// <remarks>
        /// Terminal semantics: <c>success</c>, <c>partial</c> and <c>empty</c>
        /// are returned (check <c>Status</c>); <c>failed</c> throws
        /// <see cref="GeminaProcessingException"/>. Exceeding the polling
        /// deadline throws <see cref="GeminaTimeoutException"/> carrying the
        /// correlation id so you can resume polling yourself.
        /// </remarks>
        /// <param name="source">The document: <see cref="GeminaDocumentSource.FromStream"/>, <see cref="GeminaDocumentSource.FromFile"/> or <see cref="GeminaDocumentSource.FromUrl"/>.</param>
        /// <param name="extractionTypes">Non-empty list of extractions to run.</param>
        /// <param name="options">Form-field and polling options.</param>
        /// <param name="cancellationToken">Cancels both the HTTP calls and the waits.</param>
        public async Task<DocumentProcessingResultOutDTO> ProcessDocumentAsync(
            GeminaDocumentSource source,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options = null,
            CancellationToken cancellationToken = default)
        {
            if (source == null)
            {
                throw new ArgumentNullException(nameof(source));
            }

            if (extractionTypes == null || extractionTypes.Count == 0)
            {
                throw new ArgumentException("extractionTypes must be a non-empty list.", nameof(extractionTypes));
            }

            options = options ?? new ProcessDocumentOptions();
            var timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
            var stopwatch = Stopwatch.StartNew();

            var result = await SubmitAsync(source, extractionTypes, options, cancellationToken).ConfigureAwait(false);
            if (IsTerminal(result.Status))
            {
                return HandleTerminal(result);
            }

            var correlationId = result.Meta?.CorrelationId;
            if (!correlationId.HasValue)
            {
                throw new GeminaException(
                    "Malformed server response: non-terminal processing result without a correlationId to poll on.");
            }

            var delay = options.Delay ?? DefaultDelayAsync;
            var random = options.Random ?? NextSharedRandom;
            var nominalIntervalSeconds = options.InitialIntervalSeconds;
            var consecutivePollFailures = 0;

            while (true)
            {
                if (stopwatch.Elapsed >= timeout)
                {
                    throw new GeminaTimeoutException(correlationId.Value, result, options.TimeoutSeconds);
                }

                var jitter = 0.8 + (random() * 0.4);
                var wait = TimeSpan.FromSeconds(nominalIntervalSeconds * jitter);
                nominalIntervalSeconds = Math.Min(nominalIntervalSeconds * 1.5, options.MaxIntervalSeconds);

                await delay(wait, cancellationToken).ConfigureAwait(false);

                if (stopwatch.Elapsed >= timeout)
                {
                    throw new GeminaTimeoutException(correlationId.Value, result, options.TimeoutSeconds);
                }

                try
                {
                    result = await Transport
                        .GetResultAsync(correlationId.Value, cancellationToken)
                        .ConfigureAwait(false);
                    consecutivePollFailures = 0;
                }
                catch (GeminaProcessingException)
                {
                    // Terminal failed (delivered as an HTTP error whose body
                    // is the result, contract §2.4a) — not a transient blip.
                    throw;
                }
                catch (OperationCanceledException)
                {
                    // Caller cancellation is not a poll failure.
                    throw;
                }
                catch (Exception)
                {
                    // Transient poll failure (contract §2 step 3): the document
                    // is already submitted, so a blip must not orphan it. Keep
                    // polling on the same backoff schedule and deadline; after
                    // 3 consecutive failures rethrow the last error unchanged.
                    consecutivePollFailures++;
                    if (consecutivePollFailures >= 3)
                    {
                        throw;
                    }

                    continue;
                }

                if (IsTerminal(result.Status))
                {
                    return HandleTerminal(result);
                }
            }
        }

        /// <summary>
        /// Fetches the current processing result for a correlation id (one
        /// poll, no waiting) — use it to resume after a
        /// <see cref="GeminaTimeoutException"/>. Check <c>Status</c> on the
        /// returned result; <c>pending</c>/<c>in_process</c> mean it is still
        /// running.
        /// </summary>
        /// <remarks>
        /// Prefer this over the generated
        /// <c>Documents.GetDocumentProcessingResultByCorrelationIdAsync</c>,
        /// which silently returns <c>null</c> for finished documents (see
        /// <see cref="DocumentTransport"/>).
        /// </remarks>
        /// <param name="correlationId">The processing request's correlation id.</param>
        /// <param name="cancellationToken">Cancels the request.</param>
        public Task<DocumentProcessingResultOutDTO> GetProcessingResultAsync(
            Guid correlationId,
            CancellationToken cancellationToken = default)
        {
            return Transport.GetResultAsync(correlationId, cancellationToken);
        }

        private async Task<DocumentProcessingResultOutDTO> SubmitAsync(
            GeminaDocumentSource source,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options,
            CancellationToken cancellationToken)
        {
            // The submit endpoints require external_id; generate one when the caller has none.
            var externalId = options.ExternalId ?? Guid.NewGuid().ToString();

            if (source.IsUrl)
            {
                var body = new WebDocumentUploadInDTO(
                    correction: options.Correction,
                    endUserId: options.EndUserId,
                    evaluation: options.Evaluation,
                    externalId: externalId,
                    extractionTypes: extractionTypes,
                    includeCoordinates: options.IncludeCoordinates,
                    modelType: options.ModelType,
                    templateId: options.TemplateId,
                    thinking: options.Thinking,
                    url: source.Url);

                DocumentProcessingResultOutDTO webResult;
                try
                {
                    webResult = await Documents
                        .CreateWebDocumentProcessingRequestAsync(body, cancellationToken: cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (ApiException ex)
                {
                    // Terminal failed can arrive as an HTTP error whose body IS
                    // the result (contract §2.4a) — surface it as a processing
                    // failure; any other error passes through unchanged.
                    var failedResult = DocumentTransport.TryParseFailedResult(ex.ErrorContent as string);
                    if (failedResult != null)
                    {
                        throw new GeminaProcessingException(failedResult);
                    }

                    throw;
                }

                if (webResult == null)
                {
                    // The generated client swallows deserialization errors and
                    // returns null instead of throwing (see DocumentTransport).
                    throw new GeminaException(
                        "The generated client could not deserialize the web submit response.");
                }

                return webResult;
            }

            // FromFile sources open (and own) a FileStream here so the real
            // filename travels with the multipart part.
            var stream = source.Stream;
            var ownsStream = false;
            if (stream == null)
            {
                stream = new FileStream(source.FilePath, FileMode.Open, FileAccess.Read);
                ownsStream = true;
            }

            string fileName = null;
            if (source.FilePath != null)
            {
                fileName = Path.GetFileName(source.FilePath);
            }
            else if (stream is FileStream fileStream)
            {
                fileName = Path.GetFileName(fileStream.Name);
            }

            try
            {
                return await Transport
                    .SubmitMultipartAsync(stream, fileName, externalId, extractionTypes, options, cancellationToken)
                    .ConfigureAwait(false);
            }
            finally
            {
                if (ownsStream)
                {
                    stream.Dispose();
                }
            }
        }

        private static bool IsTerminal(ResponseStatus status)
        {
            return status != ResponseStatus.Pending && status != ResponseStatus.InProcess;
        }

        private static DocumentProcessingResultOutDTO HandleTerminal(DocumentProcessingResultOutDTO result)
        {
            if (result.Status == ResponseStatus.Failed)
            {
                throw new GeminaProcessingException(result);
            }

            // success, partial and empty all carry usable data/meta — callers check Status.
            return result;
        }

        private static Task DefaultDelayAsync(TimeSpan wait, CancellationToken cancellationToken)
        {
            return Task.Delay(wait, cancellationToken);
        }

        private static double NextSharedRandom()
        {
            lock (SharedRandom)
            {
                return SharedRandom.NextDouble();
            }
        }
    }
}
