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
`purged_at`/`purge_reason` set; timestamps and `turn_count` survive. Transcripts also age out automatically under your
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
