# README template for the per-language SDK docs

Each `sdks/<lang>/README.md` instantiates this outline **in this order**, with
runnable code samples in its language. These files are also served by the
Gemina console docs (SDK toggle), so they must stand alone: no repo-relative
links, no build instructions for this monorepo. Tone: plain, direct, no
marketing fluff. Every code sample must actually work against the live API.

---

# Gemina <Language> SDK

One-paragraph pitch: official <language> client for the Gemina API — invoice
OCR and document intelligence: upload documents, get typed structured data
back, then search, aggregate, and chat over everything you've processed.

## Install

Registry one-liner (`npm i @gemina/sdk`, `pip install gemina`,
`dotnet add package Gemina.Sdk`, Maven `<dependency>` block,
`composer require gemina/sdk`). Minimum runtime versions.

## Authenticate

- API key from the [Gemina Console](https://console.gemina.co) → sent as
  `X-API-Key` (the client handles the header).
- Never ship the API key in browser/mobile code. For browser embedding, mint
  short-lived session tokens server-side (`POST /v1/sessions/token`) — link to
  the Document Intelligence guide.

## Quickstart — process an invoice in one call

The headline sample: construct `GeminaClient`, call
`processDocument(file, [invoice_headers])`, print supplier name / total /
date from the typed result. MUST use the async submit+poll helper — this is
the promoted path; explain in one sentence that it submits, polls with
backoff, and returns the final result.

Follow with the URL variant (one short sample).

## What you get back

Short walk of `DocumentProcessingResultOutDTO`: `status`
(`success | partial | empty | failed`), `data.extractions` keyed by
extraction type, `meta.documentId` / `meta.correlationId`. Table of the
extraction types (`ocr`, `invoice_headers`, `invoice_line_items`,
`document_details_hebrew`, `document_line_items_hebrew`, `custom_template`,
`filetag`).

## Search & aggregate your documents

`retrieval` group: `retrieval_query` (natural-language + filters),
`retrieval_aggregate`, `retrieval_status`. One runnable sample each for
query + aggregate; mention results carry citations back to documents.

## Chat with your documents

`chat` group: `chat_query` sample, `answer` + `confident` + citations.
Note: requires a plan with Document Intelligence enabled — link to pricing,
mention 402/403 otherwise.

## Session tokens (browser embedding)

Server-side sample: mint a token with the SDK
(`sessions` group / `mint_retrieval_token`), hand it to your frontend;
never the API key. Mention `@gemina/elements` for a drop-in chat UI (npm).

## Going deeper

- Full generated API surface via the group accessors (`client.documents`,
  `client.templates`, …) — one sample (e.g. list documents).
- Polling knobs: `timeoutSeconds`, `initialIntervalSeconds`,
  `maxIntervalSeconds`; `GeminaTimeoutError` carries `correlationId` so you
  can resume.
- Error handling: `GeminaProcessingError` (terminal `failed` with `errors`),
  transport errors pass through; show one try/catch sample.
- Custom base URL (self-hosted / staging).

## Requirements & support

Runtime version floor; docs link (https://console.gemina.co/docs); issues →
https://github.com/tommyil/gemina-sdk/issues; email support@gemina.co.
