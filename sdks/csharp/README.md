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

**Values added to the API later.** An enum value this version of the SDK does not know yet (a new `modelType` or `status`, say) does not fail the result: it reads as that enum's `UnknownDefaultOpenApi` member. This holds for polling results, for webhook events, and for every API group `GeminaClient` gives you (`client.Webhooks`, `client.Documents`, ...); a webhook's `Raw` keeps the value as it was sent. A generated API class you construct yourself (`new WebhooksApi(...)`) keeps the generator's strict reading.

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

## Receiving webhooks

Gemina can POST to your server each time an extraction request finishes, so you do not have to poll for each result. Keep every request's correlation id all the same: an event is not guaranteed, and if none has arrived 15 minutes after a request was accepted, poll that request. A call that adds extractions to a document you already uploaded is a request of its own. It reports the upload's correlation id and the ids of the extractions it created (`newExtractionIds`): keep both, and count its 15 minutes from when it was accepted. An event for that correlation id covers the addition only when its result holds those extraction ids (in the event, or fetched from `resultPath` when the event left the result out). One that does not may be the upload's own event, arriving late, so keep the addition's check running. A request that asks only for FileTag does not send a webhook when it succeeds: its result comes back in the response. If such a request fails before FileTag has started on the file, a `failed` event can still arrive. Register your endpoint on the Webhooks page of the console; it gives you a signing secret that starts with `whsec_`.

`GeminaWebhooks.Unwrap` checks that a delivery was signed with your secret and is recent, then returns a typed event. It does not remember what it has seen: the same delivery verifies again within five minutes, so your own code decides what a repeat is.

The sample is an ASP.NET Core minimal API (.NET 8): `dotnet new web`, then `dotnet add package Gemina.Sdk`, paste the sample into `Program.cs`, and start it with `GEMINA_WEBHOOK_SECRET=whsec_... dotnet run --urls http://127.0.0.1:8099`; it does not start without the secret.

```csharp
using Gemina.Sdk;

var secret = Environment.GetEnvironmentVariable("GEMINA_WEBHOOK_SECRET");
if (string.IsNullOrEmpty(secret))
{
    Console.Error.WriteLine("Set GEMINA_WEBHOOK_SECRET to your endpoint's signing secret (whsec_...).");
    return 1;
}
// One inbox per endpoint. Set GEMINA_WEBHOOK_INBOX if another endpoint's receiver starts from this directory.
var inbox = Environment.GetEnvironmentVariable("GEMINA_WEBHOOK_INBOX") ?? "webhook-inbox";
if (OperatingSystem.IsWindows())
    Directory.CreateDirectory(inbox); // put it where only the service account can read: events hold extracted data
else
    Directory.CreateDirectory(inbox, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
const int MaxBodyBytes = 2 * 1024 * 1024; // Gemina's bodies stay near 1 MB

var app = WebApplication.Create(args);

app.MapPost("/gemina/webhook", async (HttpRequest request) =>
{
    var body = new MemoryStream();
    var buffer = new byte[81920];
    int read;
    while ((read = await request.Body.ReadAsync(buffer)) > 0) // the raw bytes, before any JSON parsing
    {
        if (body.Length + read > MaxBodyBytes) return Results.StatusCode(413); // anyone can post here: stop before holding more
        body.Write(buffer, 0, read);
    }
    // One entry per value: h.Value.ToString() would join a repeat with a bare comma and hide it.
    var headers = request.Headers.SelectMany(h => h.Value.Select(v => new KeyValuePair<string, string>(h.Key, v ?? "")));
    WebhookEvent webhook;
    try
    {
        webhook = GeminaWebhooks.Unwrap(body.ToArray(), headers, secret);
    }
    catch (GeminaWebhookVerificationException)
    {
        return Results.StatusCode(400);
    }
    if (webhook.Type != "extraction.completed") return Results.Ok(); // a test event, or a type added later

    // Store the event under its id BEFORE answering. Write a private directory first, then
    // publish it under the event's id with one rename. The rename fails if that id is already
    // stored (the kernel refuses to rename onto a directory that is not empty), and a
    // half-written event never carries the id. File.Move would not do: it checks for the name
    // and then renames over it.
    var final = Path.Combine(inbox, webhook.Id);
    var partial = Path.Combine(inbox, $".{webhook.Id}.{Guid.NewGuid():N}.part");
    try
    {
        Directory.CreateDirectory(partial);
        using (var file = new FileStream(Path.Combine(partial, "event.json"), FileMode.CreateNew))
        {
            file.Write(body.GetBuffer(), 0, (int)body.Length);
            file.Flush(flushToDisk: true);
        }
        Directory.Move(partial, final);
    }
    catch (IOException) when (File.Exists(Path.Combine(final, "event.json")))
    {
        // a repeat of an event you already have (a directory without event.json is not one)
    }
    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
    {
        app.Logger.LogError(e, "Gemina webhook not stored");
        return Results.StatusCode(500); // not stored. A normal delivery is retried; a test or a resend is not
    }
    finally
    {
        if (Directory.Exists(partial)) Directory.Delete(partial, recursive: true);
    }
    return Results.Ok();
});

app.Run();
return 0;
```

The step that works through the inbox reads a stored event and records `data.status`, which is the outcome whatever happens next. If `resultIncluded` is true, it uses whichever of `data.result` and `data.error` is set (it does not choose by whether there is a `documentId`: a stored failure comes in `error` even when a document exists), and in `data.result` it looks at each extraction first: one whose `meta.purgedAt` is set has no values, so it records that extraction's detail as not available, exactly as for a fetched result. If `resultIncluded` is false, it fetches `resultPath` with the API key saved for that correlation id. (An upload made in the console, or by an assistant signed in to your account with no API key, has no such key: its result is read where the request was made, and the worker records `data.status` and moves on.) It then reads the answer in this order. A 202 first: keep the event in the inbox and fetch again after `Retry-After` (its body has the shape of a result, so a worker that looks at the body first would finish the item with nothing in it). Then a body that is a result document: on a 200 it is the result, and on a 4xx or 5xx it is the detail of a `partial` or `failed` event; an extraction in it whose `meta.purgedAt` is set has no values, because its content was deleted, so record that extraction's detail as not available, also on a 200. Then a connection failure, or a 5xx with no result document in it: leave the event in the inbox and try again later, up to a limit you choose. Any other answer, a 401, 403 or 404 or another error body, is about the fetch and not about the request, so it is never stored as the request's error: keep `data.status`, mark the detail as not available, and move on. A fetch returns the document as it is now, not as it was when the event was sent: if extractions were added since, the answer holds them too, and an event of their own may follow. So a worker that already has a result in the stored event keeps that one, and a worker that had no result in the event (it was too large) cannot tell which of the fetched extractions the event was about: it processes what the answer holds and does the work for each `extractionId` once, so a later event, if one comes, repeats nothing. The image and document links inside a result expire: a worker that gets to an event late fetches the result again from `resultPath`, with the same key, only to take fresh links for the extractions it already has. For an upload made in the console or by a signed-in assistant there is no such key, as above: fresh links come from where the request was made. The step that works through the inbox reads only directories whose names do not start with a dot, each holding one `event.json`: a `.part` directory is never an event.

- **Pass the raw body, and limit its size.** Verify the bytes you received. If your framework parses JSON for you, read the raw body first; a parsed and re-encoded body will not verify. Anyone can post to a public URL, and the signature is checked only after the body is read, so stop reading at 2 MB. Gemina's bodies stay near 1 MB.
- **Store first, then answer.** Gemina waits 15 seconds for a 2xx. Save the event, answer, and do slow work afterwards. If you cannot save it, answer with a 5xx: Gemina sends an event again on its retry schedule, up to ten attempts over about three days. A test event, and an event you resent from the Webhooks page, is sent once and is not retried: send it again yourself.
- **Expect repeats.** A delivery can arrive more than once. `event.id` is the same each time, so store each id once. In production use your database or queue: one transaction that inserts the event id and the work to do. The inbox in the sample is there to make it run as printed; it is not a durable queue, and a file can be missing after a power loss.
- **The result may be left out.** When `resultIncluded` is false, the body has no `result` and no `error`. There are two reasons. A result over 1 MB can still be fetched from `resultPath`. A result whose content was already deleted cannot be fetched any more: the event's `status` is all there is. **Which credential fetches it.** `resultPath` answers only the API key that made the upload the correlation id belongs to, also when that key was used through an assistant. Extractions added to that document later keep the upload's correlation id, so the same key fetches them, wherever the addition was made, the console included. The event does not say which key that was, so if you use more than one, save which key it was next to each correlation id when you make the request: its id, or where you keep its secret, never its name, which can repeat and can change. Fetch with that key: a 404 under another key says nothing about the result. Two kinds of upload were not made with one of your API keys, so no API key can fetch them from `resultPath`. An upload made by an assistant that is signed in to your account with no API key: its result is read in that assistant (its `get_extraction_result` tool, with the event's `correlationId`), not by this code. An upload made in the console: read its result in the console. (The REST guide describes fetching with your account login.) For these two, this code records the event's `status` and stops: an error from `resultPath` says nothing about the result, so do not record it as unavailable. **The outcome is the event's `status`. Never take it from the fetch.** The fetch only adds the detail, and what it returns is the document as it is now: if more was extracted from the document after this event, the answer holds that too, and another event may come for it. Read the answer in this order. First, a 202: the document is being processed again, so keep the event and fetch again after the `Retry-After` time. Check the status code before the body, because a 202 has a result-shaped body. Second, a body that is a result document (its `meta` has a `documentId`): with a 200 it is the result, and with a 4xx or 5xx it is the detail of a `partial` or `failed` request, which is served with an error code. Look at each extraction in it before you record what you got: one whose `meta.purgedAt` is set has no values any more, because its content was deleted, and that is true with a 200 as well. Record such an extraction as not available. The same goes for a result that arrived inside the event: one extraction of a document can be deleted while the others stay, and the event then has `resultIncluded: true` with that extraction's `meta.purgedAt` set and no values. Because the answer is the document as it is now, it can hold extractions that a later event may bring again (a later event is not certain): do the work for each `extractionId` once. Third, a connection failure, or a 5xx with no result document in it: try again later, a limited number of times. Anything else (a 401, 403 or 404, or any other error body) is about the fetch, not about your request: this credential cannot fetch it, or the content is gone. Such a body also says `failed`; do not store it as the request's error. Keep the event's `status`, record that the detail is not available, and stop.
- **Managing endpoints from code** uses the `webhooks` group with your account-login token (the one the console signs in with), passed to `GeminaClient.WithSessionToken`. An API key does not work, and neither does a retrieval session token from `sessions`.

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
