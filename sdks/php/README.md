# Gemina PHP SDK

Official PHP client for the Gemina API — invoice OCR and document intelligence: upload documents, get typed structured data back, then search, aggregate, and chat over everything you've processed.

## Install

```bash
composer require gemina/sdk
```

Requires PHP 8.1+ with the `curl`, `json`, and `mbstring` extensions.

## Authenticate

Get your API key from the [Gemina Console](https://console.gemina.co). The client sends it as the `X-API-Key` header on every request:

```php
use Gemina\Sdk\GeminaClient;

$client = new GeminaClient('YOUR_API_KEY');
```

Never ship the API key in browser or mobile code. For browser embedding, mint short-lived session tokens server-side (`POST /v1/sessions/token`) — see [Session tokens](#session-tokens-browser-embedding) below and the Document Intelligence guide at [console.gemina.co/docs](https://console.gemina.co/docs).

## Quickstart — process an invoice in one call

`processDocument()` submits the file through the async API, polls with exponential backoff until processing finishes, and returns the final typed result:

```php
<?php

require 'vendor/autoload.php';

use Gemina\Sdk\GeminaClient;

$client = new GeminaClient(getenv('GEMINA_API_KEY'));

$result = $client->processDocument('invoice.png', ['invoice_headers']);

echo 'Status: ', $result->getStatus(), PHP_EOL;

$extraction = $result->getData()->getExtractions()[0];
$values = $extraction->getValues();

// Each field is an object with ->value (plus ->coordinates and ->confidence when available)
echo 'Supplier: ', $values['vendorName']->value ?? 'n/a', PHP_EOL;
echo 'Total:    ', $values['totalAmount']->value ?? 'n/a', PHP_EOL;
echo 'Date:     ', $values['invoiceDate']->value ?? 'n/a', PHP_EOL;
```

Documents reachable by URL work the same way — wrap the URL in `UrlSource`:

```php
use Gemina\Sdk\UrlSource;

$result = $client->processDocument(
    new UrlSource('https://example.com/invoices/2026-06.pdf'),
    ['invoice_headers'],
);
```

## What you get back

`processDocument()` returns a `DocumentProcessingResultOutDTO`:

- `getStatus()` — `success` | `partial` | `empty` (`failed` throws `GeminaProcessingException` instead; `partial` and `empty` still carry usable data and meta).
- `getData()->getExtractions()` — one entry per requested extraction type. Each has `getMeta()->getExtractionType()` and `getValues()`, a map of field name to an object with `value`, `coordinates`, and `confidence`.
- `getMeta()->getDocumentId()` / `getMeta()->getCorrelationId()` — the stored document's ID and the async request's correlation ID.

Extraction types:

| Type | What it extracts |
|---|---|
| `ocr` | Raw text (OCR only) |
| `invoice_headers` | Vendor, buyer, invoice number, dates, amounts, payment method |
| `invoice_line_items` | Line items table |
| `document_details_hebrew` | Hebrew document header details |
| `document_line_items_hebrew` | Hebrew document line items |
| `custom_template` | Fields defined by your own template (pass `templateId` in options) |

`filetag` is deliberately absent: the upload endpoints reject it, and FileTag
has its own endpoints.

## What did an extraction cost?

Credits are charged *after* the result is delivered, so cost is a separate
lookup rather than a field on the extraction response. Ask for one extraction,
or up to 100 at a time:

```php
$single = $client->documents()->getExtractionCost($extractionId);
echo $single->getData()->getState(), ' ', $single->getData()->getCreditsConsumed(), PHP_EOL;

$bulk = $client->documents()->getExtractionCosts([$extractionId, $otherId]);
foreach ($bulk->getData()->getCosts() as $cost) {
    echo $cost->getExtractionId(), ' ', $cost->getState(), PHP_EOL;
}
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

Everything you process is indexed for retrieval. Query it in natural language plus structured filters:

```php
use Gemina\Sdk\Model\RetrievalQueryInDTO;

$out = $client->retrieval()->retrievalQuery(new RetrievalQueryInDTO([
    'text' => 'cloud hosting invoices from June',
    'top_k' => 10,
]));

foreach ($out->getItems() as $item) {
    printf(
        "%s | %s | %s %s\n",
        $item->getDocumentId(),
        $item->getVendorName(),
        $item->getTotalAmount(),
        $item->getCurrency(),
    );
}
```

Results carry citations back to your documents: each item includes `getDocumentId()` and `getDocumentExtractionId()`.

Aggregate across documents (sum/avg/min/max/count over amounts, grouped by any dimension):

```php
use Gemina\Sdk\Model\AggregateMetricDTO;
use Gemina\Sdk\Model\RetrievalAggregateInDTO;

$agg = $client->retrieval()->retrievalAggregate(new RetrievalAggregateInDTO([
    'metrics' => [new AggregateMetricDTO(['op' => 'sum', 'field' => 'total_amount'])],
    'group_by' => ['vendor_name'],
]));

foreach ($agg->getRows() as $row) {
    print_r($row->getGroup());
    print_r($row->getValues());
}
```

Check how many of your documents are indexed with `$client->retrieval()->retrievalStatus()->getIndexedDocuments()`.

**Advanced filters & match highlights.** Beyond the promoted `filters`, filter on *any* structured field a document has with `structuredFilters` (`op` is one of `eq` / `neq` / `gt` / `lt` / `contains` / `exists`, max 8), and read back the line-item snippet that made a document match via `getMatchedChunks()`:

```php
use Gemina\Sdk\Model\RetrievalQueryInDTO;
use Gemina\Sdk\Model\StructuredFilterDTO;

$out = $client->retrieval()->retrievalQuery(new RetrievalQueryInDTO([
    'mode' => 'hybrid',
    'text' => '27-inch monitors',
    'structured_filters' => [
        new StructuredFilterDTO(['path' => 'position', 'op' => 'contains', 'value' => 'engineer']),
    ],
]));

foreach ($out->getItems() as $item) {
    foreach ($item->getMatchedChunks() ?? [] as $chunk) {
        printf("%s matched on: %s\n", $item->getDocumentId(), $chunk->getText());
    }
}
```

Discover which fields you can filter on with `$client->retrieval()->retrievalFields()` — it returns the structured field names per document type (names only, never values), so you can build a field picker from real data:

```php
foreach ($client->retrieval()->retrievalFields()->getFields() as $field) {
    // e.g. documentType "invoice", field "vendor_name", count 42
    printf("%s.%s (%d)\n", $field->getDocumentType(), $field->getField(), $field->getCount());
}
```

## Chat with your documents

Ask questions in natural language; answers come back with citations:

```php
use Gemina\Sdk\Model\ChatQueryInDTO;

$chat = $client->chat()->chatQuery(new ChatQueryInDTO([
    'message' => 'How much did I spend on hosting in June, and with which vendor?',
]));

echo $chat->getAnswer(), PHP_EOL;
echo 'Confident: ', $chat->getConfident() ? 'yes' : 'no', PHP_EOL;
print_r($chat->getCitations());
```

Chat requires a plan with Document Intelligence enabled — see [pricing](https://gemina.co). Without it, the API returns `402`/`403`.

**Multi-turn conversations (memory).** For a back-and-forth where follow-ups keep context, use a **conversation** — it threads the server-issued `sessionId` for you:

```php
$chat = $client->conversation();
$chat->send('How much did I spend on hosting in June, and with which vendor?');
$follow = $chat->send('And which month was cheapest?'); // remembers hosting / June
printf("%s · session: %s\n", $follow->getAnswer(), $chat->getSessionId());

$chat->delete(); // end it server-side (or $chat->reset() to just forget it locally)
```

A conversation's live context expires after roughly 24h of inactivity; the next `send()` then throws the API's `404 CHAT_SESSION_NOT_FOUND` (an `ApiException`) — call `$chat->reset()` and resend to continue in a fresh one. The transcript itself is not lost: it stays available in chat history (below) until your data-retention window — or an explicit purge — removes it. One-shot `chatQuery()` with a `session_id` is still available if you'd rather hold the id yourself; every response returns `getSessionId()`.

## Chat history

Past conversations are kept as sessions you can list, reread, and purge:

```php
$listing = $client->chat()->listChatSessions(0, 20);
foreach ($listing->getSessions() as $session) {
    printf("%s · %d turns\n", $session->getTitle(), $session->getTurnCount());
}

$sessionId = $listing->getSessions()[0]->getId();
$transcript = $client->chat()->getChatSession($sessionId);
foreach ($transcript->getMessages() as $msg) {
    printf("[%s] %s\n", $msg->getRole(), $msg->getContent());
}

$client->chat()->purgeChatSession($sessionId);
```

`purgeChatSession()` permanently deletes the transcript and the server-side copy of its content — it cannot be undone. Purged sessions vanish from the list; pass `$with_purged = true` to see their content-free stubs — title cleared, `getPurgedAt()`/`getPurgeReason()` set; timestamps, `getTurnCount()`, and `getEndUserId()` survive. Transcripts also age out automatically under your account's data-retention setting (each session's `getPurgeAt()` tells you when). Purging requires an API key or a console sign-in — browser session tokens can list and read history, but never purge.

## Session tokens (browser embedding)

To let a browser query retrieval or chat directly, mint a short-lived session token server-side and hand that to your frontend — never the API key:

```php
use Gemina\Sdk\Model\SessionTokenInDTO;

$token = $client->sessions()->mintRetrievalToken(new SessionTokenInDTO([
    'end_user_id' => 'user-42',
    'ttl_seconds' => 900,
]));

echo $token->getToken(); // pass to the frontend
```

A client can also authenticate with a session token directly (bearer auth) — useful for server-side code acting within a session scope:

```php
$sessionClient = GeminaClient::withSessionToken($sessionToken);
```

For a drop-in chat UI, see the `@gemina/elements` package on npm.

## Human verification in the browser

`@gemina/elements` also ships `<GeminaVerification>`: a drop-in review step that puts the document next to every extracted field, lets a person correct what's wrong, and sends the corrections back to Gemina for accuracy scoring.

Mint the token **scoped to the extraction being reviewed** — an unscoped token that reaches a browser can read every extraction in your account:

```php
$token = $client->sessions()->mintRetrievalToken(new SessionTokenInDTO([
    'extraction_ids' => [$extractionId],  // up to 10; pins the token to these
    'ttl_seconds' => 900,
]));
```

An empty list is rejected rather than quietly minting a tenant-wide token. Your endpoint must check that the requesting end-user is allowed to see those extractions: Gemina enforces the claim, you decide who gets it.

Upload with `evaluation` enabled to give the reviewer per-field confidence scores and the "hide everything already scored high" filter.

**Reading the result back** is one call, and it's the source of truth — the widget's browser callback is best-effort, this isn't:

```php
$view = $client->documents()->getDocumentExtraction($extractionId);

$view->getMeta()->getValidated();  // has a human verified this yet?
$view->getValues();                // what the model extracted
$view->getVerifiedValues();        // same shape, corrections merged in — null until verified
$view->getVerifiedDiff();          // what the reviewer changed
```

`verifiedValues` is deliberately the same shape as `values`, so moving your pipeline from raw to human-verified data is a one-name change. Each `verifiedDiff` entry is `field`, `pointer`, `original`, `verified` and a `status` of `corrected`, `added` or `removed`; the pointer resolves against both payloads, so you can show before and after. All three fields also appear on the results-poll and list surfaces, so a batch job can sweep for `meta.validated` without fetching extractions one by one.

Verification is **one-shot** per extraction — a second submission is rejected with 409. To submit a review from your own UI instead of the widget:

```php
use Gemina\Sdk\Model\ExtractionValidationInDTO;

$summary = $client->documents()->validateDocumentExtraction($extractionId, new ExtractionValidationInDTO([
    'data' => $correctedValues,
]));

$summary->getData(); // per-field comparison against what was extracted
```

## Receiving webhooks

Gemina can POST to your server each time an extraction request finishes, so you do not have to poll for each result. Keep every request's correlation id all the same: an event is not guaranteed, and if none has arrived 15 minutes after a request was accepted, poll that request. A call that adds extractions to a document you already uploaded is a request of its own. It reports the upload's correlation id and the ids of the extractions it created (`newExtractionIds`): keep both, and count its 15 minutes from when it was accepted. An event for that correlation id covers the addition only when its result holds those extraction ids (in the event, or fetched from `resultPath` when the event left the result out). One that does not may be the upload's own event, arriving late, so keep the addition's check running. A request that asks only for FileTag does not send a webhook when it succeeds: its result comes back in the response. If such a request fails before FileTag has started on the file, a `failed` event can still arrive. Register your endpoint on the Webhooks page of the console; it gives you a signing secret that starts with `whsec_`.

`GeminaWebhooks::unwrap` checks that a delivery was signed with your secret and is recent, then returns a typed event. It does not remember what it has seen: the same delivery verifies again within five minutes, so your own code decides what a repeat is.

The sample is a plain PHP script. Run `composer require gemina/sdk` in the directory that holds it. Set `GEMINA_WEBHOOK_INBOX` to an absolute directory outside the document root, used by this endpoint only: the sample has no default and stores nothing without it (it logs one line and answers 500). To try it with PHP 8.3 or later, start it with `GEMINA_WEBHOOK_SECRET=whsec_... GEMINA_WEBHOOK_INBOX=<an absolute directory outside the document root, used by this endpoint only> php -S 127.0.0.1:8099 webhook.php`. (PHP 8.1's built-in server keeps only the first value of a repeated header, which hides the repeat from the helper.)

```php
<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Gemina\Sdk\GeminaWebhooks;
use Gemina\Sdk\GeminaWebhookVerificationException;

const MAX_BODY_BYTES = 2 * 1024 * 1024; // Gemina's bodies stay near 1 MB

// Never print a PHP warning into the response: once anything is printed, PHP sends a 200
// and a later failure can no longer answer 500. Warnings still go to the error log, and
// every file call below checks its own result, whatever the warning settings are.
ini_set('display_errors', '0');

/** Ends the request with a status code, logging why when there is a reason. */
function answer(int $status, ?string $logLine = null): never
{
    if ($logLine !== null) {
        error_log($logLine);
    }
    http_response_code($status);
    exit;
}

/** What failed, with the reason PHP gave, for the error log. */
function failure(string $what): string
{
    return $what . ': ' . (error_get_last()['message'] ?? 'no reason given');
}

/**
 * Store the event under its id. Write a private file first, then publish it
 * under the event's id. The link fails if that id is already stored, and a
 * half-written file never carries the id. Throws when the event is not stored.
 */
function store(string $inbox, string $id, string $body): void
{
    if (!is_dir($inbox) && !mkdir($inbox, 0700, true) && !is_dir($inbox)) { // private: events hold extracted data
        throw new RuntimeException(failure("cannot create {$inbox}"));
    }
    $final = "{$inbox}/{$id}.json";
    $partial = "{$inbox}/.{$id}." . bin2hex(random_bytes(16)) . '.part';
    error_clear_last();
    $file = fopen($partial, 'xb');
    if ($file === false) {
        throw new RuntimeException(failure("cannot create {$partial}"));
    }
    try {
        $written = fwrite($file, $body) === strlen($body) && fflush($file) && fsync($file);
        if (!fclose($file) || !$written) {
            throw new RuntimeException(failure("cannot write {$partial}"));
        }
        error_clear_last();
        // @: a link that fails because the event is already stored is a repeat, not a warning.
        if (!@link($partial, $final) && !is_file($final)) {
            throw new RuntimeException(failure("cannot store {$final}"));
        }
    } finally {
        if (file_exists($partial) && !unlink($partial)) { // whatever happened, the temporary file goes
            error_log(failure("cannot remove {$partial}"));
        }
    }
}

$secret = getenv('GEMINA_WEBHOOK_SECRET');
if ($secret === false || $secret === '') {
    answer(500, "Set GEMINA_WEBHOOK_SECRET to your endpoint's signing secret (whsec_...).");
}
// No default: an absolute directory outside the document root, used by this endpoint only.
$inbox = getenv('GEMINA_WEBHOOK_INBOX');
if ($inbox === false || preg_match('~\A(/|[A-Za-z]:[\\\\/])~', $inbox) !== 1) {
    answer(500, 'Set GEMINA_WEBHOOK_INBOX to an absolute directory outside the document root, used by this endpoint only.');
}

$body = stream_get_contents(fopen('php://input', 'rb'), MAX_BODY_BYTES + 1); // the raw bytes, at most one past the limit
if ($body === false) {
    answer(500, 'Cannot read the request body.');
}
if (strlen($body) > MAX_BODY_BYTES) {
    answer(413); // anyone can post here: stop reading
}

try {
    $event = GeminaWebhooks::unwrap($body, getallheaders(), $secret);
} catch (GeminaWebhookVerificationException) {
    answer(400);
}
if ($event->type !== 'extraction.completed') {
    answer(200); // a test event, or a type added later
}

try {
    store($inbox, $event->id, $body);
} catch (RuntimeException $e) {
    answer(500, 'Gemina webhook not stored: ' . $e->getMessage()); // a normal delivery is sent again; a test or a resend is not
}
answer(200);
```

The step that works through the inbox reads a stored event and records `data.status`, which is the outcome whatever happens next. If `resultIncluded` is true, it uses whichever of `data.result` and `data.error` is set (it does not choose by whether there is a `documentId`: a stored failure comes in `error` even when a document exists), and in `data.result` it looks at each extraction first: one whose `meta.purgedAt` is set has no values, so it records that extraction's detail as not available, exactly as for a fetched result. If `resultIncluded` is false, it fetches `resultPath` with the API key saved for that correlation id. (An upload made in the console, or by an assistant signed in to your account with no API key, has no such key: its result is read where the request was made, and the worker records `data.status` and moves on.) It then reads the answer in this order. A 202 first: keep the event in the inbox and fetch again after `Retry-After` (its body has the shape of a result, so a worker that looks at the body first would finish the item with nothing in it). Then a body that is a result document: on a 200 it is the result, and on a 4xx or 5xx it is the detail of a `partial` or `failed` event; an extraction in it whose `meta.purgedAt` is set has no values, because its content was deleted, so record that extraction's detail as not available, also on a 200. Then a connection failure, or a 5xx with no result document in it: leave the event in the inbox and try again later, up to a limit you choose. Any other answer, a 401, 403 or 404 or another error body, is about the fetch and not about the request, so it is never stored as the request's error: keep `data.status`, mark the detail as not available, and move on. A fetch returns the document as it is now, not as it was when the event was sent: if extractions were added since, the answer holds them too, and an event of their own may follow. So a worker that already has a result in the stored event keeps that one, and a worker that had no result in the event (it was too large) cannot tell which of the fetched extractions the event was about: it processes what the answer holds and does the work for each `extractionId` once, so a later event, if one comes, repeats nothing. The image and document links inside a result expire: a worker that gets to an event late fetches the result again from `resultPath`, with the same key, only to take fresh links for the extractions it already has. For an upload made in the console or by a signed-in assistant there is no such key, as above: fresh links come from where the request was made. The step that works through the inbox reads only names that end in `.json`: a `.part` file is never an event.

- **Pass the raw body, and limit its size.** Verify the bytes you received. If your framework parses JSON for you, read the raw body first; a parsed and re-encoded body will not verify. Anyone can post to a public URL, and the signature is checked only after the body is read, so stop reading at 2 MB. Gemina's bodies stay near 1 MB.
- **Store first, then answer.** Gemina waits 15 seconds for a 2xx. Save the event, answer, and do slow work afterwards. If you cannot save it, answer with a 5xx: Gemina sends an event again on its retry schedule, up to ten attempts over about three days. A test event, and an event you resent from the Webhooks page, is sent once and is not retried: send it again yourself.
- **Expect repeats.** A delivery can arrive more than once. `event.id` is the same each time, so store each id once. In production use your database or queue: one transaction that inserts the event id and the work to do. The inbox in the sample is there to make it run as printed; it is not a durable queue, and a file can be missing after a power loss.
- **The result may be left out.** When `resultIncluded` is false, the body has no `result` and no `error`. There are two reasons. A result over 1 MB can still be fetched from `resultPath`. A result whose content was already deleted cannot be fetched any more: the event's `status` is all there is. **Which credential fetches it.** `resultPath` answers only the API key that made the upload the correlation id belongs to, also when that key was used through an assistant. Extractions added to that document later keep the upload's correlation id, so the same key fetches them, wherever the addition was made, the console included. The event does not say which key that was, so if you use more than one, save which key it was next to each correlation id when you make the request: its id, or where you keep its secret, never its name, which can repeat and can change. Fetch with that key: a 404 under another key says nothing about the result. Two kinds of upload were not made with one of your API keys, so no API key can fetch them from `resultPath`. An upload made by an assistant that is signed in to your account with no API key: its result is read in that assistant (its `get_extraction_result` tool, with the event's `correlationId`), not by this code. An upload made in the console: read its result in the console. (The REST guide describes fetching with your account login.) For these two, this code records the event's `status` and stops: an error from `resultPath` says nothing about the result, so do not record it as unavailable. **The outcome is the event's `status`. Never take it from the fetch.** The fetch only adds the detail, and what it returns is the document as it is now: if more was extracted from the document after this event, the answer holds that too, and another event may come for it. Read the answer in this order. First, a 202: the document is being processed again, so keep the event and fetch again after the `Retry-After` time. Check the status code before the body, because a 202 has a result-shaped body. Second, a body that is a result document (its `meta` has a `documentId`): with a 200 it is the result, and with a 4xx or 5xx it is the detail of a `partial` or `failed` request, which is served with an error code. Look at each extraction in it before you record what you got: one whose `meta.purgedAt` is set has no values any more, because its content was deleted, and that is true with a 200 as well. Record such an extraction as not available. The same goes for a result that arrived inside the event: one extraction of a document can be deleted while the others stay, and the event then has `resultIncluded: true` with that extraction's `meta.purgedAt` set and no values. Because the answer is the document as it is now, it can hold extractions that a later event may bring again (a later event is not certain): do the work for each `extractionId` once. Third, a connection failure, or a 5xx with no result document in it: try again later, a limited number of times. Anything else (a 401, 403 or 404, or any other error body) is about the fetch, not about your request: this credential cannot fetch it, or the content is gone. Such a body also says `failed`; do not store it as the request's error. Keep the event's `status`, record that the detail is not available, and stop.
- **Managing endpoints from code** uses the `webhooks` group with your account-login token (the one the console signs in with), passed to `GeminaClient::withSessionToken`. An API key does not work, and neither does a retrieval session token from `sessions`.

## Going deeper

### Full API surface

The generated client covers the entire API. Reach any group through the accessors — `documents()`, `retrieval()`, `chat()`, `templates()`, `files()`, `fileTag()`, `sessions()`, `subscriptions()`, `billing()`:

```php
$page = $client->documents()->findDocuments(0, 20);
foreach ($page->getData()->getDocuments() as $doc) {
    echo $doc->getMeta()->getDocumentId(), PHP_EOL;
}
```

### Polling knobs

`processDocument()` accepts polling options (defaults: 300 s deadline, 2 s initial interval growing ×1.5 up to 15 s, with jitter):

```php
$result = $client->processDocument('invoice.png', ['invoice_headers'], [
    'timeoutSeconds' => 600,
    'initialIntervalSeconds' => 1.0,
    'maxIntervalSeconds' => 10.0,
]);
```

Other options mirror the endpoint's form fields: `externalId` (defaults to a generated unique ID), `templateId`, `modelType`, `thinking`, `evaluation`, `correction`, `includeCoordinates`, `endUserId`.

If the deadline is exceeded, `GeminaTimeoutException` carries the correlation ID so you can resume polling yourself:

```php
use Gemina\Sdk\GeminaTimeoutException;

try {
    $result = $client->processDocument('invoice.png', ['invoice_headers'], ['timeoutSeconds' => 30]);
} catch (GeminaTimeoutException $e) {
    // Later — or from another process:
    $result = $client->documents()
        ->getDocumentProcessingResultByCorrelationId($e->getCorrelationId());
}
```

### Error handling

```php
use Gemina\Sdk\ApiException;
use Gemina\Sdk\GeminaProcessingException;
use Gemina\Sdk\GeminaTimeoutException;

try {
    $result = $client->processDocument('invoice.png', ['invoice_headers']);
} catch (GeminaProcessingException $e) {
    // Terminal "failed" — the full result is attached
    print_r($e->getResult()->getErrors());
} catch (GeminaTimeoutException $e) {
    echo 'Still processing: ', $e->getCorrelationId(), PHP_EOL;
} catch (ApiException $e) {
    // Transport/HTTP errors from the generated client pass through unwrapped
    echo $e->getCode(), ': ', $e->getResponseBody(), PHP_EOL;
}
```

### Custom base URL

Point the client at a different deployment (staging, self-hosted):

```php
$client = new GeminaClient('YOUR_API_KEY', 'https://api.staging.gemina.co');
```

## Requirements & support

- PHP 8.1 or newer (`curl`, `json`, `mbstring` extensions)
- Docs: [console.gemina.co/docs](https://console.gemina.co/docs)
- Issues: [github.com/tommyil/gemina-sdk/issues](https://github.com/tommyil/gemina-sdk/issues)
- Email: support@gemina.co
