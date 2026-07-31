using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;
using Moq;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// Offline tests for the FileTag transport's response mapping and the
    /// decorator's exception-factory application: crafted HTTP status + body
    /// pairs, no network. Error behaviour must match the generated
    /// FileTagApi (response returned with raw body; the caller's
    /// ExceptionFactory turns &gt;= 400 into a plain ApiException) so the
    /// decorator is drop-in.
    /// </summary>
    public class FileTagTransportTests
    {
        internal const string ResultBody =
            "{\"documentExtractionId\":\"5c1e0e6b-4b62-49a1-8f61-0d2b8b1e8f8b\"," +
            "\"documentId\":\"28677df7-033a-409f-8b70-1568ddd17ea0\"," +
            "\"enrichedFileExpiresAt\":\"2026-07-31T12:00:00Z\"," +
            "\"enrichedFileExpiresInSeconds\":3600," +
            "\"enrichedFileUrl\":\"https://storage.example.test/enriched.pdf\"," +
            "\"filenamePatterns\":{" +
            "\"dateFirst\":\"2026-07-01_acme_invoice.pdf\"," +
            "\"dateFirstFull\":\"2026-07-01_acme_invoice_123.pdf\"," +
            "\"typeFirst\":\"invoice_acme_2026-07-01.pdf\"," +
            "\"typeFirstFull\":\"invoice_acme_2026-07-01_123.pdf\"," +
            "\"vendorFirst\":\"acme_invoice_2026-07-01.pdf\"," +
            "\"vendorFirstFull\":\"acme_invoice_2026-07-01_123.pdf\"}," +
            "\"metadata\":{\"title\":\"Acme invoice\"}," +
            "\"nextAction\":{\"expiresInSeconds\":3600," +
            "\"saveAs\":\"2026-07-01_acme_invoice.pdf\"," +
            "\"url\":\"https://storage.example.test/enriched.pdf\"}," +
            "\"suggestedFilename\":\"2026-07-01_acme_invoice.pdf\"}";

        private const string ErrorEnvelopeBody =
            "{\"status\":\"failed\",\"meta\":null,\"data\":null," +
            "\"errors\":[{\"error_code\":\"INVALID_API_KEY\",\"description\":\"invalid key\"}]}";

        // ---- Transport response mapping ----

        [Fact]
        public void HandleResponse_200_ReturnsApiResponseWithParsedDataAndHeaders()
        {
            var headers = new Multimap<string, string> { { "X-Request-Id", "abc-123" } };

            var response = FileTagTransport.HandleResponse(200, ResultBody, headers, "TagDocument");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("2026-07-01_acme_invoice.pdf", response.Data.SuggestedFilename);
            Assert.Equal(ResultBody, response.RawContent);
            Assert.Equal("abc-123", Assert.Single(response.Headers["X-Request-Id"]));
        }

        [Fact]
        public void HandleResponse_ErrorStatus_ReturnsResponseUnthrownForTheExceptionFactory()
        {
            var response = FileTagTransport.HandleResponse(401, ErrorEnvelopeBody, null, "TagDocument");

            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.Null(response.Data);
            Assert.Equal(ErrorEnvelopeBody, response.RawContent);
        }

        [Fact]
        public void HandleResponse_200WithEmptyBody_ThrowsGeminaException()
        {
            Assert.Throws<GeminaException>(
                () => FileTagTransport.HandleResponse(200, "", null, "TagDocument"));
        }

        // ---- Decorator: exception-factory application, generated parity ----

        private static FileTagApiWithTypedUploads DecoratorWith(ApiResponse<FileTagResultOutDTO> canned)
        {
            var transport = new Mock<IFileTagTransport>(MockBehavior.Strict);
            transport
                .Setup(t => t.TagDocumentWithHttpInfoAsync(It.IsAny<Stream>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(canned);
            transport
                .Setup(t => t.TagDocumentByUserWithHttpInfoAsync(It.IsAny<Stream>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(canned);

            var decorator = new FileTagApiWithTypedUploads(new Configuration { BasePath = "https://api.example.test" })
            {
                Transport = transport.Object,
            };
            return decorator;
        }

        private static ApiResponse<FileTagResultOutDTO> ErrorResponse(int status)
        {
            return new ApiResponse<FileTagResultOutDTO>(
                (HttpStatusCode)status, new Multimap<string, string>(), null, ErrorEnvelopeBody);
        }

        private static Stream SomeFile()
        {
            return new MemoryStream(Encoding.ASCII.GetBytes("%PDF-1.7 ..........."));
        }

        [Fact]
        public async Task TagDocumentAsync_ErrorResponse_ThrowsPlainApiExceptionLikeGeneratedFactory()
        {
            var decorator = DecoratorWith(ErrorResponse(401));

            var exception = await Assert.ThrowsAsync<ApiException>(
                () => decorator.TagDocumentAsync(SomeFile()));

            Assert.Equal(401, exception.ErrorCode);
            Assert.Contains("Error calling TagDocument", exception.Message);
            Assert.Equal(ErrorEnvelopeBody, exception.ErrorContent);
        }

        [Fact]
        public void TagDocumentByUser_Sync_ErrorResponse_ThrowsApiException()
        {
            var decorator = DecoratorWith(ErrorResponse(500));

            var exception = Assert.Throws<ApiException>(
                () => decorator.TagDocumentByUser(SomeFile()));

            Assert.Equal(500, exception.ErrorCode);
            Assert.Contains("Error calling TagDocumentByUser", exception.Message);
        }

        [Fact]
        public async Task TagDocumentWithHttpInfoAsync_NullExceptionFactory_ReturnsErrorResponseUnthrown()
        {
            // Callers may clear the factory to inspect raw responses; the
            // decorator must honour that like generated call sites do.
            var decorator = DecoratorWith(ErrorResponse(429));
            decorator.ExceptionFactory = null;

            var response = await decorator.TagDocumentWithHttpInfoAsync(SomeFile());

            Assert.Equal((HttpStatusCode)429, response.StatusCode);
            Assert.Equal(ErrorEnvelopeBody, response.RawContent);
        }

        [Fact]
        public void TagDocument_Sync_Success_ReturnsData()
        {
            var success = FileTagTransport.HandleResponse(200, ResultBody, null, "TagDocument");
            var decorator = DecoratorWith(success);

            var result = decorator.TagDocument(SomeFile());

            Assert.Equal("2026-07-01_acme_invoice.pdf", result.SuggestedFilename);
        }

        [Fact]
        public async Task TagDocumentByUserWithHttpInfoAsync_Success_ReturnsTransportResponse()
        {
            var success = FileTagTransport.HandleResponse(200, ResultBody, null, "TagDocumentByUser");
            var decorator = DecoratorWith(success);

            var response = await decorator.TagDocumentByUserWithHttpInfoAsync(SomeFile());

            Assert.Same(success, response);
        }
    }
}
