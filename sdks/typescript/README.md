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

Extraction types (`ExtractionTypeModel`):

| Type | What it extracts |
|------|------------------|
| `ocr` | Raw OCR text |
| `invoice_headers` | Invoice header fields (vendor, buyer, dates, amounts, taxes) |
| `invoice_line_items` | Invoice line items |
| `document_details_hebrew` | Hebrew document details |
| `document_line_items_hebrew` | Hebrew document line items |
| `custom_template` | Fields defined by your custom template (pass `templateId`) |
| `filetag` | File classification metadata (FileTag) |

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
