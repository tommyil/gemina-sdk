# Gemina C# SDK

Official C# client for the Gemina API — invoice OCR and document intelligence:
upload documents, get typed structured data back, then search, aggregate, and
chat over everything you've processed.

## Install

```bash
dotnet add package Gemina.Sdk
```

Targets .NET Standard 2.0 — works on .NET 5+ (including .NET 8), .NET Core
2.0+, and .NET Framework 4.6.2+.

## Authenticate

Get an API key from the [Gemina Console](https://console.gemina.co). The
client sends it as the `X-API-Key` header on every request — you never touch
the header yourself:

```csharp
using Gemina.Sdk;

var client = new GeminaClient("YOUR_API_KEY");
```

Never ship the API key in browser or mobile code. For browser embedding, mint
short-lived session tokens server-side (`POST /v1/sessions/token`) and hand
those to the frontend — see
[Session tokens](#session-tokens-browser-embedding) below and the Document
Intelligence guide in the [docs](https://console.gemina.co/docs).

## Quickstart — process an invoice in one call

`ProcessDocumentAsync` submits the document to the async endpoint, polls with
exponential backoff until processing finishes, and returns the final typed
result — one call, no plumbing:

```csharp
using Gemina.Sdk;
using Gemina.Sdk.Model;
using Newtonsoft.Json.Linq;

var client = new GeminaClient("YOUR_API_KEY");

var result = await client.ProcessDocumentAsync(
    GeminaDocumentSource.FromFile("invoice.png"),
    new List<ExtractionTypeModel> { ExtractionTypeModel.InvoiceHeaders });

var headers = result.Data.Extractions[0];
Console.WriteLine($"Status:   {result.Status}");
Console.WriteLine($"Supplier: {(headers.Values["vendorName"] as JObject)?["value"]}");
Console.WriteLine($"Total:    {(headers.Values["totalAmount"] as JObject)?["value"]}");
Console.WriteLine($"Date:     {(headers.Values["invoiceDate"] as JObject)?["value"]}");
```

Documents that live at a URL are submitted the same way — Gemina fetches them
server-side:

```csharp
var result = await client.ProcessDocumentAsync(
    GeminaDocumentSource.FromUrl("https://example.com/invoice.pdf"),
    new List<ExtractionTypeModel> { ExtractionTypeModel.InvoiceHeaders });
```

Streams work too: `client.ProcessDocumentAsync(stream, extractionTypes)` or
`GeminaDocumentSource.FromStream(stream)`.

## What you get back

`ProcessDocumentAsync` returns a `DocumentProcessingResultOutDTO`:

- `Status` — `Success`, `Partial` (some extractions failed), or `Empty`
  (nothing found). A terminal `failed` status is thrown as
  `GeminaProcessingException` instead (see
  [Error handling](#going-deeper)).
- `Data.Extractions` — one entry per requested extraction type. Each has
  `Meta.ExtractionType`, its own `Status`, and `Values` — a dictionary of
  extracted fields where each field carries `value`, `coordinates`, and
  `confidence` (e.g. `vendorName`, `invoiceNumber`, `totalAmount`,
  `currency`, `taxes`).
- `Meta.DocumentId` — the stored document's id; `Meta.CorrelationId` — the
  processing request's id (useful for resuming polls).

Available extraction types:

| Extraction type | Enum member | What it extracts |
|---|---|---|
| `ocr` | `ExtractionTypeModel.Ocr` | Full-text OCR |
| `invoice_headers` | `ExtractionTypeModel.InvoiceHeaders` | Vendor, buyer, dates, amounts, taxes |
| `invoice_line_items` | `ExtractionTypeModel.InvoiceLineItems` | Line items with quantities and prices |
| `document_details_hebrew` | `ExtractionTypeModel.DocumentDetailsHebrew` | Hebrew document headers |
| `document_line_items_hebrew` | `ExtractionTypeModel.DocumentLineItemsHebrew` | Hebrew document line items |
| `custom_template` | `ExtractionTypeModel.CustomTemplate` | Your own template fields (pass `TemplateId`) |
| `filetag` | `ExtractionTypeModel.Filetag` | Document classification tags |

## Search & aggregate your documents

Everything you process is indexed for retrieval. Query with natural language
plus structured filters:

```csharp
using Gemina.Sdk.Model;

var query = await client.Retrieval.RetrievalQueryAsync(new RetrievalQueryInDTO(
    text: "cleaning services invoices",
    topK: 5));

foreach (var item in query.Items)
{
    Console.WriteLine($"{item.VendorName} — {item.TotalAmount} {item.Currency} " +
                      $"(issued {item.IssueDate:d}, document {item.DocumentId})");
}
```

Each result carries a citation back to the source document
(`DocumentId` / `DocumentExtractionId`), plus a relevance `Score`.

Aggregate across your documents — sums, averages, counts, grouped by vendor,
month, currency, and more:

```csharp
var aggregate = await client.Retrieval.RetrievalAggregateAsync(new RetrievalAggregateInDTO(
    metrics: new List<AggregateMetricDTO>
    {
        new AggregateMetricDTO(AggregateMetricDTO.FieldEnum.TotalAmount, AggregateMetricDTO.OpEnum.Sum),
    },
    groupBy: new List<RetrievalAggregateInDTO.GroupByEnum>
    {
        RetrievalAggregateInDTO.GroupByEnum.VendorName,
    }));

foreach (var row in aggregate.Rows)
{
    Console.WriteLine($"{row.Group["vendor_name"]}: {row.Values["sum_total_amount"].ActualInstance}");
}
```

## Chat with your documents

Ask questions in natural language; answers come back with citations to the
documents they were derived from:

```csharp
var chat = await client.Chat.ChatQueryAsync(new ChatQueryInDTO(
    message: "How much did I spend on cleaning services this year?"));

Console.WriteLine(chat.Answer);
Console.WriteLine($"Confident: {chat.Confident}");
Console.WriteLine($"Citations: {string.Join(", ", chat.Citations ?? new List<string>())}");
```

Chat requires a plan with Document Intelligence enabled — see pricing at
[gemina.co](https://gemina.co). Without it the API responds with `402`/`403`
(surfaced as an `ApiException`).

## Session tokens (browser embedding)

To let a browser talk to Gemina (for example with the `@gemina/elements`
drop-in chat UI from npm), mint a short-lived session token **server-side**
and hand that to the frontend — never the API key:

```csharp
var session = await client.Sessions.MintRetrievalTokenAsync(new SessionTokenInDTO(
    endUserId: "user-123",
    ttlSeconds: 900));

// Send session.Token to your frontend; it expires in session.ExpiresIn seconds.
```

The SDK can also act with a session token directly (bearer auth instead of
the API key):

```csharp
var sessionClient = GeminaClient.WithSessionToken(session.Token);
```

## Going deeper

**Full API surface.** The generated client for every endpoint group is
exposed through the facade — `client.Documents`, `client.Retrieval`,
`client.Chat`, `client.Templates`, `client.Files`, `client.FileTag`,
`client.Sessions`, `client.Subscriptions`, `client.Billing`:

```csharp
var templates = await client.Templates.ListTemplatesByApiKeyAsync(limit: 10);
foreach (var template in templates.Templates)
{
    Console.WriteLine($"{template.Name} ({template.Id}) active={template.IsActive}");
}
```

**Polling knobs.** The submit-and-poll flow is tunable per call:

```csharp
var options = new ProcessDocumentOptions
{
    TimeoutSeconds = 600,          // overall deadline (default 300)
    InitialIntervalSeconds = 2.0,  // first wait; grows ×1.5 per attempt (default 2.0)
    MaxIntervalSeconds = 15.0,     // interval cap (default 15.0)
    ExternalId = "invoice-2026-042",
};
var result = await client.ProcessDocumentAsync(source, extractionTypes, options);
```

**Error handling.** A terminal `failed` result throws
`GeminaProcessingException` (its `Result.Errors` has the details); exceeding
the deadline throws `GeminaTimeoutException`, which carries the
`CorrelationId` so you can keep polling yourself; HTTP errors from the API
surface as `ApiException`:

```csharp
using Gemina.Sdk.Client;

try
{
    var result = await client.ProcessDocumentAsync(source, extractionTypes);
}
catch (GeminaProcessingException ex)
{
    Console.WriteLine($"Processing failed: {ex.Result.Errors?.Count} error(s)");
}
catch (GeminaTimeoutException ex)
{
    // Resume polling on your own schedule:
    var result = await client.GetProcessingResultAsync(ex.CorrelationId);
}
catch (ApiException ex)
{
    Console.WriteLine($"HTTP {ex.ErrorCode}: {ex.Message}");
}
```

**Custom base URL.** Point the client at a staging or self-hosted
deployment:

```csharp
var client = new GeminaClient("YOUR_API_KEY", "https://api.staging.gemina.co");
```

## Requirements & support

- .NET Standard 2.0 or later (.NET 5+/.NET 8, .NET Core 2.0+, .NET Framework 4.6.2+)
- Documentation: [console.gemina.co/docs](https://console.gemina.co/docs)
- Issues: [github.com/tommyil/gemina-sdk/issues](https://github.com/tommyil/gemina-sdk/issues)
- Email: support@gemina.co
