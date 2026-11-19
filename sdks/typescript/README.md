# Gemina TypeScript SDK

The official TypeScript/JavaScript client for the [Gemina API](https://gemina.co) — invoice OCR and document intelligence. Upload invoices and financial documents, get typed structured data back, then search, aggregate, and chat over everything you've processed. Works in Node.js (18+) and the browser, with zero runtime dependencies (native `fetch`).

## Install

```bash
npm i @gemina/sdk
```

Requires Node.js >= 18 (or any modern browser). Ships ESM and CommonJS builds with full type declarations.

## Authenticate

Get an API key from the [Gemina Console](https://console.gemina.co). The client sends it as the `X-API-Key` header on every request:

```ts
import { GeminaClient } from "@gemina/sdk";

const client = new GeminaClient(process.env.GEMINA_API_KEY!);
```

Never ship the API key in browser or mobile code. For browser embedding, mint short-lived session tokens server-side (`POST /v1/sessions/token`) and use `GeminaClient.withSessionToken(...)` — see [Session tokens](#session-tokens-browser-embedding) below and the Document Intelligence guide in the [docs](https://console.gemina.co/docs).

## Quickstart — process an invoice in one call

`processDocument` submits the document through the async endpoint, polls with exponential backoff until processing completes, and returns the final typed result — one call, no manual polling:

```ts
import { readFile } from "node:fs/promises";
import { GeminaClient } from "@gemina/sdk";

const client = new GeminaClient(process.env.GEMINA_API_KEY!);

// Node: wrap a Buffer in a Blob. In the browser, pass a File from an
// <input type="file"> directly.
const buf = await readFile("./invoice.png");
const result = await client.processDocument(
  new Blob([buf], { type: "image/png" }),
  ["invoice_headers"],
);

const values = result.data?.extractions?.[0]?.values;
console.log("supplier:", values?.vendorName?.value);
console.log("total:", values?.totalAmount?.value);
console.log("date:", values?.invoiceDate?.value);
```

Processing a document by URL works the same way — pass `{ url }` instead of a file:

```ts
const result = await client.processDocument(
  { url: "https://example.com/invoice.pdf" },
  ["invoice_headers"],
);
```

## What you get back

`processDocument` resolves to a `DocumentProcessingResultOutDTO`:

- `status` — `"success" | "partial" | "empty" | "failed"`. `partial` and `empty` still resolve (they carry usable data/meta); `failed` throws a `GeminaProcessingError` instead.
- `data.extractions` — one entry per requested extraction type. Each entry has `meta.extractionType`, its own `status`, and `values` — the extracted payload. For `invoice_headers`, `values` fields (e.g. `vendorName`, `invoiceNumber`, `invoiceDate`, `totalAmount`, `currency`) are each `{ value, coordinates, confidence }` or `null` when not found.
- `meta.documentId` — the stored document's ID (use it with `client.documents`).
- `meta.correlationId` — the async processing correlation ID.

Extraction types (`UploadExtractionTypeEnum`) — note `filetag` is not one of
them: FileTag has its own endpoints (`client.fileTag`), and the upload endpoints
reject it.

| Type | What it extracts |
|------|------------------|
| `ocr` | Raw OCR text |
| `invoice_headers` | Invoice header fields (vendor, buyer, dates, amounts, taxes) |
| `invoice_line_items` | Invoice line items |
| `document_details_hebrew` | Hebrew document details |
| `document_line_items_hebrew` | Hebrew document line items |
| `custom_template` | Fields defined by your custom template (pass `templateId`) |

## Search & aggregate your documents

Everything you process is indexed for retrieval. Use the `retrieval` group to query with natural language plus structured filters — results carry `documentId` / `documentExtractionId` citations back to the underlying documents:

```ts
const { items, meta } = await client.retrieval.retrievalQuery({
  retrievalQueryInDTO: {
    text: "cleaning services invoices from August",
    filters: { totalAmountMin: 1000, currency: "ILS" },
    limit: 10,
  },
});

for (const item of items ?? []) {
  console.log(item.vendorName, item.totalAmount, item.issueDate, item.documentId);
}
console.log(`${meta.count} matches (mode: ${meta.mode})`);
```

Aggregate across your documents with metrics and group-by:

```ts
const { rows } = await client.retrieval.retrievalAggregate({
  retrievalAggregateInDTO: {
    metrics: [{ op: "sum", field: "total_amount" }, { op: "count" }],
    groupBy: ["vendor_name"],
  },
});

for (const row of rows ?? []) {
  console.log(row.group, row.values);
}
```

Check how many of your documents are indexed with `client.retrieval.retrievalStatus()` (returns `{ indexedDocuments }`).

**Advanced filters & match highlights.** Beyond the promoted `filters`, filter on *any* structured field a document has with `structuredFilters` (`op` is one of `eq` / `neq` / `gt` / `lt` / `contains` / `exists`, max 8), and read back the line-item snippet that made a document match via `matchedChunks`:

```ts
const { items } = await client.retrieval.retrievalQuery({
  retrievalQueryInDTO: {
    mode: "hybrid",
    text: "27-inch monitors",
    structuredFilters: [{ path: "position", op: "contains", value: "engineer" }],
  },
});
for (const item of items ?? []) {
  for (const chunk of item.matchedChunks ?? []) {
    console.log(item.documentId, "matched on:", chunk.text);
  }
}
```

Discover which fields you can filter on with `client.retrieval.retrievalFields()` — it returns the structured field names per document type (names only, never values), so you can build a field picker from real data:

```ts
const { fields } = await client.retrieval.retrievalFields();
// -> [{ documentType: "invoice", field: "vendor_name", count: 42 }, ...]
```

## What did an extraction cost?

Credits are charged *after* the result is delivered, so cost is a separate
lookup rather than a field on the extraction response. Ask for one extraction,
or up to 100 at a time:

```ts
const { data } = await client.documents.getExtractionCost({
  documentExtractionId: extractionId,
});
console.log(data.state, data.creditsConsumed);   // "settled"  "2.5"

const bulk = await client.documents.getExtractionCosts({
  ids: [extractionId, otherExtractionId],
});
for (const cost of bulk.data.costs) {
  console.log(cost.extractionId, cost.state, cost.creditsConsumed);
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

## Chat with your documents

Ask free-form questions over everything you've processed. Answers come back with a confidence signal and citations to the source documents:

```ts
const reply = await client.chat.chatQuery({
  chatQueryInDTO: { message: "How much did we spend on cleaning in 2020?" },
});

console.log(reply.answer);
console.log("confident:", reply.confident);
console.log("citations:", reply.citations);
```

Chat requires a plan with Document Intelligence enabled — see [pricing](https://gemina.co/pricing). Without it the API responds `402`/`403`.

**Multi-turn conversations (memory).** For a back-and-forth where follow-ups keep context, use a **conversation** — it threads the server-issued `sessionId` for you:

```ts
const chat = client.conversation();
await chat.send("How much did we spend on cleaning in 2020?");
const follow = await chat.send("And which vendor was most expensive?"); // remembers 2020 / cleaning
console.log(follow.answer, "· session:", chat.sessionId);

await chat.delete(); // end it server-side (or chat.reset() to just forget it locally)
```

A conversation's live context expires after roughly 24h of inactivity; the next `send` then throws the API's `404 CHAT_SESSION_NOT_FOUND` — call `chat.reset()` and resend to continue in a fresh one. The transcript itself is not lost: it stays available in chat history (below) until your data-retention window — or an explicit purge — removes it. One-shot `client.chat.chatQuery({ chatQueryInDTO: { message, sessionId } })` is still available if you'd rather hold the id yourself; every response returns a `sessionId`.

## Chat history

Past conversations are kept as sessions you can list, reread, and purge:

```ts
const listing = await client.chat.listChatSessions({ limit: 20 });
for (const session of listing.sessions) {
  console.log(session.title, "·", session.turnCount, "turns");
}

const transcript = await client.chat.getChatSession({ sessionId: listing.sessions[0].id });
for (const msg of transcript.messages) {
  console.log(`[${msg.role}] ${msg.content}`);
}

await client.chat.purgeChatSession({ sessionId: listing.sessions[0].id });
```

`purgeChatSession` permanently deletes the transcript and the server-side copy of its content — it cannot be undone. Purged sessions vanish from the list; pass `withPurged: true` to see their content-free stubs — title cleared, `purgedAt`/`purgeReason` set; timestamps, `turnCount`, and `endUserId` survive. Transcripts also age out automatically under your account's data-retention setting (each session's `purgeAt` tells you when). Purging requires an API key or a console sign-in — browser session tokens can list and read history, but never purge.

## Session tokens (browser embedding)

To embed search or chat in your own frontend, mint a short-lived session token **server-side** and hand that to the browser — never the API key:

```ts
// Server-side (holds the API key)
const session = await client.sessions.mintRetrievalToken({
  sessionTokenInDTO: { endUserId: "user-42", ttlSeconds: 900 },
});
// -> { token, expiresAt, expiresIn, tokenType }

// Browser (token only)
import { GeminaClient } from "@gemina/sdk";
const browserClient = GeminaClient.withSessionToken(session.token);
const results = await browserClient.retrieval.retrievalQuery({
  retrievalQueryInDTO: { text: "last month's invoices" },
});
```

For a drop-in chat UI, see `@gemina/elements` on npm.

## Human verification in the browser

`@gemina/elements` also ships `<GeminaVerification>`: a drop-in review step that puts the document next to every extracted field, lets a person correct what's wrong, and sends the corrections back to Gemina for accuracy scoring.

Mint the token **scoped to the extraction being reviewed** — an unscoped token that reaches a browser can read every extraction in your account:

```ts
// Server-side (holds the API key)
const session = await client.sessions.mintRetrievalToken({
  sessionTokenInDTO: {
    extractionIds: [extractionId], // up to 10; pins the token to these
    ttlSeconds: 900,
  },
});
```

An empty list is rejected rather than quietly minting a tenant-wide token. Your endpoint must check that the requesting end-user is allowed to see those extractions: Gemina enforces the claim, you decide who gets it.

Upload with `evaluation: true` to give the reviewer per-field confidence scores and the "hide everything already scored high" filter.

**Reading the result back** is one call, and it's the source of truth — the widget's browser callback is best-effort, this isn't:

```ts
const view = await client.documents.getDocumentExtraction({
  documentExtractionId: extractionId,
});

view.meta.validated;   // has a human verified this yet?
view.values;           // what the model extracted
view.verifiedValues;   // same shape, corrections merged in — null until verified
view.verifiedDiff;     // what the reviewer changed
```

`verifiedValues` is deliberately the same shape as `values`, so moving your pipeline from raw to human-verified data is a one-key change. Each `verifiedDiff` entry is `field`, `pointer`, `original`, `verified` and a `status` of `corrected`, `added` or `removed`; the pointer resolves against both payloads, so you can show before and after. All three fields also appear on the results-poll and list surfaces, so a batch job can sweep for `meta.validated` without fetching extractions one by one.

Verification is **one-shot** per extraction — a second submission is rejected with 409. To submit a review from your own UI instead of the widget:

```ts
const summary = await client.documents.validateDocumentExtraction({
  targetDocumentExtractionId: extractionId,
  extractionValidationInDTO: { data: correctedValues },
});
// summary.data -> per-field comparison against what was extracted
```

## Receiving webhooks

Gemina can POST to your server each time an extraction request finishes, so you do not have to poll for each result. Keep every request's correlation id all the same: an event is not guaranteed, and if none has arrived 15 minutes after a request was accepted, poll that request. A call that adds extractions to a document you already uploaded is a request of its own. It reports the upload's correlation id and the ids of the extractions it created (`newExtractionIds`): keep both, and count its 15 minutes from when it was accepted. An event for that correlation id covers the addition only when its result holds those extraction ids (in the event, or fetched from `resultPath` when the event left the result out). One that does not may be the upload's own event, arriving late, so keep the addition's check running. A request that asks only for FileTag does not send a webhook when it succeeds: its result comes back in the response. If such a request fails before FileTag has started on the file, a `failed` event can still arrive. Register your endpoint on the Webhooks page of the console; it gives you a signing secret that starts with `whsec_`.

`unwrapWebhook` checks that a delivery was signed with your secret and is recent, then returns a typed event. It does not remember what it has seen: the same delivery verifies again within five minutes, so your own code decides what a repeat is.

The sample needs nothing beyond Node.js 18 or later and this package. Save it as `webhook.mjs` and start it with `GEMINA_WEBHOOK_SECRET=whsec_... node webhook.mjs` (it listens on port 8099; set `PORT` to change that); it does not start without the secret.

```js
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { GeminaWebhookVerificationError, unwrapWebhook } from '@gemina/sdk';

const SECRET = process.env.GEMINA_WEBHOOK_SECRET;
if (!SECRET) {
  console.error("Set GEMINA_WEBHOOK_SECRET to your endpoint's signing secret (whsec_...).");
  process.exit(1);
}
// One inbox per endpoint. Set GEMINA_WEBHOOK_INBOX if another endpoint's receiver starts from this directory.
const INBOX = process.env.GEMINA_WEBHOOK_INBOX ?? 'webhook-inbox';
mkdirSync(INBOX, { recursive: true, mode: 0o700 }); // private: events hold extracted data
const MAX_BODY_BYTES = 2 * 1024 * 1024; // Gemina's bodies stay near 1 MB
const PORT = Number(process.env.PORT ?? 8099);

// Store the event under its id BEFORE answering. Write a private file first, then
// publish it under the event's id. The link fails if that id is already stored,
// and a half-written file never carries the id.
function store(id, body) {
  const final = join(INBOX, `${id}.json`);
  const partial = join(INBOX, `.${id}.${randomUUID()}.part`);
  try {
    const fd = openSync(partial, 'wx', 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(partial, final);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // EEXIST: a repeat of an event you already have
  } finally {
    rmSync(partial, { force: true });
  }
}

async function handle(req, res, body) {
  let event;
  try {
    event = await unwrapWebhook(body, req.headers, SECRET); // Node joins a repeated header with ", "
  } catch (error) {
    if (!(error instanceof GeminaWebhookVerificationError)) throw error;
    res.writeHead(400).end();
    return;
  }
  if (event.type === 'extraction.completed') store(event.id, body); // a test event, or a type added later, is not stored
  res.writeHead(200).end();
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/gemina/webhook') {
    res.writeHead(404).end();
    return;
  }
  const chunks = []; // the raw bytes, joined once at the end
  let size = 0;
  req.on('data', (chunk) => {
    if (size > MAX_BODY_BYTES) return; // already answered 413: keep nothing more
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { // anyone can post here: stop before holding more
      chunks.length = 0;
      res.on('finish', () => req.destroy()); // destroying the request first can cut the 413 off
      res.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > MAX_BODY_BYTES) return;
    handle(req, res, Buffer.concat(chunks)).catch((error) => {
      console.error('Gemina webhook not stored:', error); // not stored. A normal delivery is retried; a test or a resend is not
      res.writeHead(500).end();
    });
  });
}).listen(PORT);
```

The step that works through the inbox reads a stored event and records `data.status`, which is the outcome whatever happens next. If `resultIncluded` is true, it uses whichever of `data.result` and `data.error` is set (it does not choose by whether there is a `documentId`: a stored failure comes in `error` even when a document exists), and in `data.result` it looks at each extraction first: one whose `meta.purgedAt` is set has no values, so it records that extraction's detail as not available, exactly as for a fetched result. If `resultIncluded` is false, it fetches `resultPath` with the API key saved for that correlation id. (An upload made in the console, or by an assistant signed in to your account with no API key, has no such key: its result is read where the request was made, and the worker records `data.status` and moves on.) It then reads the answer in this order. A 202 first: keep the event in the inbox and fetch again after `Retry-After` (its body has the shape of a result, so a worker that looks at the body first would finish the item with nothing in it). Then a body that is a result document: on a 200 it is the result, and on a 4xx or 5xx it is the detail of a `partial` or `failed` event; an extraction in it whose `meta.purgedAt` is set has no values, because its content was deleted, so record that extraction's detail as not available, also on a 200. Then a connection failure, or a 5xx with no result document in it: leave the event in the inbox and try again later, up to a limit you choose. Any other answer, a 401, 403 or 404 or another error body, is about the fetch and not about the request, so it is never stored as the request's error: keep `data.status`, mark the detail as not available, and move on. A fetch returns the document as it is now, not as it was when the event was sent: if extractions were added since, the answer holds them too, and an event of their own may follow. So a worker that already has a result in the stored event keeps that one, and a worker that had no result in the event (it was too large) cannot tell which of the fetched extractions the event was about: it processes what the answer holds and does the work for each `extractionId` once, so a later event, if one comes, repeats nothing. The image and document links inside a result expire: a worker that gets to an event late fetches the result again from `resultPath`, with the same key, only to take fresh links for the extractions it already has. For an upload made in the console or by a signed-in assistant there is no such key, as above: fresh links come from where the request was made. The step that works through the inbox reads only names that end in `.json`: a `.part` file is never an event.

- **Pass the raw body, and limit its size.** Verify the bytes you received. If your framework parses JSON for you, read the raw body first; a parsed and re-encoded body will not verify. Anyone can post to a public URL, and the signature is checked only after the body is read, so stop reading at 2 MB. Gemina's bodies stay near 1 MB.
- **Store first, then answer.** Gemina waits 15 seconds for a 2xx. Save the event, answer, and do slow work afterwards. If you cannot save it, answer with a 5xx: Gemina sends an event again on its retry schedule, up to ten attempts over about three days. A test event, and an event you resent from the Webhooks page, is sent once and is not retried: send it again yourself.
- **Expect repeats.** A delivery can arrive more than once. `event.id` is the same each time, so store each id once. In production use your database or queue: one transaction that inserts the event id and the work to do. The inbox in the sample is there to make it run as printed; it is not a durable queue, and a file can be missing after a power loss.
- **The result may be left out.** When `resultIncluded` is false, the body has no `result` and no `error`. There are two reasons. A result over 1 MB can still be fetched from `resultPath`. A result whose content was already deleted cannot be fetched any more: the event's `status` is all there is. **Which credential fetches it.** `resultPath` answers only the API key that made the upload the correlation id belongs to, also when that key was used through an assistant. Extractions added to that document later keep the upload's correlation id, so the same key fetches them, wherever the addition was made, the console included. The event does not say which key that was, so if you use more than one, save which key it was next to each correlation id when you make the request: its id, or where you keep its secret, never its name, which can repeat and can change. Fetch with that key: a 404 under another key says nothing about the result. Two kinds of upload were not made with one of your API keys, so no API key can fetch them from `resultPath`. An upload made by an assistant that is signed in to your account with no API key: its result is read in that assistant (its `get_extraction_result` tool, with the event's `correlationId`), not by this code. An upload made in the console: read its result in the console. (The REST guide describes fetching with your account login.) For these two, this code records the event's `status` and stops: an error from `resultPath` says nothing about the result, so do not record it as unavailable. **The outcome is the event's `status`. Never take it from the fetch.** The fetch only adds the detail, and what it returns is the document as it is now: if more was extracted from the document after this event, the answer holds that too, and another event may come for it. Read the answer in this order. First, a 202: the document is being processed again, so keep the event and fetch again after the `Retry-After` time. Check the status code before the body, because a 202 has a result-shaped body. Second, a body that is a result document (its `meta` has a `documentId`): with a 200 it is the result, and with a 4xx or 5xx it is the detail of a `partial` or `failed` request, which is served with an error code. Look at each extraction in it before you record what you got: one whose `meta.purgedAt` is set has no values any more, because its content was deleted, and that is true with a 200 as well. Record such an extraction as not available. The same goes for a result that arrived inside the event: one extraction of a document can be deleted while the others stay, and the event then has `resultIncluded: true` with that extraction's `meta.purgedAt` set and no values. Because the answer is the document as it is now, it can hold extractions that a later event may bring again (a later event is not certain): do the work for each `extractionId` once. Third, a connection failure, or a 5xx with no result document in it: try again later, a limited number of times. Anything else (a 401, 403 or 404, or any other error body) is about the fetch, not about your request: this credential cannot fetch it, or the content is gone. Such a body also says `failed`; do not store it as the request's error. Keep the event's `status`, record that the detail is not available, and stop.
- **Managing endpoints from code** uses the `webhooks` group with your account-login token (the one the console signs in with), passed to `GeminaClient.withSessionToken`. An API key does not work, and neither does a retrieval session token from `sessions`.

## Going deeper

**Full API surface.** The convenience layer sits on top of a complete generated client. Every API group is available on the client as a lazy accessor: `documents`, `retrieval`, `chat`, `templates`, `files`, `fileTag`, `sessions`, `subscriptions`, `billing`. For example, list your stored documents:

```ts
const view = await client.documents.findDocuments({ limit: 10 });
for (const doc of view.data?.documents ?? []) {
  console.log(doc.meta.documentId, doc.meta.filename, doc.meta.createdAt);
}
```

**Polling knobs.** `processDocument` accepts `timeoutSeconds` (default 300), `initialIntervalSeconds` (default 2, grows ×1.5 per attempt), and `maxIntervalSeconds` (default 15). Transient poll errors (connection blips, 5xx) are retried automatically on the same schedule — up to 3 in a row — since the document is already submitted. On timeout it throws `GeminaTimeoutError` carrying the `correlationId`, so you can resume polling yourself:

```ts
import { GeminaTimeoutError } from "@gemina/sdk";

try {
  await client.processDocument(file, ["invoice_headers"], { timeoutSeconds: 60 });
} catch (err) {
  if (err instanceof GeminaTimeoutError) {
    // Still processing — poll later with the correlation ID:
    const result = await client.documents.getDocumentProcessingResultByCorrelationId({
      correlationId: err.correlationId,
    });
  }
}
```

**Error handling.** A terminal `failed` status throws `GeminaProcessingError` — its `result.errors` lists the failure details. Transport/HTTP errors from the generated client (`ResponseError`, `FetchError`) pass through unwrapped:

```ts
import { GeminaProcessingError, ResponseError } from "@gemina/sdk";

try {
  const result = await client.processDocument(file, ["invoice_headers"]);
} catch (err) {
  if (err instanceof GeminaProcessingError) {
    console.error("processing failed:", err.result.errors);
  } else if (err instanceof ResponseError) {
    console.error("HTTP error:", err.response.status);
  } else {
    throw err;
  }
}
```

**Custom base URL.** Point the client at a staging or self-hosted deployment via the second constructor argument:

```ts
const staging = new GeminaClient(apiKey, "https://api.staging.gemina.co");
```

## Requirements & support

- Node.js >= 18, or any browser with `fetch` (the SDK has zero runtime dependencies).
- Docs: https://console.gemina.co/docs
- Issues: https://github.com/tommyil/gemina-sdk/issues
- Email: support@gemina.co
