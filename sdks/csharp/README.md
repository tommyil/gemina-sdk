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
    new List<UploadExtractionTypeEnum> { UploadExtractionTypeEnum.InvoiceHeaders });

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
    new List<UploadExtractionTypeEnum> { UploadExtractionTypeEnum.InvoiceHeaders });
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

Available extraction types. `filetag` is deliberately absent: FileTag has its
own endpoints (`client.FileTag`), and the upload endpoints reject it.

| Extraction type | Enum member | What it extracts |
|---|---|---|
| `ocr` | `UploadExtractionTypeEnum.Ocr` | Full-text OCR |
| `invoice_headers` | `UploadExtractionTypeEnum.InvoiceHeaders` | Vendor, buyer, dates, amounts, taxes |
| `invoice_line_items` | `UploadExtractionTypeEnum.InvoiceLineItems` | Line items with quantities and prices |
| `document_details_hebrew` | `UploadExtractionTypeEnum.DocumentDetailsHebrew` | Hebrew document headers |
| `document_line_items_hebrew` | `UploadExtractionTypeEnum.DocumentLineItemsHebrew` | Hebrew document line items |
| `custom_template` | `UploadExtractionTypeEnum.CustomTemplate` | Your own template fields (pass `TemplateId`) |

## What did an extraction cost?

Credits are charged *after* the result is delivered, so cost is a separate
lookup rather than a field on the extraction response. Ask for one extraction,
or up to 100 at a time:

```csharp
var single = await client.Documents.GetExtractionCostAsync(extractionId);
Console.WriteLine($"{single.Data.State} {single.Data.CreditsConsumed}");

var bulk = await client.Documents.GetExtractionCostsAsync(
    new List<Guid?> { extractionId, otherId });
foreach (var cost in bulk.Data.Costs)
    Console.WriteLine($"{cost.ExtractionId} {cost.State} {cost.CreditsConsumed}");
```

`State` tells you whether the number is final:

- `settled` — the charge is on record; this is the authoritative number.
- `pending` — billing has not run yet. Retry.
- `not_charged` — billing finished without a charge. This never resolves, so
  don't poll it.

Enterprise accounts are billed in contract dollars: `CreditsConsumed` is null
and `CostCents` carries the amount. The bulk call silently omits ids you don't
own, so key the response by `ExtractionId` rather than assuming input order.

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

**Advanced filters & match highlights.** Beyond the promoted `Filters`, filter on
*any* structured field a document has with `StructuredFilters` (each is a
`path` / `op` / `value`, where `op` is one of `Eq` / `Neq` / `Gt` / `Lt` /
`Contains` / `Exists`, max 8), and read back the line-item snippet that made a
document match via each result's `MatchedChunks`:

```csharp
var matches = await client.Retrieval.RetrievalQueryAsync(new RetrievalQueryInDTO(
    text: "27-inch monitors",
    mode: RetrievalQueryInDTO.ModeEnum.Hybrid,
    structuredFilters: new List<StructuredFilterDTO>
    {
        new StructuredFilterDTO(StructuredFilterDTO.OpEnum.Contains, "position", new Value("engineer")),
    }));

foreach (var item in matches.Items)
{
    foreach (var chunk in item.MatchedChunks ?? new List<MatchedChunkDTO>())
    {
        Console.WriteLine($"{item.DocumentId} matched on: {chunk.Text}");
    }
}
```

Discover which fields you can filter on with `RetrievalFieldsAsync` — it returns
the structured field names per document type (names only, never values), so you
can build a field picker from real data:

```csharp
var fields = await client.Retrieval.RetrievalFieldsAsync();

foreach (var f in fields.Fields)
{
    Console.WriteLine($"{f.DocumentType}.{f.Field} ({f.Count} documents)");
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

**Multi-turn conversations (memory).** For a back-and-forth where follow-ups
keep context, use a **conversation** — it threads the server-issued `SessionId`
for you:

```csharp
var chat = client.Conversation();
await chat.SendAsync("How much did we spend on cleaning in 2020?");
var follow = await chat.SendAsync("And which vendor was most expensive?"); // remembers 2020 / cleaning
Console.WriteLine($"{follow.Answer} · session: {chat.SessionId}");

await chat.DeleteAsync(); // end it server-side (or chat.Reset() to just forget it locally)
```

A conversation's live context expires after roughly 24h of inactivity; the next
`SendAsync` then throws the API's `404 CHAT_SESSION_NOT_FOUND` (an
`ApiException`) — call `chat.Reset()` and resend to continue in a fresh one. The
transcript itself is not lost: it stays available in chat history (below) until
your data-retention window — or an explicit purge — removes it. One-shot
`client.Chat.ChatQueryAsync(new ChatQueryInDTO(message: ..., sessionId: ...))` is
still available if you'd rather hold the id yourself; every response returns a
`SessionId`.

## Chat history

Past conversations are kept as sessions you can list, reread, and purge:

```csharp
var listing = await client.Chat.ListChatSessionsAsync(limit: 20);
foreach (var session in listing.Sessions)
    Console.WriteLine($"{session.Title} · {session.TurnCount} turns");

var transcript = await client.Chat.GetChatSessionAsync(listing.Sessions[0].Id);
foreach (var msg in transcript.Messages)
    Console.WriteLine($"[{msg.Role}] {msg.Content}");

await client.Chat.PurgeChatSessionAsync(listing.Sessions[0].Id);
```

`PurgeChatSessionAsync` permanently deletes the transcript and the server-side
copy of its content — it cannot be undone. Purged sessions vanish from the
list; pass `withPurged: true` to see their content-free stubs — title cleared,
`PurgedAt`/`PurgeReason` set; timestamps, `TurnCount`, and `EndUserId` survive. Transcripts also age out automatically under your
account's data-retention setting (each session's `PurgeAt` tells you when).
Purging requires an API key or a console sign-in — browser session tokens can
list and read history, but never purge.

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

## Human verification in the browser

`@gemina/elements` also ships `<GeminaVerification>`: a drop-in review step
that puts the document next to every extracted field, lets a person correct
what's wrong, and sends the corrections back to Gemina for accuracy scoring.

Mint the token **scoped to the extraction being reviewed** — an unscoped token
that reaches a browser can read every extraction in your account:

```csharp
var session = await client.Sessions.MintRetrievalTokenAsync(new SessionTokenInDTO(
    extractionIds: new List<Guid> { extractionId },  // up to 10; pins the token
    ttlSeconds: 900));
```

An empty list is rejected rather than quietly minting a tenant-wide token. Your
endpoint must check that the requesting end-user is allowed to see those
extractions: Gemina enforces the claim, you decide who gets it.

Upload with `evaluation: true` to give the reviewer per-field confidence scores
and the "hide everything already scored high" filter.

**Reading the result back** is one call, and it's the source of truth — the
widget's browser callback is best-effort, this isn't:

```csharp
var view = await client.Documents.GetDocumentExtractionAsync(extractionId);

view.Meta.Validated;    // has a human verified this yet?
view.Values;            // what the model extracted
view.VerifiedValues;    // same shape, corrections merged in — null until verified
view.VerifiedDiff;      // what the reviewer changed
```

`VerifiedValues` is deliberately the same shape as `Values`, so moving your
pipeline from raw to human-verified data is a one-name change. Each
`VerifiedDiff` entry is `Field`, `Pointer`, `Original`, `Verified` and a
`Status` of `corrected`, `added` or `removed`; the pointer resolves against
both payloads, so you can show before and after. All three are also on the
results-poll and list surfaces, so a batch job can sweep for `Meta.Validated`
without fetching extractions one by one.

Verification is **one-shot** per extraction — a second submission is rejected
with 409. To submit a review from your own UI instead of the widget:

```csharp
var summary = await client.Documents.ValidateDocumentExtractionAsync(
    extractionId,
    new ExtractionValidationInDTO(data: correctedValues));

// summary.Data -> per-field comparison against what was extracted
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
