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
    <version>0.17.0</version>
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
import co.gemina.sdk.generated.model.UploadExtractionTypeEnum;

public class Quickstart {
    public static void main(String[] args) throws Exception {
        GeminaClient client = new GeminaClient(System.getenv("GEMINA_API_KEY"));

        DocumentProcessingResultOutDTO result = client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.pdf")),
                Collections.singletonList(UploadExtractionTypeEnum.INVOICE_HEADERS));

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
        Collections.singletonList(UploadExtractionTypeEnum.INVOICE_HEADERS));
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

**Values added to the API later.** An enum value this version of the SDK does not know yet (a new `modelType` or `status`, say) does not fail the response: it reads as that enum's `UNKNOWN_DEFAULT_OPEN_API` constant. This holds for polling results and for webhook events alike; a webhook's `getRaw()` keeps the value as it was sent.

## What did an extraction cost?

Credits are charged *after* the result is delivered, so cost is a separate
lookup rather than a field on the extraction response. Ask for one extraction,
or up to 100 at a time:

```java
ExtractionCostOutResultDTO single = client.documents().getExtractionCost(extractionId);
System.out.println(single.getData().getState() + " " + single.getData().getCreditsConsumed());

ExtractionCostsOutDTO bulk =
        client.documents().getExtractionCosts(Arrays.asList(extractionId, otherId));
bulk.getData().getCosts().forEach(cost ->
        System.out.println(cost.getExtractionId() + " " + cost.getState()));
```

`state` tells you whether the number is final:

- `settled` — the charge is on record; this is the authoritative number.
- `pending` — billing has not run yet. Retry.
- `not_charged` — billing finished without a charge. This never resolves, so
  don't poll it.

Enterprise accounts are billed in contract dollars: `creditsConsumed` is null
and `costCents` carries the amount. The bulk call silently omits ids you don't
own, so key the response by `extractionId` rather than assuming input order.

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

A conversation's live context expires after roughly 24h of inactivity; the next
`send` then throws the API's `404 CHAT_SESSION_NOT_FOUND` (an `ApiException`) —
call `chat.reset()` and resend to continue in a fresh one. The transcript itself
is not lost: it stays available in chat history (below) until your
data-retention window — or an explicit purge — removes it. The one-shot
`client.chat().chatQuery(new ChatQueryInDTO().message(...).sessionId(...))` is
still there if you'd rather hold the id yourself; every response returns a
`getSessionId()`.

## Chat history

Past conversations are kept as sessions you can list, reread, and purge:

```java
ChatSessionListOutDTO listing = client.chat().listChatSessions(null, 20, null, null, null);
for (ChatSessionOutDTO session : listing.getSessions()) {
    System.out.println(session.getTitle() + " · " + session.getTurnCount() + " turns");
}

UUID sessionId = listing.getSessions().get(0).getId();
ChatTranscriptOutDTO transcript = client.chat().getChatSession(sessionId, null, null, null);
for (ChatMessageOutDTO msg : transcript.getMessages()) {
    System.out.println("[" + msg.getRole() + "] " + msg.getContent());
}

client.chat().purgeChatSession(sessionId);
```

`purgeChatSession` permanently deletes the transcript and the server-side copy
of its content — it cannot be undone. Purged sessions vanish from the list;
pass `withPurged = true` to see their content-free stubs — title cleared,
`getPurgedAt()`/`getPurgeReason()` set; timestamps, `getTurnCount()`, and `getEndUserId()` survive. Transcripts also age out automatically under your
account's data-retention setting (each session's `getPurgeAt()` tells you
when). Purging requires an API key or a console sign-in — browser session
tokens can list and read history, but never purge.

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

## Human verification in the browser

`@gemina/elements` also ships `<GeminaVerification>`: a drop-in review step
that puts the document next to every extracted field, lets a person correct
what's wrong, and sends the corrections back to Gemina for accuracy scoring.

Mint the token **scoped to the extraction being reviewed** — an unscoped token
that reaches a browser can read every extraction in your account:

```java
SessionTokenOutDTO session = client.sessions().mintRetrievalToken(
        new SessionTokenInDTO()
                .extractionIds(Arrays.asList(extractionId))  // up to 10; pins the token
                .ttlSeconds(900));
```

An empty list is rejected rather than quietly minting a tenant-wide token. Your
endpoint must check that the requesting end-user is allowed to see those
extractions: Gemina enforces the claim, you decide who gets it.

Upload with `evaluation(true)` to give the reviewer per-field confidence scores
and the "hide everything already scored high" filter.

**Reading the result back** is one call, and it's the source of truth — the
widget's browser callback is best-effort, this isn't:

```java
ExtractionPrimaryViewOutDTO view = client.documents()
        .getDocumentExtraction(extractionId);

view.getMeta().getValidated();   // has a human verified this yet?
view.getValues();                // what the model extracted
view.getVerifiedValues();        // same shape, corrections merged in — null until verified
view.getVerifiedDiff();          // what the reviewer changed
```

`verifiedValues` is deliberately the same shape as `values`, so moving your
pipeline from raw to human-verified data is a one-name change. Each
`verifiedDiff` entry is `field`, `pointer`, `original`, `verified` and a
`status` of `corrected`, `added` or `removed`; the pointer resolves against
both payloads, so you can show before and after. All three fields also appear
on the results-poll and list surfaces, so a batch job can sweep for
`meta.validated` without fetching extractions one by one.

Verification is **one-shot** per extraction — a second submission is rejected
with 409. To submit a review from your own UI instead of the widget:

```java
ExtractionValidationResultOutDTO summary = client.documents()
        .validateDocumentExtraction(
                extractionId,
                new ExtractionValidationInDTO().data(correctedValues));

summary.getData();  // per-field comparison against what was extracted
```

## Receiving webhooks

Gemina can POST to your server each time an extraction request finishes, so you do not have to poll for each result. Keep every request's correlation id all the same: an event is not guaranteed, and if none has arrived 15 minutes after a request was accepted, poll that request. A call that adds extractions to a document you already uploaded is a request of its own. It reports the upload's correlation id and the ids of the extractions it created (`newExtractionIds`): keep both, and count its 15 minutes from when it was accepted. An event for that correlation id covers the addition only when its result holds those extraction ids (in the event, or fetched from `resultPath` when the event left the result out). One that does not may be the upload's own event, arriving late, so keep the addition's check running. A request that asks only for FileTag does not send a webhook when it succeeds: its result comes back in the response. If such a request fails before FileTag has started on the file, a `failed` event can still arrive. Register your endpoint on the Webhooks page of the console; it gives you a signing secret that starts with `whsec_`.

`GeminaWebhooks.unwrap` checks that a delivery was signed with your secret and is recent, then returns a typed event. It does not remember what it has seen: the same delivery verifies again within five minutes, so your own code decides what a repeat is.

The sample is a controller for a Spring Boot 3 project with `spring-boot-starter-web` and this package. Add the class to the project (change its `package` line to your application's package) and start it with `GEMINA_WEBHOOK_SECRET=whsec_... mvn spring-boot:run`; it does not start without the secret.

```java
package com.example.webhooks;

import co.gemina.sdk.GeminaWebhookVerificationException;
import co.gemina.sdk.GeminaWebhooks;
import co.gemina.sdk.WebhookEvent;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GeminaWebhookController {
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024; // Gemina's bodies stay near 1 MB

    private final String secret = System.getenv("GEMINA_WEBHOOK_SECRET");
    // One inbox per endpoint. Set GEMINA_WEBHOOK_INBOX if another endpoint's receiver starts from this directory.
    private final Path inbox = Paths.get(System.getenv().getOrDefault("GEMINA_WEBHOOK_INBOX", "webhook-inbox"));

    public GeminaWebhookController() throws IOException {
        if (secret == null || secret.isEmpty()) {
            throw new IllegalStateException("Set GEMINA_WEBHOOK_SECRET to your endpoint's signing secret (whsec_...).");
        }
        if (inbox.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            // Private: events hold extracted data.
            Files.createDirectories(inbox, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } else {
            Files.createDirectories(inbox); // Windows: place it where only the service account can read
        }
    }

    @PostMapping("/gemina/webhook")
    public ResponseEntity<Void> receive(HttpServletRequest request, @RequestHeader HttpHeaders headers) throws IOException {
        byte[] body;
        try (InputStream in = request.getInputStream()) {
            body = in.readNBytes(MAX_BODY_BYTES + 1); // the raw bytes, at most one past the limit
        }
        if (body.length > MAX_BODY_BYTES) {
            return ResponseEntity.status(413).build(); // anyone can post here: stop reading
        }
        // Every value of a repeated header, joined with ", ": a Map<String, String> holds one value per name.
        Map<String, String> flat = new LinkedHashMap<>();
        headers.forEach((name, values) -> flat.put(name, String.join(", ", values)));
        WebhookEvent event;
        try {
            event = GeminaWebhooks.unwrap(body, flat, secret);
        } catch (GeminaWebhookVerificationException e) {
            return ResponseEntity.badRequest().build();
        }
        if (!"extraction.completed".equals(event.getType())) {
            return ResponseEntity.ok().build(); // a test event, or a type added later
        }

        // Store the event under its id BEFORE answering. Write a private file first,
        // then publish it under the event's id. The link fails if that id is already
        // stored, and a half-written file never carries the id. Any other failure is
        // thrown: Spring logs it and answers 500, and Gemina sends the event again
        // (a test event or a resend is not sent again).
        Path published = inbox.resolve(event.getId() + ".json");
        Path partial = inbox.resolve("." + event.getId() + "." + UUID.randomUUID() + ".part");
        try {
            Files.write(partial, body, StandardOpenOption.CREATE_NEW, StandardOpenOption.SYNC);
            Files.createLink(published, partial);
        } catch (FileAlreadyExistsException e) {
            if (!Files.isRegularFile(published)) {
                throw e; // the name is taken by something that is not the event
            }
            // otherwise a repeat of an event you already have
        } finally {
            Files.deleteIfExists(partial); // whatever happened, the temporary file goes
        }
        return ResponseEntity.ok().build();
    }
}
```

The step that works through the inbox reads a stored event and records `data.status`, which is the outcome whatever happens next. If `resultIncluded` is true, it uses whichever of `data.result` and `data.error` is set (it does not choose by whether there is a `documentId`: a stored failure comes in `error` even when a document exists), and in `data.result` it looks at each extraction first: one whose `meta.purgedAt` is set has no values, so it records that extraction's detail as not available, exactly as for a fetched result. If `resultIncluded` is false, it fetches `resultPath` with the API key saved for that correlation id. (An upload made in the console, or by an assistant signed in to your account with no API key, has no such key: its result is read where the request was made, and the worker records `data.status` and moves on.) It then reads the answer in this order. A 202 first: keep the event in the inbox and fetch again after `Retry-After` (its body has the shape of a result, so a worker that looks at the body first would finish the item with nothing in it). Then a body that is a result document: on a 200 it is the result, and on a 4xx or 5xx it is the detail of a `partial` or `failed` event; an extraction in it whose `meta.purgedAt` is set has no values, because its content was deleted, so record that extraction's detail as not available, also on a 200. Then a connection failure, or a 5xx with no result document in it: leave the event in the inbox and try again later, up to a limit you choose. Any other answer, a 401, 403 or 404 or another error body, is about the fetch and not about the request, so it is never stored as the request's error: keep `data.status`, mark the detail as not available, and move on. A fetch returns the document as it is now, not as it was when the event was sent: if extractions were added since, the answer holds them too, and an event of their own may follow. So a worker that already has a result in the stored event keeps that one, and a worker that had no result in the event (it was too large) cannot tell which of the fetched extractions the event was about: it processes what the answer holds and does the work for each `extractionId` once, so a later event, if one comes, repeats nothing. The image and document links inside a result expire: a worker that gets to an event late fetches the result again from `resultPath`, with the same key, only to take fresh links for the extractions it already has. For an upload made in the console or by a signed-in assistant there is no such key, as above: fresh links come from where the request was made. The step that works through the inbox reads only names that end in `.json`: a `.part` file is never an event.

- **Pass the raw body, and limit its size.** Verify the bytes you received. If your framework parses JSON for you, read the raw body first; a parsed and re-encoded body will not verify. Anyone can post to a public URL, and the signature is checked only after the body is read, so stop reading at 2 MB. Gemina's bodies stay near 1 MB.
- **Store first, then answer.** Gemina waits 15 seconds for a 2xx. Save the event, answer, and do slow work afterwards. If you cannot save it, answer with a 5xx: Gemina sends an event again on its retry schedule, up to ten attempts over about three days. A test event, and an event you resent from the Webhooks page, is sent once and is not retried: send it again yourself.
- **Expect repeats.** A delivery can arrive more than once. `event.id` is the same each time, so store each id once. In production use your database or queue: one transaction that inserts the event id and the work to do. The inbox in the sample is there to make it run as printed; it is not a durable queue, and a file can be missing after a power loss.
- **The result may be left out.** When `resultIncluded` is false, the body has no `result` and no `error`. There are two reasons. A result over 1 MB can still be fetched from `resultPath`. A result whose content was already deleted cannot be fetched any more: the event's `status` is all there is. **Which credential fetches it.** `resultPath` answers only the API key that made the upload the correlation id belongs to, also when that key was used through an assistant. Extractions added to that document later keep the upload's correlation id, so the same key fetches them, wherever the addition was made, the console included. The event does not say which key that was, so if you use more than one, save which key it was next to each correlation id when you make the request: its id, or where you keep its secret, never its name, which can repeat and can change. Fetch with that key: a 404 under another key says nothing about the result. Two kinds of upload were not made with one of your API keys, so no API key can fetch them from `resultPath`. An upload made by an assistant that is signed in to your account with no API key: its result is read in that assistant (its `get_extraction_result` tool, with the event's `correlationId`), not by this code. An upload made in the console: read its result in the console. (The REST guide describes fetching with your account login.) For these two, this code records the event's `status` and stops: an error from `resultPath` says nothing about the result, so do not record it as unavailable. **The outcome is the event's `status`. Never take it from the fetch.** The fetch only adds the detail, and what it returns is the document as it is now: if more was extracted from the document after this event, the answer holds that too, and another event may come for it. Read the answer in this order. First, a 202: the document is being processed again, so keep the event and fetch again after the `Retry-After` time. Check the status code before the body, because a 202 has a result-shaped body. Second, a body that is a result document (its `meta` has a `documentId`): with a 200 it is the result, and with a 4xx or 5xx it is the detail of a `partial` or `failed` request, which is served with an error code. Look at each extraction in it before you record what you got: one whose `meta.purgedAt` is set has no values any more, because its content was deleted, and that is true with a 200 as well. Record such an extraction as not available. The same goes for a result that arrived inside the event: one extraction of a document can be deleted while the others stay, and the event then has `resultIncluded: true` with that extraction's `meta.purgedAt` set and no values. Because the answer is the document as it is now, it can hold extractions that a later event may bring again (a later event is not certain): do the work for each `extractionId` once. Third, a connection failure, or a 5xx with no result document in it: try again later, a limited number of times. Anything else (a 401, 403 or 404, or any other error body) is about the fetch, not about your request: this credential cannot fetch it, or the content is gone. Such a body also says `failed`; do not store it as the request's error. Keep the event's `status`, record that the detail is not available, and stop.
- **Managing endpoints from code** uses the `webhooks` group with your account-login token (the one the console signs in with), passed to `GeminaClient.withSessionToken`. An API key does not work, and neither does a retrieval session token from `sessions`.

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
