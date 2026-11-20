# Gemina Python SDK

The official Python client for the Gemina API — invoice OCR and document
intelligence: upload documents, get typed structured data back, then search,
aggregate, and chat over everything you've processed. Fully async (httpx +
pydantic v2), with typed models for every request and response.

## Install

```bash
pip install gemina
```

Requires Python 3.9 or newer.

## Authenticate

Get an API key from the [Gemina Console](https://console.gemina.co). The
client sends it as the `X-API-Key` header on every request — you never handle
the header yourself:

```python
from gemina import GeminaClient

client = GeminaClient("YOUR_API_KEY")
```

Never ship the API key in browser or mobile code. For browser embedding, mint
short-lived session tokens server-side (`POST /v1/sessions/token`) and hand
those to the frontend — see
[Session tokens](#session-tokens-browser-embedding) below and the Document
Intelligence guide at [console.gemina.co/docs](https://console.gemina.co/docs).

## Quickstart — process an invoice in one call

`process_document` submits the document through the async endpoints, polls
with exponential backoff until processing finishes, and returns the final
typed result — one call, no polling loop to write:

```python
import asyncio
from gemina import GeminaClient, UploadExtractionTypeEnum

async def main():
    async with GeminaClient("YOUR_API_KEY") as client:
        result = await client.process_document(
            "invoice.png",  # path, bytes, or a binary file object
            [UploadExtractionTypeEnum.INVOICE_HEADERS],
        )
        values = result.data.extractions[0].values
        print("Supplier:", values["vendorName"]["value"])
        print("Total:   ", values["totalAmount"]["value"], values["currency"]["value"])
        print("Date:    ", values["invoiceDate"]["value"])

asyncio.run(main())
```

To process a document that lives at a URL, wrap it in `UrlSource`:

```python
from gemina import GeminaClient, UploadExtractionTypeEnum, UrlSource

async def from_url():
    async with GeminaClient("YOUR_API_KEY") as client:
        result = await client.process_document(
            UrlSource("https://example.com/invoice.pdf"),
            [UploadExtractionTypeEnum.INVOICE_HEADERS],
        )
        print(result.status)
```

## What you get back

`process_document` returns a `DocumentProcessingResultOutDTO`:

- `result.status` — `success | partial | empty | failed` (`failed` raises
  `GeminaProcessingError` instead of returning; `partial` and `empty` are
  returned and still carry usable data and meta).
- `result.data.extractions` — one entry per requested extraction type; each
  has `.meta.extraction_type`, `.status`, and `.values`.
- `result.meta.document_id` / `result.meta.correlation_id` — the stored
  document's ID and the async request's correlation ID.

`extraction.values` is a dict keyed by field name (camelCase). Each field is
either `None` (not found) or an object with `value`, `coordinates` (present
when you pass `include_coordinates=True`), and `confidence`:

```python
values["vendorName"]     # {"value": "Acme Ltd", "coordinates": {...}, "confidence": ...}
values["totalAmount"]["value"]   # 1572.0
values["invoiceDate"]["value"]   # "2020-08-31"
values["taxes"]                  # list: [{"type": "vat", "rate": 17.0, "amount": 228.41, ...}]
```

Extraction types:

| Extraction type | What it extracts |
|---|---|
| `ocr` | Raw text of the document |
| `invoice_headers` | Invoice header fields: vendor/buyer, number, dates, amounts, taxes |
| `invoice_line_items` | Line items table |
| `document_details_hebrew` | Hebrew document header fields |
| `document_line_items_hebrew` | Hebrew line items |
| `custom_template` | Fields defined by your template (pass `template_id=...`) |

`filetag` is deliberately absent: the upload endpoints reject it, and FileTag
has its own endpoints.

## Search & aggregate your documents

Everything you process is indexed for retrieval. Query with natural language
and/or structured filters — results carry `document_id` citations back to the
original documents:

```python
from gemina import GeminaClient, RetrievalQueryInDTO
from gemina.generated.models.retrieval_filters_dto import RetrievalFiltersDTO

async def search():
    async with GeminaClient("YOUR_API_KEY") as client:
        page = await client.retrieval.retrieval_query(RetrievalQueryInDTO(
            mode="hybrid",                 # structured | semantic | hybrid
            text="cleaning services",
            filters=RetrievalFiltersDTO(total_amount_min=100),
            top_k=5,
        ))
        for item in page.items:
            print(item.vendor_name, item.total_amount, item.currency,
                  item.issue_date, item.document_id)
```

Aggregate across your documents (sum/avg/min/max/count, grouped by up to four
dimensions — when you aggregate money without fixing a currency, the server
adds a `currency` grouping so different currencies are never summed together):

```python
from gemina import GeminaClient, RetrievalAggregateInDTO
from gemina.generated.models.aggregate_metric_dto import AggregateMetricDTO

async def totals_by_vendor():
    async with GeminaClient("YOUR_API_KEY") as client:
        report = await client.retrieval.retrieval_aggregate(RetrievalAggregateInDTO(
            metrics=[
                AggregateMetricDTO(op="sum", field="total_amount"),
                AggregateMetricDTO(op="count"),
            ],
            group_by=["vendor_name"],
        ))
        for row in report.rows:
            print(row.group, row.values["sum_total_amount"].actual_instance,
                  row.values["count"].actual_instance)
```

`client.retrieval.retrieval_status()` tells you how many of your documents
are currently indexed.

**Advanced filters & match highlights.** Beyond the promoted `filters`, filter
on *any* structured field a document has with `structured_filters` (`op` is one
of `eq` / `neq` / `gt` / `lt` / `contains` / `exists`, max 8), and read back the
line-item snippet that made a document match via `matched_chunks`:

```python
from gemina import GeminaClient, RetrievalQueryInDTO
from gemina.generated.models.structured_filter_dto import StructuredFilterDTO

async def advanced_search():
    async with GeminaClient("YOUR_API_KEY") as client:
        page = await client.retrieval.retrieval_query(RetrievalQueryInDTO(
            mode="hybrid",
            text="27-inch monitors",
            structured_filters=[
                StructuredFilterDTO(path="position", op="contains", value="engineer"),
            ],
        ))
        for item in page.items:
            for chunk in item.matched_chunks or []:
                print(item.document_id, "matched on:", chunk.text)
```

Discover which fields you can filter on with
`client.retrieval.retrieval_fields()` — it returns the structured field names
per document type (names only, never values), so you can build a field picker
from real data:

```python
async def list_fields():
    async with GeminaClient("YOUR_API_KEY") as client:
        catalog = await client.retrieval.retrieval_fields()
        for f in catalog.fields:
            print(f.document_type, f.var_field, f.count)
            # e.g. invoice  vendor_name  42
```

## What did an extraction cost?

Credits are charged *after* the result is delivered, so cost is a separate
lookup rather than a field on the extraction response. Ask for one extraction,
or up to 100 at a time:

```python
single = await client.documents.get_extraction_cost(extraction_id)
print(single.data.state, single.data.credits_consumed)   # "settled"  "2.5"

bulk = await client.documents.get_extraction_costs([extraction_id, other_id])
for cost in bulk.data.costs:
    print(cost.extraction_id, cost.state, cost.credits_consumed)
```

`state` tells you whether the number is final:

- `settled` — the charge is on record; this is the authoritative number.
- `pending` — billing has not run yet. Retry.
- `not_charged` — billing finished without a charge. This never resolves, so
  don't poll it.

Enterprise accounts are billed in contract dollars: `credits_consumed` is
``None`` and `cost_cents` carries the amount. The bulk call silently omits ids
you don't own, so key the response by `extraction_id` rather than assuming
input order.

## Chat with your documents

Ask questions in natural language; answers come back with a `confident` flag
and `citations` (document IDs the answer relies on):

```python
from gemina import GeminaClient, ChatQueryInDTO

async def ask():
    async with GeminaClient("YOUR_API_KEY") as client:
        reply = await client.chat.chat_query(ChatQueryInDTO(
            message="What is the total amount of my invoices from last month?",
        ))
        print(reply.answer)
        print("confident:", reply.confident)
        print("citations:", reply.citations)
```

Chat requires a plan with Document Intelligence enabled — see
[pricing](https://gemina.co); without it these calls return 402/403.

**Multi-turn conversations (memory).** For a back-and-forth where follow-ups
keep context, use a **conversation** — it threads the server-issued
`session_id` for you, so you never touch the id:

```python
async def conversation():
    async with GeminaClient("YOUR_API_KEY") as client:
        chat = client.conversation()
        await chat.send("How much did we spend on cleaning in 2020?")
        follow = await chat.send("And which vendor was most expensive?")  # remembers 2020 / cleaning
        print(follow.answer, "· session:", chat.session_id)

        await chat.delete()   # end it server-side (or chat.reset() to just forget it locally)
```

A conversation's live context expires after roughly 24h of inactivity; the next
`send` then raises the API's `404 CHAT_SESSION_NOT_FOUND` — call `chat.reset()`
and resend to continue in a fresh one. The transcript itself is not lost: it
stays available in chat history (below) until your data-retention window — or an
explicit purge — removes it. One-shot `client.chat.chat_query(ChatQueryInDTO(
message=..., session_id=...))` is still available if you'd rather hold the id
yourself; every response returns a `session_id`.

## Chat history

Past conversations are kept as sessions you can list, reread, and purge:

```python
async def history():
    async with GeminaClient("YOUR_API_KEY") as client:
        listing = await client.chat.list_chat_sessions(limit=20)
        for session in listing.sessions:
            print(session.title, "·", session.turn_count, "turns")

        transcript = await client.chat.get_chat_session(listing.sessions[0].id)
        for msg in transcript.messages:
            print(f"[{msg.role}] {msg.content}")

        await client.chat.purge_chat_session(listing.sessions[0].id)
```

`purge` permanently deletes the transcript and the server-side copy of its
content — it cannot be undone. Purged sessions vanish from the list; pass
`with_purged=True` to see their content-free stubs — title cleared,
`purged_at`/`purge_reason` set; timestamps, `turn_count`, and `end_user_id` survive. Transcripts also age out automatically under your
account's data-retention setting (each session's `purge_at` tells you when).
Purging requires an API key or a console sign-in — browser session tokens can
list and read history, but never purge.

## Session tokens (browser embedding)

For browser or end-user contexts, mint a short-lived, query-only session
token server-side and hand *that* to your frontend — never the API key. An
optional `end_user_id` scopes the token to a single end-user's documents:

```python
from gemina import GeminaClient, SessionTokenInDTO

async def mint_token():
    async with GeminaClient("YOUR_API_KEY") as client:  # server-side only
        token = await client.sessions.mint_retrieval_token(SessionTokenInDTO(
            end_user_id="customer-42",   # omit for a whole-account session
            ttl_seconds=600,             # clamped server-side to [300, 900]
        ))
        return token.token               # ship this to the frontend
```

Token-authenticated clients (for server-side use of a token, or testing) are
created with `GeminaClient.with_session_token(token)`; tokens can call
retrieval query/aggregate, chat, and chat-history read endpoints, and end a
session — but never purge one (that takes an API key or a console sign-in).
For a drop-in chat UI in the browser, see the `@gemina/elements` package on
npm.

## Human verification in the browser

`@gemina/elements` also ships `<GeminaVerification>`: a drop-in review step
that puts the document next to every extracted field, lets a person correct
what's wrong, and sends the corrections back to Gemina for accuracy scoring.

Mint the token **scoped to the extraction being reviewed** — an unscoped token
that reaches a browser can read every extraction in your account:

```python
token = await client.sessions.mint_retrieval_token(SessionTokenInDTO(
    extraction_ids=[extraction_id],   # up to 10; pins the token to these
    ttl_seconds=900,
))
```

An empty list is rejected rather than quietly minting a tenant-wide token. Your
endpoint must check that the requesting end-user is allowed to see those
extractions: Gemina enforces the claim, you decide who gets it.

Upload with `evaluation=True` to give the reviewer per-field confidence scores
and the "hide everything already scored high" filter.

**Reading the result back** is one call, and it's the source of truth — the
widget's browser callback is best-effort, this isn't:

```python
view = await client.documents.get_document_extraction(extraction_id)

view.meta.validated    # has a human verified this yet?
view.values            # what the model extracted
view.verified_values   # same shape, corrections merged in — None until verified
view.verified_diff     # what the reviewer changed
```

`verified_values` is deliberately the same shape as `values`, so moving your
pipeline from raw to human-verified data is a one-name change. Each
`verified_diff` entry is `field`, `pointer`, `original`, `verified` and a
`status` of `corrected`, `added` or `removed`; the pointer resolves against
both payloads, so you can show before and after. All three fields also appear
on the results-poll and list surfaces, so a batch job can sweep for
`meta.validated` without fetching extractions one by one.

Verification is **one-shot** per extraction — a second submission is rejected
with 409. To submit a review from your own UI instead of the widget:

```python
from gemina.generated.models.extraction_validation_in_dto import (
    ExtractionValidationInDTO,
)

summary = await client.documents.validate_document_extraction(
    extraction_id,
    ExtractionValidationInDTO(data=corrected_values),
)
print(summary.data)   # per-field comparison against what was extracted
```

## Receiving webhooks

Gemina can POST to your server each time an extraction request finishes, so you do not have to poll for each result. Keep every request's correlation id all the same: an event is not guaranteed, and if none has arrived 15 minutes after a request was accepted, poll that request. A call that adds extractions to a document you already uploaded is a request of its own. It reports the upload's correlation id and the ids of the extractions it created (`newExtractionIds`): keep both, and count its 15 minutes from when it was accepted. An event for that correlation id covers the addition only when its result holds those extraction ids (in the event, or fetched from `resultPath` when the event left the result out). One that does not may be the upload's own event, arriving late, so keep the addition's check running. A request that asks only for FileTag does not send a webhook when it succeeds: its result comes back in the response. If such a request fails before FileTag has started on the file, a `failed` event can still arrive. Register your endpoint on the Webhooks page of the console; it gives you a signing secret that starts with `whsec_`.

`unwrap_webhook` checks that a delivery was signed with your secret and is recent, then returns a typed event. It does not remember what it has seen: the same delivery verifies again within five minutes, so your own code decides what a repeat is.

The sample needs FastAPI and uvicorn besides this package (`pip install gemina fastapi uvicorn`). Save it as `webhook.py` and start it with `GEMINA_WEBHOOK_SECRET=whsec_... uvicorn webhook:app --port 8099`; it does not start without the secret.

```python
import os
import pathlib
import uuid

from fastapi import FastAPI, Request, Response
from gemina import GeminaWebhookVerificationError, unwrap_webhook

SECRET = os.environ.get("GEMINA_WEBHOOK_SECRET", "")
if not SECRET:
    raise SystemExit("Set GEMINA_WEBHOOK_SECRET to your endpoint's signing secret (whsec_...).")
# One inbox per endpoint. Set GEMINA_WEBHOOK_INBOX if another endpoint's receiver starts from this directory.
INBOX = pathlib.Path(os.environ.get("GEMINA_WEBHOOK_INBOX", "webhook-inbox"))
INBOX.mkdir(mode=0o700, parents=True, exist_ok=True)  # private: events hold extracted data
MAX_BODY_BYTES = 2 * 1024 * 1024                      # Gemina's bodies stay near 1 MB

app = FastAPI()


@app.post("/gemina/webhook")
async def gemina_webhook(request: Request) -> Response:
    received = bytearray()                            # grows in place; `bytes +=` would copy it all each time
    async for chunk in request.stream():              # the raw bytes, before any JSON parsing
        if len(received) + len(chunk) > MAX_BODY_BYTES:   # anyone can post here: stop before holding more
            return Response(status_code=413)
        received.extend(chunk)
    body = bytes(received)
    try:
        event = unwrap_webhook(body, request.headers, SECRET)
    except GeminaWebhookVerificationError:
        return Response(status_code=400)

    if event.type != "extraction.completed":          # a test event, or a type added later
        return Response(status_code=200)

    # Store the event under its id BEFORE answering. Write a private file first,
    # then publish it under the event's id. The link fails if that id is already
    # stored, and a half-written file never carries the id. Any other failure is
    # raised: the server logs it and answers 500, and Gemina sends the event again
    # (a test event or a resend is not sent again).
    final = INBOX / f"{event.id}.json"
    partial = INBOX / f".{event.id}.{uuid.uuid4().hex}.part"
    try:
        with open(partial, "xb") as inbox_file:
            inbox_file.write(body)
            inbox_file.flush()
            os.fsync(inbox_file.fileno())
        os.link(partial, final)
    except FileExistsError:
        if not final.is_file():                       # the name is taken by something that is not the event
            raise
        # otherwise a repeat of an event you already have
    finally:
        partial.unlink(missing_ok=True)               # whatever happened, the temporary file goes
    return Response(status_code=200)
```

The step that works through the inbox reads a stored event and records `data.status`, which is the outcome whatever happens next. If `resultIncluded` is true, it uses whichever of `data.result` and `data.error` is set (it does not choose by whether there is a `documentId`: a stored failure comes in `error` even when a document exists), and in `data.result` it looks at each extraction first: one whose `meta.purgedAt` is set has no values, so it records that extraction's detail as not available, exactly as for a fetched result. If `resultIncluded` is false, it fetches `resultPath` with the API key saved for that correlation id. (An upload made in the console, or by an assistant signed in to your account with no API key, has no such key: its result is read where the request was made, and the worker records `data.status` and moves on.) It then reads the answer in this order. A 202 first: keep the event in the inbox and fetch again after `Retry-After` (its body has the shape of a result, so a worker that looks at the body first would finish the item with nothing in it). Then a body that is a result document: on a 200 it is the result, and on a 4xx or 5xx it is the detail of a `partial` or `failed` event; an extraction in it whose `meta.purgedAt` is set has no values, because its content was deleted, so record that extraction's detail as not available, also on a 200. Then a connection failure, or a 5xx with no result document in it: leave the event in the inbox and try again later, up to a limit you choose. Any other answer, a 401, 403 or 404 or another error body, is about the fetch and not about the request, so it is never stored as the request's error: keep `data.status`, mark the detail as not available, and move on. A fetch returns the document as it is now, not as it was when the event was sent: if extractions were added since, the answer holds them too, and an event of their own may follow. So a worker that already has a result in the stored event keeps that one, and a worker that had no result in the event (it was too large) cannot tell which of the fetched extractions the event was about: it processes what the answer holds and does the work for each `extractionId` once, so a later event, if one comes, repeats nothing. The image and document links inside a result expire: a worker that gets to an event late fetches the result again from `resultPath`, with the same key, only to take fresh links for the extractions it already has. For an upload made in the console or by a signed-in assistant there is no such key, as above: fresh links come from where the request was made. The step that works through the inbox reads only names that end in `.json`: a `.part` file is never an event.

- **Pass the raw body, and limit its size.** Verify the bytes you received. If your framework parses JSON for you, read the raw body first; a parsed and re-encoded body will not verify. Anyone can post to a public URL, and the signature is checked only after the body is read, so stop reading at 2 MB. Gemina's bodies stay near 1 MB.
- **Store first, then answer.** Gemina waits 15 seconds for a 2xx. Save the event, answer, and do slow work afterwards. If you cannot save it, answer with a 5xx: Gemina sends an event again on its retry schedule, up to ten attempts over about three days. A test event, and an event you resent from the Webhooks page, is sent once and is not retried: send it again yourself.
- **Expect repeats.** A delivery can arrive more than once. `event.id` is the same each time, so store each id once. In production use your database or queue: one transaction that inserts the event id and the work to do. The inbox in the sample is there to make it run as printed; it is not a durable queue, and a file can be missing after a power loss.
- **The result may be left out.** When `resultIncluded` is false, the body has no `result` and no `error`. There are two reasons. A result over 1 MB can still be fetched from `resultPath`. A result whose content was already deleted cannot be fetched any more: the event's `status` is all there is. **Which credential fetches it.** `resultPath` answers only the API key that made the upload the correlation id belongs to, also when that key was used through an assistant. Extractions added to that document later keep the upload's correlation id, so the same key fetches them, wherever the addition was made, the console included. The event does not say which key that was, so if you use more than one, save which key it was next to each correlation id when you make the request: its id, or where you keep its secret, never its name, which can repeat and can change. Fetch with that key: a 404 under another key says nothing about the result. Two kinds of upload were not made with one of your API keys, so no API key can fetch them from `resultPath`. An upload made by an assistant that is signed in to your account with no API key: its result is read in that assistant (its `get_extraction_result` tool, with the event's `correlationId`), not by this code. An upload made in the console: read its result in the console. (The REST guide describes fetching with your account login.) For these two, this code records the event's `status` and stops: an error from `resultPath` says nothing about the result, so do not record it as unavailable. **The outcome is the event's `status`. Never take it from the fetch.** The fetch only adds the detail, and what it returns is the document as it is now: if more was extracted from the document after this event, the answer holds that too, and another event may come for it. Read the answer in this order. First, a 202: the document is being processed again, so keep the event and fetch again after the `Retry-After` time. Check the status code before the body, because a 202 has a result-shaped body. Second, a body that is a result document (its `meta` has a `documentId`): with a 200 it is the result, and with a 4xx or 5xx it is the detail of a `partial` or `failed` request, which is served with an error code. Look at each extraction in it before you record what you got: one whose `meta.purgedAt` is set has no values any more, because its content was deleted, and that is true with a 200 as well. Record such an extraction as not available. The same goes for a result that arrived inside the event: one extraction of a document can be deleted while the others stay, and the event then has `resultIncluded: true` with that extraction's `meta.purgedAt` set and no values. Because the answer is the document as it is now, it can hold extractions that a later event may bring again (a later event is not certain): do the work for each `extractionId` once. Third, a connection failure, or a 5xx with no result document in it: try again later, a limited number of times. Anything else (a 401, 403 or 404, or any other error body) is about the fetch, not about your request: this credential cannot fetch it, or the content is gone. Such a body also says `failed`; do not store it as the request's error. Keep the event's `status`, record that the detail is not available, and stop.
- **Managing endpoints from code** uses the `webhooks` group with your account-login token (the one the console signs in with), passed to `GeminaClient.with_session_token`. An API key does not work, and neither does a retrieval session token from `sessions`.

## Going deeper

**Full API surface.** Every generated endpoint group is exposed on the client
— `client.documents`, `client.retrieval`, `client.chat`, `client.templates`,
`client.files`, `client.file_tag`, `client.sessions`, `client.subscriptions`,
`client.billing` — with zero wrapping. For example, listing stored documents:

```python
async def list_documents():
    async with GeminaClient("YOUR_API_KEY") as client:
        page = await client.documents.find_documents(limit=10)
        for doc in page.data.documents:
            print(doc.meta.document_id, doc.meta.created_at)
```

**Polling knobs.** `process_document` accepts `timeout_seconds` (default 300),
`initial_interval_seconds` (default 2.0) and `max_interval_seconds` (default
15.0). The wait grows 1.5x per poll, capped at the max, with +/-20% jitter.
Transient poll failures (connection blips, 5xx) are retried automatically on
the same schedule; after 3 consecutive failures the error is raised. On
timeout, `GeminaTimeoutError` carries `.correlation_id` and `.last_result`
so you can resume polling yourself:

```python
from gemina import GeminaError, GeminaProcessingError, GeminaTimeoutError

async def robust():
    async with GeminaClient("YOUR_API_KEY") as client:
        try:
            result = await client.process_document(
                "invoice.pdf",
                [UploadExtractionTypeEnum.INVOICE_HEADERS],
                timeout_seconds=120,
            )
        except GeminaProcessingError as exc:
            print("processing failed:", exc.result.errors)
        except GeminaTimeoutError as exc:
            print("still running, poll later:", exc.correlation_id)
            result = await client.documents.\
                get_document_processing_result_by_correlation_id(exc.correlation_id)
```

**Error handling.** Terminal `failed` results raise `GeminaProcessingError`
(`.result.errors` has the details). Transport and HTTP errors from the
generated client (e.g. `gemina.generated.exceptions.ApiException` subclasses
for 4xx/5xx) pass through unwrapped. All hand-written errors subclass
`GeminaError`.

**Custom base URL** (staging / self-hosted):

```python
client = GeminaClient("YOUR_API_KEY", base_url="https://api.staging.gemina.co")
```

**Using the SDK from synchronous code.** The client is async-first; from a
sync program, run calls with `asyncio.run(...)`:

```python
import asyncio

result = asyncio.run(main())   # where main() is an async def using GeminaClient
```

## Requirements & support

- Python >= 3.9
- Docs: [console.gemina.co/docs](https://console.gemina.co/docs)
- Issues: [github.com/tommyil/gemina-sdk/issues](https://github.com/tommyil/gemina-sdk/issues)
- Email: support@gemina.co
