using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using Gemina.Sdk.Client;
using Gemina.Sdk.Model;
using Xunit;

namespace Gemina.Sdk.Tests
{
    /// <summary>
    /// The generated groups the facade builds read an enum value the API adds later as
    /// UnknownDefaultOpenApi, as polling and webhooks do (contract section 6).
    /// </summary>
    public class UnknownEnumValuesTests
    {
        private static async Task<T> Serve<T>(string body, Func<GeminaClient, Task<T>> call)
        {
            var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var prefix = $"http://127.0.0.1:{port}/";
            using (var http = new HttpListener())
            {
                http.Prefixes.Add(prefix);
                http.Start();
                var server = Task.Run(async () =>
                {
                    var context = await http.GetContextAsync().ConfigureAwait(false);
                    context.Response.StatusCode = 200;
                    context.Response.ContentType = "application/json";
                    var payload = Encoding.UTF8.GetBytes(body);
                    await context.Response.OutputStream.WriteAsync(payload, 0, payload.Length).ConfigureAwait(false);
                    context.Response.Close();
                });
                var client = GeminaClient.WithSessionToken("account-login-jwt", prefix.TrimEnd('/'));
                var result = await call(client).ConfigureAwait(false);
                await server.ConfigureAwait(false);
                return result;
            }
        }

        [Fact]
        public async Task AWebhookEventListWithValuesAddedLaterParsesThroughTheWebhooksGroup()
        {
            const string body = "{\"count\":1,\"events\":[{\"id\":\"8a1d0c55-2f8e-4c1b-9d6e-5b2f1a3c4d5e\"," +
                "\"endpointId\":\"5f2b7c1e-2b6b-4f0e-9a1c-3d4e5f6a7b8c\",\"webhookId\":\"evt_0123456789abcdef0123456789abcdef\"," +
                "\"type\":\"invoice.archived\",\"status\":\"retrying\",\"failureReason\":\"rate_limited\"," +
                "\"attemptCount\":2,\"manual\":false,\"occurredAt\":\"2026-11-18T10:15:30.000000\"}]}";

            var list = await Serve(body, client => client.Webhooks.ListWebhookEventsAsync());

            var webhookEvent = Assert.Single(list.Events);
            Assert.Equal(WebhookEventOutDTO.TypeEnum.UnknownDefaultOpenApi, webhookEvent.Type);
            Assert.Equal(WebhookEventOutDTO.StatusEnum.UnknownDefaultOpenApi, webhookEvent.Status);
            Assert.Equal(WebhookEventOutDTO.FailureReasonEnum.UnknownDefaultOpenApi, webhookEvent.FailureReason);
            Assert.Equal(2, webhookEvent.AttemptCount);
        }

        [Fact]
        public async Task AnEndpointWithADisabledReasonAddedLaterParsesThroughTheWebhooksGroup()
        {
            const string body = "{\"count\":1,\"endpoints\":[{\"id\":\"5f2b7c1e-2b6b-4f0e-9a1c-3d4e5f6a7b8c\"," +
                "\"url\":\"https://example.com/gemina/webhook\",\"enabled\":false,\"disabledReason\":\"suspended\"," +
                "\"notBefore\":\"2026-11-18T10:15:30.000000\"}]}";

            var list = await Serve(body, client => client.Webhooks.ListWebhookEndpointsAsync());

            Assert.Equal(WebhookEndpointOutDTO.DisabledReasonEnum.UnknownDefaultOpenApi, Assert.Single(list.Endpoints).DisabledReason);
        }

        [Fact]
        public async Task AResultWithValuesAddedLaterParsesThroughTheDocumentsGroup()
        {
            // purgeReason is not null here: the generated group still drops a whole result for a null
            // there (the known C# nullable-enum defect, contained in DocumentTransport).
            const string body = "{\"status\":\"queued\",\"meta\":{\"correlationId\":\"3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10\"}," +
                "\"data\":{\"extractions\":[{\"status\":\"success\",\"meta\":{\"extractionType\":\"invoice_headers\"," +
                "\"modelType\":\"nova\",\"thinking\":false,\"correction\":false,\"evaluation\":false,\"includeCoordinates\":false,\"processorClass\":\"InvoiceHeaderAnalysisProcessor\"," +
                "\"purgeAt\":null,\"purgedAt\":null,\"purgeReason\":\"compacted\"},\"values\":{},\"errors\":[]}]},\"errors\":[]}";

            var result = await Serve(body, client =>
                client.Documents.GetDocumentProcessingResultByCorrelationIdAsync(Guid.Parse("3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10")));

            Assert.Equal(ResponseStatus.UnknownDefaultOpenApi, result.Status);
            Assert.Equal(ModelType.UnknownDefaultOpenApi, result.Data.Extractions[0].Meta.ModelType);
            Assert.Equal(PurgeReasonModel.UnknownDefaultOpenApi, result.Data.Extractions[0].Meta.PurgeReason);
        }
    }
}
