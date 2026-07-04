using Gemina.Sdk.Client;
using Gemina.Sdk.Model;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// Offline tests for the transport's response mapping (contract §2.4a and
    /// the null-tolerant deserialization): crafted HTTP status + body pairs,
    /// no network.
    /// </summary>
    public class DocumentTransportTests
    {
        private const string CorrelationId = "aacc54d2-1bee-4114-8c80-92cb5148a098";

        private const string FailedResultBody =
            "{\"status\":\"failed\"," +
            "\"meta\":{\"correlationId\":\"" + CorrelationId + "\"}," +
            "\"data\":null," +
            "\"errors\":[{\"error_code\":\"PROCESSING_ERROR\",\"description\":\"unreadable document\"}]}";

        private const string InProcessResultBody =
            "{\"status\":\"in_process\"," +
            "\"meta\":{\"correlationId\":\"" + CorrelationId + "\"}," +
            "\"data\":null,\"errors\":[]}";

        // Mirrors a real completed poll body: purgeReason/purgedAt are null but
        // the generated model types purgeReason as a non-nullable enum — the
        // null-tolerant serializer settings must keep parsing (round-1 defect).
        private const string SuccessBodyWithNullPurgeReason =
            "{\"status\":\"success\"," +
            "\"meta\":{\"correlationId\":\"" + CorrelationId + "\",\"documentId\":\"28677df7-033a-409f-8b70-1568ddd17ea0\"}," +
            "\"data\":{\"extractions\":[{" +
            "\"status\":\"success\"," +
            "\"meta\":{\"extractionType\":\"invoice_headers\",\"modelType\":\"velox\",\"thinking\":false," +
            "\"correction\":false,\"evaluation\":false,\"includeCoordinates\":true," +
            "\"processorClass\":\"InvoiceHeaderAnalysisProcessor\"," +
            "\"purgeAt\":\"2026-08-03T17:20:13.180624\",\"purgedAt\":null,\"purgeReason\":null}," +
            "\"values\":{\"totalAmount\":{\"value\":1572.0,\"coordinates\":null,\"confidence\":null}}," +
            "\"errors\":[]}]}," +
            "\"errors\":[]}";

        // ---- Contract §2.4a: failed usually arrives as HTTP 500 with the result as body ----

        [Fact]
        public void HandleResponse_500WithFailedResultBody_ThrowsProcessingExceptionCarryingResult()
        {
            var ex = Assert.Throws<GeminaProcessingException>(
                () => DocumentTransport.HandleResponse(500, FailedResultBody, "GetDocumentProcessingResultByCorrelationId"));

            Assert.Equal(ResponseStatus.Failed, ex.Result.Status);
            Assert.Equal(CorrelationId, ex.Result.Meta.CorrelationId.ToString());
            Assert.Single(ex.Result.Errors);
        }

        [Fact]
        public void HandleResponse_Submit500WithFailedResultBody_ThrowsProcessingException()
        {
            // Same mapping applies to the multipart submit path.
            var ex = Assert.Throws<GeminaProcessingException>(
                () => DocumentTransport.HandleResponse(500, FailedResultBody, "CreateDocumentProcessingRequest"));
            Assert.Equal(ResponseStatus.Failed, ex.Result.Status);
        }

        [Fact]
        public void HandleResponse_500WithNonResultJsonBody_ThrowsOriginalApiException()
        {
            var ex = Assert.Throws<ApiException>(
                () => DocumentTransport.HandleResponse(500, "{\"detail\":\"boom\"}", "GetDocumentProcessingResultByCorrelationId"));

            Assert.Equal(500, ex.ErrorCode);
            Assert.Contains("boom", (string)ex.ErrorContent);
        }

        [Fact]
        public void HandleResponse_500WithPlainTextBody_ThrowsOriginalApiException()
        {
            var ex = Assert.Throws<ApiException>(
                () => DocumentTransport.HandleResponse(500, "upstream connect error", "GetDocumentProcessingResultByCorrelationId"));
            Assert.Equal(500, ex.ErrorCode);
        }

        [Fact]
        public void HandleResponse_500WithNonFailedResultBody_ThrowsOriginalApiException()
        {
            // A parseable result body whose status is NOT failed keeps the transport error.
            var ex = Assert.Throws<ApiException>(
                () => DocumentTransport.HandleResponse(500, InProcessResultBody, "GetDocumentProcessingResultByCorrelationId"));
            Assert.Equal(500, ex.ErrorCode);
        }

        [Fact]
        public void HandleResponse_AuthErrorEnvelope_ThrowsOriginalApiExceptionNotProcessing()
        {
            // Gemina's generic error envelope (auth/quota) also says
            // status=failed but always carries meta:null — it is NOT a
            // document result and must stay a transport error, matching the
            // other language SDKs (their stricter deserializers reject it).
            const string authEnvelope =
                "{\"servedAt\":\"2026-07-04T16:03:00.189227\",\"status\":\"failed\"," +
                "\"meta\":null,\"data\":null," +
                "\"errors\":[{\"error_code\":\"UNAUTHORIZED_ERROR\"," +
                "\"description\":\"API Key Unauthorized: Missing API Key\"}]}";

            var ex = Assert.Throws<ApiException>(
                () => DocumentTransport.HandleResponse(401, authEnvelope, "GetDocumentProcessingResultByCorrelationId"));
            Assert.Equal(401, ex.ErrorCode);
        }

        // ---- Success-path parsing ----

        [Fact]
        public void HandleResponse_202WithInProcessBody_ReturnsParsedResult()
        {
            var result = DocumentTransport.HandleResponse(202, InProcessResultBody, "GetDocumentProcessingResultByCorrelationId");

            Assert.Equal(ResponseStatus.InProcess, result.Status);
            Assert.Equal(CorrelationId, result.Meta.CorrelationId.ToString());
        }

        [Fact]
        public void HandleResponse_200WithNullPurgeReason_ParsesDespiteNonNullableGeneratedEnum()
        {
            var result = DocumentTransport.HandleResponse(200, SuccessBodyWithNullPurgeReason, "GetDocumentProcessingResultByCorrelationId");

            Assert.Equal(ResponseStatus.Success, result.Status);
            var extraction = Assert.Single(result.Data.Extractions);
            Assert.Equal(ExtractionTypeModel.InvoiceHeaders, extraction.Meta.ExtractionType);
            Assert.True(extraction.Values.ContainsKey("totalAmount"));
        }

        [Fact]
        public void HandleResponse_200WithFailedBody_ReturnsResultForCallerTerminalHandling()
        {
            // Defensive contract note: failed-in-200 is handled by the polling
            // loop's terminal handling, so the transport just returns it.
            var result = DocumentTransport.HandleResponse(200, FailedResultBody, "GetDocumentProcessingResultByCorrelationId");
            Assert.Equal(ResponseStatus.Failed, result.Status);
        }

        [Fact]
        public void HandleResponse_200WithEmptyBody_ThrowsGeminaException()
        {
            Assert.Throws<GeminaException>(
                () => DocumentTransport.HandleResponse(200, "", "GetDocumentProcessingResultByCorrelationId"));
        }

        // ---- TryParseFailedResult edge cases ----

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("Internal Server Error")]
        [InlineData("{\"detail\":[{\"msg\":\"invalid\"}]}")]
        [InlineData("{}")]
        public void TryParseFailedResult_NonFailedOrUnparseable_ReturnsNull(string content)
        {
            Assert.Null(DocumentTransport.TryParseFailedResult(content));
        }

        [Fact]
        public void TryParseFailedResult_FailedBody_ReturnsResult()
        {
            var result = DocumentTransport.TryParseFailedResult(FailedResultBody);

            Assert.NotNull(result);
            Assert.Equal(ResponseStatus.Failed, result.Status);
        }
    }
}
