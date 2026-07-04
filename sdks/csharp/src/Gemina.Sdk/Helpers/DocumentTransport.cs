using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using RestSharp;

namespace Gemina.Sdk
{
    /// <summary>
    /// Internal transport seam for the document submit + poll flow,
    /// injectable in tests.
    /// </summary>
    internal interface IDocumentTransport
    {
        /// <summary>Submits the document to <c>POST /api/v1/documents/requests</c> (multipart).</summary>
        Task<DocumentProcessingResultOutDTO> SubmitMultipartAsync(
            Stream file,
            string fileName,
            string externalId,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options,
            CancellationToken cancellationToken);

        /// <summary>Polls <c>GET /api/v1/documents/results/{correlationId}</c>.</summary>
        Task<DocumentProcessingResultOutDTO> GetResultAsync(
            Guid correlationId,
            CancellationToken cancellationToken);
    }

    /// <summary>
    /// Hand-rolled transport for the two document-processing calls the
    /// generated client gets wrong, reusing the same RestSharp stack and
    /// <see cref="IReadableConfiguration"/> (base path, auth, user-agent,
    /// timeout, proxy, certificates):
    ///
    /// 1. <b>Multipart submit</b> — the API (FastAPI <c>List[...] = Form(...)</c>)
    ///    requires REPEATED <c>extraction_types</c> form fields.
    ///    <c>DocumentApi.CreateDocumentProcessingRequestAsync</c> cannot produce
    ///    that shape: <c>RequestOptions.FormParameters</c> is a
    ///    <c>Dictionary&lt;string, string&gt;</c> (no repeated keys) and the generated
    ///    code JSON-serializes the whole list into a single field, which the
    ///    server rejects with a 422.
    ///
    /// 2. <b>Result polling</b> — completed results carry
    ///    <c>extractions[*].meta.purgeReason: null</c>, but the generated
    ///    <c>ExtractionMetaOutDTO.PurgeReason</c> is a non-nullable enum (an
    ///    OpenAPI-3.1 nullable-enum generator defect). Json.NET throws,
    ///    RestSharp swallows the error, and
    ///    <c>GetDocumentProcessingResultByCorrelationIdAsync</c> silently
    ///    returns <c>null</c> for every finished document. This transport
    ///    deserializes with an error handler that tolerates nulls in such
    ///    wrongly-non-nullable members (leaving them at their default).
    /// </summary>
    internal sealed class DocumentTransport : IDocumentTransport
    {
        private const string SubmitPath = "/api/v1/documents/requests";
        private const string ResultPathTemplate = "/api/v1/documents/results/{0}";

        // Mirrors the generated ApiClient's serializer settings, plus the
        // null-tolerance described on the class.
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
                    // A null in a member the generated model wrongly types as
                    // non-nullable (e.g. purgeReason) — keep the default value.
                    args.ErrorContext.Handled = true;
                }
            },
        };

        private readonly IReadableConfiguration _configuration;

        internal DocumentTransport(IReadableConfiguration configuration)
        {
            _configuration = configuration;
        }

        /// <inheritdoc />
        public Task<DocumentProcessingResultOutDTO> SubmitMultipartAsync(
            Stream file,
            string fileName,
            string externalId,
            List<ExtractionTypeModel> extractionTypes,
            ProcessDocumentOptions options,
            CancellationToken cancellationToken)
        {
            var request = NewRequest(SubmitPath, Method.Post);
            request.AlwaysMultipartFormData = true;

            request.AddParameter("external_id", externalId);
            foreach (var extractionType in extractionTypes)
            {
                // One field per value — the repeated-form-field shape FastAPI expects.
                request.AddParameter("extraction_types", ClientUtils.ParameterToString(extractionType, _configuration));
            }

            if (options.Correction.HasValue)
            {
                request.AddParameter("correction", ClientUtils.ParameterToString(options.Correction.Value, _configuration));
            }

            if (options.EndUserId != null)
            {
                request.AddParameter("end_user_id", options.EndUserId);
            }

            if (options.Evaluation.HasValue)
            {
                request.AddParameter("evaluation", ClientUtils.ParameterToString(options.Evaluation.Value, _configuration));
            }

            if (options.IncludeCoordinates.HasValue)
            {
                request.AddParameter("include_coordinates", ClientUtils.ParameterToString(options.IncludeCoordinates.Value, _configuration));
            }

            if (options.ModelType.HasValue)
            {
                request.AddParameter("model_type", ClientUtils.ParameterToString(options.ModelType.Value, _configuration));
            }

            if (options.TemplateId.HasValue)
            {
                request.AddParameter("template_id", options.TemplateId.Value.ToString());
            }

            if (options.Thinking.HasValue)
            {
                request.AddParameter("thinking", ClientUtils.ParameterToString(options.Thinking.Value, _configuration));
            }

            var bytes = ClientUtils.ReadAsBytes(file);
            var contentType = ResolveContentTypeAndFileName(bytes, ref fileName);
            request.AddFile("file", bytes, fileName, contentType);

            return ExecuteAsync(request, "CreateDocumentProcessingRequest", cancellationToken);
        }

        /// <inheritdoc />
        public Task<DocumentProcessingResultOutDTO> GetResultAsync(
            Guid correlationId,
            CancellationToken cancellationToken)
        {
            var request = NewRequest(string.Format(ResultPathTemplate, correlationId), Method.Get);
            return ExecuteAsync(request, "GetDocumentProcessingResultByCorrelationId", cancellationToken);
        }

        private RestRequest NewRequest(string path, Method method)
        {
            var request = new RestRequest(path, method);
            request.AddHeader("Accept", "application/json");

            var apiKey = _configuration.GetApiKeyWithPrefix("X-API-Key");
            if (!string.IsNullOrEmpty(apiKey))
            {
                request.AddHeader("X-API-Key", apiKey);
            }

            if (!string.IsNullOrEmpty(_configuration.AccessToken))
            {
                request.AddHeader("Authorization", "Bearer " + _configuration.AccessToken);
            }

            return request;
        }

        private async Task<DocumentProcessingResultOutDTO> ExecuteAsync(
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

            using (var client = new RestClient(clientOptions))
            {
                var response = await client.ExecuteAsync(request, cancellationToken).ConfigureAwait(false);

                // Pure transport failures (DNS, TLS, connect) pass through unwrapped,
                // matching the generated client's behaviour.
                if (response.ErrorException != null && (int)response.StatusCode == 0)
                {
                    throw response.ErrorException;
                }

                return HandleResponse((int)response.StatusCode, response.Content, operationName);
            }
        }

        /// <summary>
        /// Maps an HTTP response to a result or an exception. Terminal
        /// <c>failed</c> results usually arrive as HTTP 500 whose body IS the
        /// result model (contract §2.4a): error responses whose body parses to
        /// a <c>failed</c> result throw <see cref="GeminaProcessingException"/>
        /// carrying it; any other error body keeps the plain
        /// <see cref="ApiException"/>. Internal + static so unit tests can
        /// exercise it offline with crafted bodies.
        /// </summary>
        internal static DocumentProcessingResultOutDTO HandleResponse(int statusCode, string content, string operationName)
        {
            if (statusCode >= 400)
            {
                var failedResult = TryParseFailedResult(content);
                if (failedResult != null)
                {
                    throw new GeminaProcessingException(failedResult);
                }

                throw new ApiException(
                    statusCode,
                    $"Error calling {operationName}: {content}",
                    content);
            }

            if (string.IsNullOrEmpty(content))
            {
                throw new GeminaException(
                    $"Malformed server response: HTTP {statusCode} from {operationName} with an empty body.");
            }

            var result = JsonConvert.DeserializeObject<DocumentProcessingResultOutDTO>(content, SerializerSettings);
            if (result == null)
            {
                throw new GeminaException(
                    $"Malformed server response: could not parse the body returned by {operationName}.");
            }

            return result;
        }

        /// <summary>
        /// Attempts to parse an error-response body as a terminal
        /// <c>failed</c> <see cref="DocumentProcessingResultOutDTO"/>.
        /// Returns null for unparseable bodies, any non-<c>failed</c> status,
        /// or bodies without <c>meta</c> (the caller keeps the original
        /// transport error then). The <c>meta</c> requirement distinguishes a
        /// genuine document result from Gemina's generic error envelope —
        /// auth/quota errors also carry <c>status: "failed"</c> but always
        /// <c>meta: null</c>, and must surface as transport errors (matching
        /// the other language SDKs, whose stricter deserializers reject the
        /// envelope outright).
        /// </summary>
        internal static DocumentProcessingResultOutDTO TryParseFailedResult(string content)
        {
            if (string.IsNullOrEmpty(content))
            {
                return null;
            }

            try
            {
                var parsed = JsonConvert.DeserializeObject<DocumentProcessingResultOutDTO>(content, SerializerSettings);
                return parsed != null && parsed.Status == Model.ResponseStatus.Failed && parsed.Meta != null
                    ? parsed
                    : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// Picks the multipart file part's content type (and a fallback file
        /// name) from magic bytes, falling back to the file name's extension.
        /// The API accepts an upload when either the MIME type or the file
        /// extension is recognised.
        /// </summary>
        private static string ResolveContentTypeAndFileName(byte[] bytes, ref string fileName)
        {
            string sniffedType = null;
            string sniffedExtension = null;

            if (bytes.Length >= 12)
            {
                if (bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
                {
                    sniffedType = "image/png";
                    sniffedExtension = ".png";
                }
                else if (bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
                {
                    sniffedType = "image/jpeg";
                    sniffedExtension = ".jpg";
                }
                else if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x38)
                {
                    sniffedType = "image/gif";
                    sniffedExtension = ".gif";
                }
                else if (bytes[0] == 0x25 && bytes[1] == 0x50 && bytes[2] == 0x44 && bytes[3] == 0x46)
                {
                    sniffedType = "application/pdf";
                    sniffedExtension = ".pdf";
                }
                else if (bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
                         && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
                {
                    sniffedType = "image/webp";
                    sniffedExtension = ".webp";
                }
            }

            if (string.IsNullOrEmpty(fileName))
            {
                fileName = "document" + (sniffedExtension ?? string.Empty);
            }

            if (sniffedType != null)
            {
                return sniffedType;
            }

            switch (Path.GetExtension(fileName).ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".pdf": return "application/pdf";
                default: return "application/octet-stream";
            }
        }
    }
}
