// Live smoke test: calls GET /v1/retrieval/status with a real API key.
// Usage: GEMINA_BASE_URL=... GEMINA_API_KEY=... dotnet run --project smoke
using System;
using Gemina.Sdk;

var baseUrl = Environment.GetEnvironmentVariable("GEMINA_BASE_URL") ?? GeminaClient.DefaultBaseUrl;
var apiKey = Environment.GetEnvironmentVariable("GEMINA_API_KEY");

if (string.IsNullOrWhiteSpace(apiKey))
{
    Console.Error.WriteLine("GEMINA_API_KEY environment variable is not set.");
    return 1;
}

try
{
    var client = new GeminaClient(apiKey, baseUrl);
    var status = await client.Retrieval.RetrievalStatusAsync();
    Console.WriteLine($"retrieval status OK — indexedDocuments={status.IndexedDocuments} servedAt={status.ServedAt:O}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Smoke test FAILED: {ex.GetType().Name}: {ex.Message}");
    return 1;
}
