# Gemina Java SDK

The official Java client for the [Gemina API](https://gemina.co) — invoice OCR
and document intelligence: upload documents, get typed structured data back,
then search, aggregate, and chat over everything you've processed.

## Install

Requires Java 8 or later.

```xml
<dependency>
    <groupId>co.gemina</groupId>
    <artifactId>gemina-sdk</artifactId>
    <version>0.1.0</version>
</dependency>
```

## Authenticate

Get an API key from the [Gemina Console](https://console.gemina.co). The
client sends it as the `X-API-Key` header on every request:

```java
GeminaClient client = new GeminaClient(System.getenv("GEMINA_API_KEY"));
```

Never ship the API key in browser or mobile code. For browser embedding, mint
short-lived session tokens server-side (`POST /v1/sessions/token`) — see
[Session tokens](#session-tokens-browser-embedding) below and the Document
Intelligence guide at https://console.gemina.co/docs.

## Quickstart — process an invoice in one call

`processDocument` submits the document to the async endpoint, polls with
exponential backoff until processing finishes, and returns the final typed
result — one call, no manual polling.

```java
import java.io.File;
import java.util.Collections;
import java.util.Map;

import co.gemina.sdk.GeminaClient;
import co.gemina.sdk.GeminaDocumentSource;
import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;
import co.gemina.sdk.generated.model.ExtractionTypeModel;

public class Quickstart {
    public static void main(String[] args) throws Exception {
        GeminaClient client = new GeminaClient(System.getenv("GEMINA_API_KEY"));

        DocumentProcessingResultOutDTO result = client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.pdf")),
                Collections.singletonList(ExtractionTypeModel.INVOICE_HEADERS));

        System.out.println("status: " + result.getStatus());

        // Each value field is a map: {"value": ..., "confidence": ..., "coordinates": ...}
        Map<String, Object> values = result.getData().getExtractions().get(0).getValues();
        System.out.println("vendor: " + field(values, "vendorName"));
        System.out.println("total:  " + field(values, "totalAmount"));
        System.out.println("date:   " + field(values, "invoiceDate"));
    }

    @SuppressWarnings("unchecked")
    static Object field(Map<String, Object> values, String name) {
        Map<String, Object> f = (Map<String, Object>) values.get(name);
        return f == null ? null : f.get("value");
    }
}
```

Processing a document at a URL works the same way — Gemina fetches it for you:

```java
DocumentProcessingResultOutDTO result = client.processDocument(
        GeminaDocumentSource.fromUrl("https://example.com/invoice.pdf"),
        Collections.singletonList(ExtractionTypeModel.INVOICE_HEADERS));
```

There is also a non-blocking variant, `processDocumentAsync(...)`, which
returns a `CompletableFuture<DocumentProcessingResultOutDTO>` (it wraps the
same submit-and-poll flow on `ForkJoinPool.commonPool()`).

## What you get back

`processDocument` returns a `DocumentProcessingResultOutDTO`:

- `getStatus()` — `SUCCESS`, `PARTIAL` (some extractions failed), or `EMPTY`
  (nothing extractable). A terminal `failed` throws instead (see
  [Error handling](#going-deeper)).
- `getData().getExtractions()` — one `ExtractionProcessingResultOutDTO` per
  requested extraction type: `getMeta().getExtractionType()` identifies it,
  `getValues()` holds the extracted fields, each shaped
  `{"value": ..., "confidence": ..., "coordinates": ...}`.
- `getMeta()` — `getDocumentId()`, `getCorrelationId()`, filename, page count,
  storage region, and more.

Available extraction types:

| Type | What it extracts |
|------|------------------|
| `OCR` (`ocr`) | Raw text |
| `INVOICE_HEADERS` (`invoice_headers`) | Vendor/buyer, dates, amounts, taxes, currency |
| `INVOICE_LINE_ITEMS` (`invoice_line_items`) | Line items with quantities and prices |
| `DOCUMENT_DETAILS_HEBREW` (`document_details_hebrew`) | Hebrew document headers |
| `DOCUMENT_LINE_ITEMS_HEBREW` (`document_line_items_hebrew`) | Hebrew line items |
| `CUSTOM_TEMPLATE` (`custom_template`) | Fields defined by your own template (pass `templateId`) |
| `FILETAG` (`filetag`) | File classification and tagging |

## Search & aggregate your documents

Everything you process is queryable through the `retrieval()` group. Query
with natural language plus structured filters:

```java
import co.gemina.sdk.generated.model.*;

RetrievalQueryOutDTO hits = client.retrieval().retrievalQuery(
        new RetrievalQueryInDTO()
                .text("cloud hosting invoices over 500 euro")
                .filters(new RetrievalFiltersDTO().currency("EUR"))
                .limit(10));

for (QueryResultItemDTO item : hits.getItems()) {
    System.out.println(item.getVendorName() + "  " + item.getTotalAmount()
            + "  " + item.getIssueDate() + "  (document " + item.getDocumentId() + ")");
}
```

Every result item carries citations back to the source document
(`getDocumentId()`, `getDocumentExtractionId()`).

Aggregate across documents — sums, averages, counts, grouped how you like:

```java
RetrievalAggregateOutDTO totals = client.retrieval().retrievalAggregate(
        new RetrievalAggregateInDTO()
                .metrics(Collections.singletonList(new AggregateMetricDTO()
                        .op(AggregateMetricDTO.OpEnum.SUM)
                        .field(AggregateMetricDTO.FieldEnum.TOTAL_AMOUNT)))
                .groupBy(Collections.singletonList(RetrievalAggregateInDTO.GroupByEnum.VENDOR_NAME)));

for (AggregateRowDTO row : totals.getRows()) {
    System.out.println(row.getGroup() + " -> " + row.getValues());
}
```

**Advanced filters & match highlights.** Beyond the promoted `filters`, filter
on *any* structured field a document has with `structuredFilters` (each `op` is
one of `EQ` / `NEQ` / `GT` / `LT` / `CONTAINS` / `EXISTS`, max 8), and read back
the line-item snippet that made a document match via `getMatchedChunks()`:

```java
RetrievalQueryOutDTO hits = client.retrieval().retrievalQuery(
        new RetrievalQueryInDTO()
                .mode(RetrievalQueryInDTO.ModeEnum.HYBRID)
                .text("27-inch monitors")
                .addStructuredFiltersItem(new StructuredFilterDTO()
                        .path("position")
                        .op(StructuredFilterDTO.OpEnum.CONTAINS)
                        .value(new Value("engineer"))));

for (QueryResultItemDTO item : hits.getItems()) {
    for (MatchedChunkDTO chunk : item.getMatchedChunks()) {
        System.out.println(item.getDocumentId() + " matched on: " + chunk.getText());
    }
}
```

Discover which fields you can filter on with `client.retrieval().retrievalFields()`
— it returns the structured field names per document type (names only, never
values), so you can build a field picker from real data:

```java
RetrievalFieldsOutDTO fields = client.retrieval().retrievalFields();
for (RetrievalFieldItemDTO f : fields.getFields()) {
    // e.g. documentType="invoice", field="vendor_name", count=42
    System.out.println(f.getDocumentType() + "." + f.getField() + "  (" + f.getCount() + ")");
}
```

## Chat with your documents

Ask questions in natural language; answers cite the documents they came from:

```java
ChatQueryOutDTO reply = client.chat().chatQuery(
        new ChatQueryInDTO().message("How much did we spend on hosting last quarter?"));

System.out.println(reply.getAnswer());
System.out.println("confident: " + reply.getConfident());
System.out.println("citations: " + reply.getCitations());
```

Chat requires a plan with Document Intelligence enabled — see
[pricing](https://gemina.co/pricing); requests return `402`/`403` otherwise.

**Multi-turn conversations (memory).** For a back-and-forth where follow-ups
keep context, use a **conversation** — it threads the server-issued `sessionId`
for you, so you never touch the id:

```java
GeminaClient.GeminaChatConversation chat = client.conversation();
chat.send("How much did we spend on cleaning in 2020?");
ChatQueryOutDTO follow = chat.send("And which vendor was most expensive?"); // remembers 2020 / cleaning
System.out.println(follow.getAnswer() + " · session: " + chat.getSessionId());

chat.delete(); // end it server-side (or chat.reset() to just forget it locally)
```

A conversation expires after 24h of inactivity; the next `send` then throws the
API's `404 CHAT_SESSION_NOT_FOUND` (an `ApiException`) — call `chat.reset()` and
resend to continue in a fresh one. The one-shot
`client.chat().chatQuery(new ChatQueryInDTO().message(...).sessionId(...))` is
still there if you'd rather hold the id yourself; every response returns a
`getSessionId()`.

## Session tokens (browser embedding)

To embed search or chat in your frontend, mint a short-lived session token
server-side and hand that to the browser — never the API key:

```java
SessionTokenOutDTO session = client.sessions().mintRetrievalToken(
        new SessionTokenInDTO()
                .endUserId("user-123")
                .ttlSeconds(900));

// Send session.getToken() to your frontend.
System.out.println(session.getToken() + " expires in " + session.getExpiresIn() + "s");
```

For a drop-in chat UI, see the `@gemina/elements` package on npm. Server-side
code can also authenticate with a session token directly:

```java
GeminaClient sessionClient = GeminaClient.withSessionToken(token);
```

## Going deeper

**Full API surface.** The group accessors expose the complete generated
client, zero wrapping: `client.documents()`, `client.retrieval()`,
`client.chat()`, `client.templates()`, `client.files()`, `client.fileTag()`,
`client.sessions()`, `client.subscriptions()`, `client.billing()`. For
example, list your processed documents:

```java
DocumentsViewOutDTO docs = client.documents().findDocuments(
        0, 20, null, null, null, null, null, null); // skip, limit, filters...
```

**Polling knobs.** `processDocument` accepts options — including
`timeoutSeconds` (default 300), `initialIntervalSeconds` (default 2.0, grows
x1.5 per poll), and `maxIntervalSeconds` (default 15.0). Transient poll
errors (a load-balancer blip, a 5xx that isn't a processing result) are
retried automatically on the same backoff schedule and overall deadline —
your submitted document is never orphaned; only after 3 consecutive poll
failures is the underlying error rethrown. Submit errors are not retried.

```java
ProcessDocumentOptions options = ProcessDocumentOptions.builder()
        .externalId("invoice-2026-001")   // your own identifier (auto-generated if unset)
        .timeoutSeconds(120)
        .build();

DocumentProcessingResultOutDTO result = client.processDocument(source, types, options);
```

**Error handling.** A terminal `failed` throws `GeminaProcessingException`
(the full result with its `errors` list is attached). Exceeding the deadline
throws `GeminaTimeoutException`, which carries the `correlationId` so you can
resume polling yourself. Transport/HTTP errors from the generated client pass
through unwrapped as `ApiException`.

```java
try {
    DocumentProcessingResultOutDTO result = client.processDocument(source, types, options);
} catch (GeminaProcessingException e) {
    System.err.println("processing failed: " + e.getResult().getErrors());
} catch (GeminaTimeoutException e) {
    UUID correlationId = e.getCorrelationId(); // resume polling with this
    DocumentProcessingResultOutDTO last = client.documents()
            .getDocumentProcessingResultByCorrelationId(correlationId);
} catch (ApiException e) {
    System.err.println("HTTP " + e.getCode() + ": " + e.getResponseBody());
}
```

**Custom base URL** (staging / self-hosted):

```java
GeminaClient client = new GeminaClient(apiKey, "https://api.staging.gemina.co");
```

## Requirements & support

- Java 8+
- Docs: https://console.gemina.co/docs
- Issues: https://github.com/tommyil/gemina-sdk/issues
- Email: support@gemina.co
