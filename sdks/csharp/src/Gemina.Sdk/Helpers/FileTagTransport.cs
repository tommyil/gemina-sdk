using System;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Client;
using Gemina.Sdk.Client.Auth;
using Gemina.Sdk.Model;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using RestSharp;

namespace Gemina.Sdk
{
    /// <summary>
    /// Internal transport seam for the two FileTag upload calls, injectable
    /// in tests. Returns the full <see cref="ApiResponse{T}"/> (status code,
    /// response headers, parsed data, raw body) and does NOT apply the
    /// exception factory — the decorator does, mirroring the generated call
    /// sites.
    /// </summary>
    internal interface IFileTagTransport
    {
        /// <summary>Uploads to <c>POST /api/v1/filetag</c> (multipart, API-key auth).</summary>
        Task<ApiResponse<FileTagResultOutDTO>> TagDocumentWithHttpInfoAsync(
            Stream file,
            CancellationToken cancellationToken);

        /// <summary>Uploads to <c>POST /api/v1/filetag/user</c> (multipart, JWT + API-key-id auth).</summary>
        Task<ApiResponse<FileTagResultOutDTO>> TagDocumentByUserWithHttpInfoAsync(
            Stream file,
            CancellationToken cancellationToken);
    }

    /// <summary>
    /// Hand-rolled transport for the FileTag upload calls the generated
    /// client gets wrong, reusing the same RestSharp stack and
    /// <see cref="IReadableConfiguration"/> (base path, auth, default
    /// headers, user-agent, timeout, proxy, certificates, OAuth) — mirroring
    /// <see cref="DocumentTransport"/>'s structure.
    ///
    /// The generated <c>ApiClient</c> passes NO content type to
    /// <c>RestSharp.AddFile</c>, so every FileTag upload goes out as
    /// <c>application/octet-stream</c> (and non-<c>FileStream</c> streams get
    /// the filename <c>no_file_name_provided</c>). The FileTag endpoint is
    /// content-type-driven, so those uploads are rejected. This transport
    /// resolves the part's content type and filename via
    /// <see cref="MediaTypeResolver"/> instead.
    ///
    /// Behaviours preserved from the generated pipeline:
    /// <list type="bullet">
    /// <item><description><see cref="IReadableConfiguration.DefaultHeaders"/>
    /// are applied to every request (generated <c>ApiClient.NewRequest</c>).</description></item>
    /// <item><description>When OAuth client credentials are configured, the
    /// same <see cref="OAuthAuthenticator"/> is attached to acquire a token
    /// (generated <c>ApiClient.ExecClientAsync</c> attaches it for every call
    /// when configured, not per endpoint).</description></item>
    /// <item><description>Error responses are NOT thrown here: the response
    /// (with raw body and headers) is returned so the decorator can apply the
    /// caller's <c>ExceptionFactory</c> exactly like generated call sites do.
    /// FileTag has no "failed-result-in-500-body" contract — error bodies are
    /// the standard envelope — so the default factory's plain
    /// <see cref="ApiException"/> is correct.</description></item>
    /// </list>
    /// </summary>
    internal sealed class FileTagTransport : IFileTagTransport
    {
        private const string TagDocumentPath = "/api/v1/filetag";
        private const string TagDocumentByUserPath = "/api/v1/filetag/user";

        // Mirrors the generated ApiClient's serializer settings, with the same
        // defensive null-tolerance DocumentTransport uses for members the
        // generated models wrongly type as non-nullable.
        private static readonly JsonSerializerSettings SerializerSettings = new JsonSerializerSettings
        {
            ConstructorHandling = ConstructorHandling.AllowNonPublicDefaultConstructor,
            ContractResolver = new DefaultContractResolver
            {
                NamingStrategy = new CamelCaseNamingStrategy
                {
                    OverrideSpecifiedNames = false,
                },
            },
            Error = (sender, args) =>
            {
                var message = args.ErrorContext.Error?.Message;
                if (message != null && message.StartsWith("Cannot convert null value", StringComparison.Ordinal))
                {
                    args.ErrorContext.Handled = true;
                }
            },
        };

        private readonly IReadableConfiguration _configuration;

        internal FileTagTransport(IReadableConfiguration configuration)
        {
            _configuration = configuration;
        }

        /// <inheritdoc />
        public Task<ApiResponse<FileTagResultOutDTO>> TagDocumentWithHttpInfoAsync(
            Stream file,
            CancellationToken cancellationToken)
        {
            // The raw-key server-to-server endpoint authenticates with
            // X-API-Key only (the generated code adds no bearer here either).
            return TagAsync(TagDocumentPath, "TagDocument", includeBearer: false, file: file, cancellationToken: cancellationToken);
        }

        /// <inheritdoc />
        public Task<ApiResponse<FileTagResultOutDTO>> TagDocumentByUserWithHttpInfoAsync(
            Stream file,
            CancellationToken cancellationToken)
        {
            // The browser-safe endpoint authenticates with the JWT bearer plus
            // the API key *id* in X-API-Key.
            return TagAsync(TagDocumentByUserPath, "TagDocumentByUser", includeBearer: true, file: file, cancellationToken: cancellationToken);
        }

        private Task<ApiResponse<FileTagResultOutDTO>> TagAsync(
            string path,
            string operationName,
            bool includeBearer,
            Stream file,
            CancellationToken cancellationToken)
        {
            if (file == null)
            {
                // Same guard (and message) as the generated FileTagApi.
                throw new ApiException(400, $"Missing required parameter 'file' when calling FileTagApi->{operationName}");
            }

            var request = NewRequest(path, includeBearer);
            request.AlwaysMultipartFormData = true;

            // A FileStream carries the real name; other streams synthesize
            // "document" + the sniffed extension inside the resolver.
            string fileName = null;
            if (file is FileStream fileStream)
            {
                fileName = Path.GetFileName(fileStream.Name);
            }

            var bytes = ClientUtils.ReadAsBytes(file);
            var contentType = MediaTypeResolver.ResolveContentTypeAndFileName(bytes, ref fileName);
            request.AddFile("file", bytes, fileName, contentType);

            return ExecuteAsync(request, operationName, cancellationToken);
        }

        private RestRequest NewRequest(string path, bool includeBearer)
        {
            var request = new RestRequest(path, Method.Post);

            // Configuration default headers first, then per-request headers on
            // top — same precedence as the generated ApiClient.NewRequest.
            if (_configuration.DefaultHeaders != null)
            {
                foreach (var headerParam in _configuration.DefaultHeaders)
                {
                    request.AddHeader(headerParam.Key, headerParam.Value);
                }
            }

            request.AddOrUpdateHeader("Accept", "application/json");

            var apiKey = _configuration.GetApiKeyWithPrefix("X-API-Key");
            if (!string.IsNullOrEmpty(apiKey))
            {
                request.AddOrUpdateHeader("X-API-Key", apiKey);
            }

            if (includeBearer && !string.IsNullOrEmpty(_configuration.AccessToken))
            {
                request.AddOrUpdateHeader("Authorization", "Bearer " + _configuration.AccessToken);
            }

            return request;
        }

        private async Task<ApiResponse<FileTagResultOutDTO>> ExecuteAsync(
            RestRequest request, string operationName, CancellationToken cancellationToken)
        {
            var clientOptions = new RestClientOptions(_configuration.BasePath)
            {
                ClientCertificates = _configuration.ClientCertificates,
                Timeout = _configuration.Timeout,
                Proxy = _configuration.Proxy,
                UserAgent = _configuration.UserAgent,
                UseDefaultCredentials = _configuration.UseDefaultCredentials,
                RemoteCertificateValidationCallback = _configuration.RemoteCertificateValidationCallback,
            };

            // Mirror the generated ApiClient: when OAuth client credentials
            // are configured, attach the token-acquiring authenticator (the
            // generated code does this for every call, unconditionally on the
            // endpoint, whenever the four settings are present).
            if (!string.IsNullOrEmpty(_configuration.OAuthTokenUrl) &&
                !string.IsNullOrEmpty(_configuration.OAuthClientId) &&
                !string.IsNullOrEmpty(_configuration.OAuthClientSecret) &&
                _configuration.OAuthFlow != null)
            {
                clientOptions.Authenticator = new OAuthAuthenticator(
                    _configuration.OAuthTokenUrl,
                    _configuration.OAuthClientId,
                    _configuration.OAuthClientSecret,
                    _configuration.OAuthScope,
                    _configuration.OAuthFlow,
                    SerializerSettings,
                    _configuration);
            }

            using (var client = new RestClient(clientOptions))
            {
                var response = await client.ExecuteAsync(request, cancellationToken).ConfigureAwait(false);

                // Pure transport failures (DNS, TLS, connect) pass through unwrapped,
                // matching the generated client's behaviour.
                if (response.ErrorException != null && (int)response.StatusCode == 0)
                {
                    throw response.ErrorException;
                }

                return HandleResponse(
                    (int)response.StatusCode,
                    response.Content,
                    CollectHeaders(response),
                    operationName);
            }
        }

        /// <summary>
        /// Maps an HTTP response to a full <see cref="ApiResponse{T}"/>
        /// carrying status, headers, parsed data and raw body. Statuses
        /// &gt;= 400 are returned unparsed (data <c>null</c>) for the
        /// decorator's <c>ExceptionFactory</c> to turn into the same
        /// <see cref="ApiException"/> the generated code produces. A success
        /// status with an empty or unparseable body throws
        /// <see cref="GeminaException"/> (the generated pipeline would return
        /// a silent <c>null</c> — the same defect DocumentTransport exists to
        /// fix). Internal + static so unit tests can exercise it offline with
        /// crafted bodies.
        /// </summary>
        internal static ApiResponse<FileTagResultOutDTO> HandleResponse(
            int statusCode, string content, Multimap<string, string> headers, string operationName)
        {
            if (statusCode >= 400)
            {
                return new ApiResponse<FileTagResultOutDTO>(
                    (HttpStatusCode)statusCode, headers ?? new Multimap<string, string>(), null, content);
            }

            if (string.IsNullOrEmpty(content))
            {
                throw new GeminaException(
                    $"Malformed server response: HTTP {statusCode} from {operationName} with an empty body.");
            }

            var result = JsonConvert.DeserializeObject<FileTagResultOutDTO>(content, SerializerSettings);
            if (result == null)
            {
                throw new GeminaException(
                    $"Malformed server response: could not parse the body returned by {operationName}.");
            }

            return new ApiResponse<FileTagResultOutDTO>(
                (HttpStatusCode)statusCode, headers ?? new Multimap<string, string>(), result, content);
        }

        private static Multimap<string, string> CollectHeaders(RestResponse response)
        {
            // Same header surfacing as the generated ApiClient.ToApiResponse.
            var headers = new Multimap<string, string>();
            if (response.Headers != null)
            {
                foreach (var responseHeader in response.Headers)
                {
                    headers.Add(responseHeader.Name, ClientUtils.ParameterToString(responseHeader.Value));
                }
            }

            if (response.ContentHeaders != null)
            {
                foreach (var responseHeader in response.ContentHeaders)
                {
                    headers.Add(responseHeader.Name, ClientUtils.ParameterToString(responseHeader.Value));
                }
            }

            return headers;
        }
    }
}
