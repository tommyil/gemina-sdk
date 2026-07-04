using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Gemina.Sdk.Api;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;
using Moq;
using Moq.Language;
using Xunit;

namespace Gemina.Sdk.Tests
{
    public class GeminaClientTests
    {
        private static readonly List<ExtractionTypeModel> InvoiceHeaders =
            new List<ExtractionTypeModel> { ExtractionTypeModel.InvoiceHeaders };

        private static DocumentProcessingResultOutDTO Result(ResponseStatus status, Guid? correlationId = null)
        {
            return new DocumentProcessingResultOutDTO(
                data: new DocumentDataOutDTO(new List<ExtractionProcessingResultOutDTO>()),
                meta: new DocumentProcessingMetaOutDTO(correlationId: correlationId),
                status: status);
        }

        private static GeminaClient ClientWith(IDocumentTransport transport = null, IDocumentApi documents = null)
        {
            var client = new GeminaClient("test-api-key", "https://api.example.test");
            client.Transport = transport ?? new Mock<IDocumentTransport>(MockBehavior.Strict).Object;
            client.Documents = documents ?? new Mock<IDocumentApi>(MockBehavior.Strict).Object;
            return client;
        }

        private static Mock<IDocumentTransport> TransportWithSubmit(DocumentProcessingResultOutDTO submitResult)
        {
            var transport = new Mock<IDocumentTransport>(MockBehavior.Strict);
            transport
                .Setup(t => t.SubmitMultipartAsync(
                    It.IsAny<Stream>(), It.IsAny<string>(), It.IsAny<string>(),
                    It.IsAny<List<ExtractionTypeModel>>(), It.IsAny<ProcessDocumentOptions>(),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(submitResult);
            return transport;
        }

        private static ISetupSequentialResult<Task<DocumentProcessingResultOutDTO>> SetupPolls(
            Mock<IDocumentTransport> transport, Guid correlationId)
        {
            return transport.SetupSequence(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()));
        }

        private static ProcessDocumentOptions FakeDelayOptions(List<TimeSpan> delays, double random = 0.5)
        {
            return new ProcessDocumentOptions
            {
                Delay = (wait, ct) =>
                {
                    delays.Add(wait);
                    return Task.CompletedTask;
                },
                Random = () => random,
            };
        }

        // ---- Contract §3.1: happy path — submit, 2 non-terminal polls, then success ----

        [Fact]
        public async Task ProcessDocumentAsync_FileHappyPath_PollsUntilSuccessWithCorrelationId()
        {
            var correlationId = Guid.NewGuid();
            var success = Result(ResponseStatus.Success, correlationId);
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            SetupPolls(transport, correlationId)
                .ReturnsAsync(Result(ResponseStatus.InProcess, correlationId))
                .ReturnsAsync(Result(ResponseStatus.Pending, correlationId))
                .ReturnsAsync(success);

            var delays = new List<TimeSpan>();
            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1, 2, 3 }))
            {
                var result = await client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(delays));

                Assert.Same(success, result);
                Assert.Equal(ResponseStatus.Success, result.Status);
            }

            transport.Verify(
                t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()),
                Times.Exactly(3));
            Assert.Equal(3, delays.Count); // one wait before each poll
        }

        [Fact]
        public async Task ProcessDocumentAsync_SubmitAlreadyTerminal_ReturnsWithoutPolling()
        {
            var success = Result(ResponseStatus.Success, Guid.NewGuid());
            var transport = TransportWithSubmit(success); // strict: any poll would throw

            var delays = new List<TimeSpan>();
            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var result = await client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(delays));
                Assert.Same(success, result);
            }

            Assert.Empty(delays);
        }

        [Theory]
        [InlineData(ResponseStatus.Partial)]
        [InlineData(ResponseStatus.Empty)]
        public async Task ProcessDocumentAsync_PartialAndEmpty_AreReturnedNotThrown(ResponseStatus terminal)
        {
            var correlationId = Guid.NewGuid();
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            transport
                .Setup(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()))
                .ReturnsAsync(Result(terminal, correlationId));

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var result = await client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>()));
                Assert.Equal(terminal, result.Status);
            }
        }

        // ---- Contract §3.2: terminal failed → GeminaProcessingException carrying the result ----

        [Fact]
        public async Task ProcessDocumentAsync_Failed_ThrowsProcessingExceptionWithResult()
        {
            var correlationId = Guid.NewGuid();
            var failed = Result(ResponseStatus.Failed, correlationId);
            failed.Errors = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { ["error"] = "unreadable document" },
            };
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            transport
                .Setup(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()))
                .ReturnsAsync(failed);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var ex = await Assert.ThrowsAsync<GeminaProcessingException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));

                Assert.Same(failed, ex.Result);
                Assert.Equal(ResponseStatus.Failed, ex.Result.Status);
                Assert.Single(ex.Result.Errors);
            }
        }

        [Fact]
        public async Task ProcessDocumentAsync_SubmitReturnsFailed_ThrowsWithoutPolling()
        {
            var failed = Result(ResponseStatus.Failed, Guid.NewGuid());
            var transport = TransportWithSubmit(failed);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var ex = await Assert.ThrowsAsync<GeminaProcessingException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));
                Assert.Same(failed, ex.Result);
            }
        }

        // ---- Contract §3.3: never-terminal + tiny timeout → GeminaTimeoutException ----

        [Fact]
        public async Task ProcessDocumentAsync_Timeout_ThrowsTimeoutExceptionWithCorrelationIdAndLastResult()
        {
            var correlationId = Guid.NewGuid();
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            transport
                .Setup(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()))
                .ReturnsAsync(() => Result(ResponseStatus.InProcess, correlationId)); // never terminal

            var options = new ProcessDocumentOptions
            {
                TimeoutSeconds = 0.05,
                Delay = (wait, ct) => Task.Delay(TimeSpan.FromMilliseconds(15), ct), // fake, near-instant delay
                Random = () => 0.5,
            };

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var ex = await Assert.ThrowsAsync<GeminaTimeoutException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, options));

                Assert.Equal(correlationId, ex.CorrelationId);
                Assert.NotNull(ex.LastResult);
                Assert.Equal(ResponseStatus.InProcess, ex.LastResult.Status);
            }
        }

        // ---- Contract §3.4: backoff schedule 2.0 ×1.5 capped at 15, jitter in [0.8, 1.2] ----

        [Fact]
        public async Task ProcessDocumentAsync_Backoff_GrowsByHalfAndCapsAtMax()
        {
            var correlationId = Guid.NewGuid();
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            var pollSequence = SetupPolls(transport, correlationId);
            for (var i = 0; i < 6; i++)
            {
                pollSequence = pollSequence.ReturnsAsync(Result(ResponseStatus.InProcess, correlationId));
            }
            pollSequence.ReturnsAsync(Result(ResponseStatus.Success, correlationId));

            var delays = new List<TimeSpan>();
            // Random pinned to 0.5 → jitter factor exactly 1.0 → nominal schedule observed.
            var options = FakeDelayOptions(delays, random: 0.5);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                await client.ProcessDocumentAsync(stream, InvoiceHeaders, options);
            }

            var expected = new[] { 2.0, 3.0, 4.5, 6.75, 10.125, 15.0, 15.0 };
            Assert.Equal(expected.Length, delays.Count);
            for (var i = 0; i < expected.Length; i++)
            {
                Assert.Equal(expected[i], delays[i].TotalSeconds, precision: 9);
            }
        }

        [Fact]
        public async Task ProcessDocumentAsync_Jitter_StaysWithinBoundsOfNominalInterval()
        {
            var correlationId = Guid.NewGuid();
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            var pollSequence = SetupPolls(transport, correlationId);
            for (var i = 0; i < 5; i++)
            {
                pollSequence = pollSequence.ReturnsAsync(Result(ResponseStatus.InProcess, correlationId));
            }
            pollSequence.ReturnsAsync(Result(ResponseStatus.Success, correlationId));

            // Extremes of the injected RNG: 0.0 → ×0.8, ~1.0 → ×~1.2.
            var randomValues = new Queue<double>(new[] { 0.0, 0.999999, 0.0, 0.999999, 0.0, 0.999999 });
            var delays = new List<TimeSpan>();
            var options = new ProcessDocumentOptions
            {
                Delay = (wait, ct) =>
                {
                    delays.Add(wait);
                    return Task.CompletedTask;
                },
                Random = () => randomValues.Dequeue(),
            };

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                await client.ProcessDocumentAsync(stream, InvoiceHeaders, options);
            }

            var nominal = new[] { 2.0, 3.0, 4.5, 6.75, 10.125, 15.0 };
            Assert.Equal(nominal.Length, delays.Count);
            for (var i = 0; i < nominal.Length; i++)
            {
                Assert.InRange(delays[i].TotalSeconds, (0.8 * nominal[i]) - 1e-9, (1.2 * nominal[i]) + 1e-9);
            }
        }

        // ---- Contract §3.5: URL source routes to the /requests/web endpoint ----

        [Fact]
        public async Task ProcessDocumentAsync_UrlSource_UsesWebEndpoint()
        {
            const string url = "https://example.com/invoice.pdf";
            var correlationId = Guid.NewGuid();
            // Strict transport: the multipart path must not be hit for URL sources.
            var transport = new Mock<IDocumentTransport>(MockBehavior.Strict);
            var documents = new Mock<IDocumentApi>(MockBehavior.Strict);
            WebDocumentUploadInDTO submitted = null;
            documents
                .Setup(d => d.CreateWebDocumentProcessingRequestAsync(
                    It.IsAny<WebDocumentUploadInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .Callback<WebDocumentUploadInDTO, int, CancellationToken>((body, _, __) => submitted = body)
                .ReturnsAsync(Result(ResponseStatus.Success, correlationId));

            var client = ClientWith(transport.Object, documents.Object);
            var options = new ProcessDocumentOptions { ExternalId = "invoice-42", EndUserId = "user-7" };
            var result = await client.ProcessDocumentAsync(
                GeminaDocumentSource.FromUrl(url), InvoiceHeaders, options);

            Assert.Equal(ResponseStatus.Success, result.Status);
            Assert.NotNull(submitted);
            Assert.Equal(url, submitted.Url);
            Assert.Equal("invoice-42", submitted.ExternalId);
            Assert.Equal("user-7", submitted.EndUserId);
            Assert.Equal(InvoiceHeaders, submitted.ExtractionTypes);
            transport.Verify(
                t => t.SubmitMultipartAsync(
                    It.IsAny<Stream>(), It.IsAny<string>(), It.IsAny<string>(),
                    It.IsAny<List<ExtractionTypeModel>>(), It.IsAny<ProcessDocumentOptions>(),
                    It.IsAny<CancellationToken>()),
                Times.Never);
        }

        // ---- Option passthrough + externalId defaulting on the multipart path ----

        [Fact]
        public async Task ProcessDocumentAsync_FileSource_ForwardsOptionsAndDefaultsExternalId()
        {
            var templateId = Guid.NewGuid();
            string capturedExternalId = null;
            ProcessDocumentOptions capturedOptions = null;
            List<ExtractionTypeModel> capturedTypes = null;
            var transport = new Mock<IDocumentTransport>(MockBehavior.Strict);
            transport
                .Setup(t => t.SubmitMultipartAsync(
                    It.IsAny<Stream>(), It.IsAny<string>(), It.IsAny<string>(),
                    It.IsAny<List<ExtractionTypeModel>>(), It.IsAny<ProcessDocumentOptions>(),
                    It.IsAny<CancellationToken>()))
                .Callback<Stream, string, string, List<ExtractionTypeModel>, ProcessDocumentOptions, CancellationToken>(
                    (_, __, externalId, types, opts, ___) =>
                    {
                        capturedExternalId = externalId;
                        capturedTypes = types;
                        capturedOptions = opts;
                    })
                .ReturnsAsync(Result(ResponseStatus.Success, Guid.NewGuid()));

            var client = ClientWith(transport.Object);
            var options = new ProcessDocumentOptions { TemplateId = templateId, Thinking = true };
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                await client.ProcessDocumentAsync(stream, InvoiceHeaders, options);
            }

            Assert.False(string.IsNullOrEmpty(capturedExternalId)); // auto-generated GUID
            Assert.True(Guid.TryParse(capturedExternalId, out _));
            Assert.Same(options, capturedOptions);
            Assert.Equal(templateId, capturedOptions.TemplateId);
            Assert.True(capturedOptions.Thinking);
            Assert.Equal(InvoiceHeaders, capturedTypes);
        }

        // ---- Malformed server response: non-terminal without correlationId ----

        [Fact]
        public async Task ProcessDocumentAsync_NonTerminalWithoutCorrelationId_ThrowsGeminaException()
        {
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId: null));

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var ex = await Assert.ThrowsAsync<GeminaException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));
                Assert.Contains("correlationId", ex.Message);
            }
        }

        // ---- Contract §2 step 3: transient poll failures are retried ----

        [Fact]
        public async Task ProcessDocumentAsync_TwoTransientPollFailuresThenSuccess_ContinuesOnSameBackoffSchedule()
        {
            var correlationId = Guid.NewGuid();
            var success = Result(ResponseStatus.Success, correlationId);
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            SetupPolls(transport, correlationId)
                .ThrowsAsync(new ApiException(503, "upstream connect error"))
                .ThrowsAsync(new ApiException(502, "bad gateway"))
                .ReturnsAsync(success);

            var delays = new List<TimeSpan>();
            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var result = await client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(delays));
                Assert.Same(success, result);
            }

            transport.Verify(
                t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()),
                Times.Exactly(3));
            // Failures consume attempts on the SAME backoff schedule.
            Assert.Equal(new[] { 2.0, 3.0, 4.5 }, delays.ConvertAll(d => d.TotalSeconds));
        }

        [Fact]
        public async Task ProcessDocumentAsync_ThreeConsecutivePollFailures_RethrowsLastErrorUnchanged()
        {
            var correlationId = Guid.NewGuid();
            var lastError = new ApiException(503, "third failure");
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            SetupPolls(transport, correlationId)
                .ThrowsAsync(new ApiException(503, "first failure"))
                .ThrowsAsync(new TimeoutException("second failure"))
                .ThrowsAsync(lastError);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var caught = await Assert.ThrowsAsync<ApiException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));
                Assert.Same(lastError, caught);
            }

            transport.Verify(
                t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()),
                Times.Exactly(3));
        }

        [Fact]
        public async Task ProcessDocumentAsync_SuccessfulPollResetsTransientFailureCounter()
        {
            var correlationId = Guid.NewGuid();
            var success = Result(ResponseStatus.Success, correlationId);
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            // fail, fail, ok(non-terminal — resets counter), fail, fail, ok(terminal):
            // never 3 consecutive, so the flow completes.
            SetupPolls(transport, correlationId)
                .ThrowsAsync(new ApiException(503, "t1"))
                .ThrowsAsync(new ApiException(503, "t2"))
                .ReturnsAsync(Result(ResponseStatus.InProcess, correlationId))
                .ThrowsAsync(new ApiException(503, "t3"))
                .ThrowsAsync(new ApiException(503, "t4"))
                .ReturnsAsync(success);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var result = await client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>()));
                Assert.Same(success, result);
            }

            transport.Verify(
                t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()),
                Times.Exactly(6));
        }

        // ---- Contract §2.4a: failed delivered as an HTTP error whose body is the result ----

        [Fact]
        public async Task ProcessDocumentAsync_PollThrowsProcessingException_PropagatesImmediatelyWithoutRetry()
        {
            var correlationId = Guid.NewGuid();
            var failed = Result(ResponseStatus.Failed, correlationId);
            var transport = TransportWithSubmit(Result(ResponseStatus.InProcess, correlationId));
            transport
                .Setup(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()))
                .ThrowsAsync(new GeminaProcessingException(failed));

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var ex = await Assert.ThrowsAsync<GeminaProcessingException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));
                Assert.Same(failed, ex.Result);
            }

            // Exactly one poll: a failed-result error is terminal, not transient.
            transport.Verify(
                t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()),
                Times.Once);
        }

        [Fact]
        public async Task ProcessDocumentAsync_SubmitError_IsNotRetried()
        {
            var submitError = new ApiException(503, "submit failed");
            var transport = new Mock<IDocumentTransport>(MockBehavior.Strict);
            transport
                .Setup(t => t.SubmitMultipartAsync(
                    It.IsAny<Stream>(), It.IsAny<string>(), It.IsAny<string>(),
                    It.IsAny<List<ExtractionTypeModel>>(), It.IsAny<ProcessDocumentOptions>(),
                    It.IsAny<CancellationToken>()))
                .ThrowsAsync(submitError);

            var client = ClientWith(transport.Object);
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                var caught = await Assert.ThrowsAsync<ApiException>(
                    () => client.ProcessDocumentAsync(stream, InvoiceHeaders, FakeDelayOptions(new List<TimeSpan>())));
                Assert.Same(submitError, caught);
            }

            transport.Verify(
                t => t.SubmitMultipartAsync(
                    It.IsAny<Stream>(), It.IsAny<string>(), It.IsAny<string>(),
                    It.IsAny<List<ExtractionTypeModel>>(), It.IsAny<ProcessDocumentOptions>(),
                    It.IsAny<CancellationToken>()),
                Times.Once);
        }

        [Fact]
        public async Task ProcessDocumentAsync_WebSubmit500WithFailedBody_ThrowsProcessingException()
        {
            const string failedBody =
                "{\"status\":\"failed\",\"meta\":{\"correlationId\":null},\"data\":null," +
                "\"errors\":[{\"error_code\":\"PROCESSING_ERROR\",\"description\":\"boom\"}]}";
            var documents = new Mock<IDocumentApi>(MockBehavior.Strict);
            documents
                .Setup(d => d.CreateWebDocumentProcessingRequestAsync(
                    It.IsAny<WebDocumentUploadInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .ThrowsAsync(new ApiException(500, "Error calling CreateWebDocumentProcessingRequest", failedBody));

            var client = ClientWith(documents: documents.Object);
            var ex = await Assert.ThrowsAsync<GeminaProcessingException>(
                () => client.ProcessDocumentAsync(
                    GeminaDocumentSource.FromUrl("https://example.com/invoice.pdf"), InvoiceHeaders));

            Assert.Equal(ResponseStatus.Failed, ex.Result.Status);
            Assert.Single(ex.Result.Errors);
        }

        [Fact]
        public async Task ProcessDocumentAsync_WebSubmitErrorWithNonResultBody_RethrowsOriginalError()
        {
            var originalError = new ApiException(500, "Error calling CreateWebDocumentProcessingRequest", "{\"detail\":\"boom\"}");
            var documents = new Mock<IDocumentApi>(MockBehavior.Strict);
            documents
                .Setup(d => d.CreateWebDocumentProcessingRequestAsync(
                    It.IsAny<WebDocumentUploadInDTO>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
                .ThrowsAsync(originalError);

            var client = ClientWith(documents: documents.Object);
            var caught = await Assert.ThrowsAsync<ApiException>(
                () => client.ProcessDocumentAsync(
                    GeminaDocumentSource.FromUrl("https://example.com/invoice.pdf"), InvoiceHeaders));

            Assert.Same(originalError, caught);
        }

        // ---- Resume polling after timeout ----

        [Fact]
        public async Task GetProcessingResultAsync_ReturnsTransportResult()
        {
            var correlationId = Guid.NewGuid();
            var inProcess = Result(ResponseStatus.InProcess, correlationId);
            var transport = new Mock<IDocumentTransport>(MockBehavior.Strict);
            transport
                .Setup(t => t.GetResultAsync(correlationId, It.IsAny<CancellationToken>()))
                .ReturnsAsync(inProcess);

            var client = ClientWith(transport.Object);
            var result = await client.GetProcessingResultAsync(correlationId);

            Assert.Same(inProcess, result);
        }

        // ---- Input validation ----

        [Fact]
        public async Task ProcessDocumentAsync_EmptyExtractionTypes_ThrowsArgumentException()
        {
            var client = ClientWith();
            using (var stream = new MemoryStream(new byte[] { 1 }))
            {
                await Assert.ThrowsAsync<ArgumentException>(
                    () => client.ProcessDocumentAsync(stream, new List<ExtractionTypeModel>()));
                await Assert.ThrowsAsync<ArgumentException>(
                    () => client.ProcessDocumentAsync(stream, null));
            }
        }

        // ---- Constructor / configuration ----

        [Fact]
        public void Constructor_SetsApiKeyHeaderBasePathAndUserAgent()
        {
            var client = new GeminaClient("my-key", "https://api.staging.gemina.co/");

            Assert.Equal("my-key", client.Configuration.ApiKey["X-API-Key"]);
            // Auth flows exclusively through the security-scheme settings; the
            // regenerated client applies them on every secured endpoint.
            Assert.Empty(client.Configuration.DefaultHeaders);
            Assert.Equal("https://api.staging.gemina.co", client.Configuration.BasePath); // trailing slash trimmed
            Assert.Equal("gemina-sdk-csharp/" + SdkVersion.Version, client.Configuration.UserAgent);
        }

        [Fact]
        public void Constructor_RejectsEmptyApiKey()
        {
            Assert.Throws<ArgumentException>(() => new GeminaClient(""));
            Assert.Throws<ArgumentException>(() => new GeminaClient("  "));
        }

        [Fact]
        public void WithSessionToken_SetsBearerTokenInsteadOfApiKey()
        {
            var client = GeminaClient.WithSessionToken("session-token", "https://api.staging.gemina.co");

            Assert.Equal("session-token", client.Configuration.AccessToken);
            Assert.False(client.Configuration.ApiKey.ContainsKey("X-API-Key"));
            Assert.Empty(client.Configuration.DefaultHeaders);
            Assert.Equal("gemina-sdk-csharp/" + SdkVersion.Version, client.Configuration.UserAgent);
        }

        [Fact]
        public void GroupAccessors_AreLazilyBuiltAndCached()
        {
            var client = new GeminaClient("my-key");

            Assert.Same(client.Documents, client.Documents);
            Assert.NotNull(client.Retrieval);
            Assert.NotNull(client.Chat);
            Assert.NotNull(client.Templates);
            Assert.NotNull(client.Files);
            Assert.NotNull(client.FileTag);
            Assert.NotNull(client.Sessions);
            Assert.NotNull(client.Subscriptions);
            Assert.NotNull(client.Billing);
        }
    }
}
