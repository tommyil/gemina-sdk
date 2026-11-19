# Hand-written helper layer — cross-language contract

Every language package ships the same thin, hand-written convenience layer on
top of its generated client. It is the ONLY hand-written code in `sdks/`
(everything else regenerates), it lives OUTSIDE the wiped generated directory,
and it must behave identically across languages. This document is the source
of truth; per-language deviations must be idiomatic-only (naming case,
async style), never semantic.

## 1. `GeminaClient` facade

Constructor: `(apiKey, baseUrl = "https://api.gemina.co", options?)`.

- Builds the generated `Configuration` with the `APIKeyHeader` security scheme
  (header `X-API-Key`) and sets user-agent `gemina-sdk-<lang>/<package-version>`
  where the platform allows a UA (all server-side languages; TS skips it —
  browsers forbid it).
- Exposes the generated API groups as lazily-constructed accessors:
  `documents`, `retrieval`, `chat`, `templates`, `files`, `fileTag`,
  `sessions`, `subscriptions`, `billing` (idiomatic casing per language).
  These are the escape hatch — full generated surface, zero wrapping.
- Exposes `processDocument(...)` / `process_document(...)` (below).
- Session-token auth variant: a static/named constructor
  `GeminaClient.withSessionToken(token, baseUrl?)` configuring the
  `OAuth2PasswordBearer` bearer scheme instead of the API key (used by
  browser/session contexts; primarily TS).

## 2. `processDocument` — the headline one-call flow

Submit a document via the ASYNC endpoints, poll until terminal, return the
typed result.

Signature (idiomatic per language):

```
processDocument(source, extractionTypes, options?) -> DocumentProcessingResultOutDTO
```

- `source`: either a file (path / bytes / stream / File — per language idiom)
  or a URL reference (explicit wrapper or named option, e.g.
  `{ url: "https://..." }` / `DocumentSource.fromUrl(...)`). Files submit via
  `POST /v1/documents/requests` (multipart, `create_document_processing_request`);
  URLs via `POST /v1/documents/requests/web`
  (`create_web_document_processing_request`).
- `extractionTypes`: required, non-empty list of `UploadExtractionTypeEnum` --
  the upload endpoints' own enum. It omits `filetag`, which those endpoints
  reject; FileTag is reached through the `fileTag` group instead. (Response
  models keep the wider `ExtractionTypeModel`.)
- `options` (all optional, mirror the endpoint form fields): `externalId`,
  `templateId`, `modelType`, `thinking`, `evaluation`, `correction`,
  `includeCoordinates`, `endUserId`, plus polling knobs below.

### Polling algorithm (identical everywhere)

1. Submit → 202 + `DocumentProcessingResultOutDTO`; read
   `meta.correlationId`. If the submit response is already terminal, skip
   to step 4. If non-terminal and `correlationId` is missing, raise the
   language's `GeminaError` (malformed server response).
2. Wait `interval`, starting at `initialIntervalSeconds` (default **2.0**),
   growing ×**1.5** per attempt, capped at `maxIntervalSeconds` (default
   **15.0**), each wait multiplied by a random jitter factor in
   **[0.8, 1.2]**.
3. `GET /v1/documents/results/{correlationId}`
   (`get_document_processing_result_by_correlation_id`). HTTP 202 and 200
   both carry the result body (declared in the spec). Non-terminal
   `status` (`pending`, `in_process`) → repeat from 2. Overall deadline
   `timeoutSeconds` (default **300**) exceeded → throw
   `GeminaTimeoutError` carrying `correlationId` and the last seen result
   (callers may resume polling themselves).

   **Transient poll failures are retried** (the document is already
   submitted; a load-balancer blip must not orphan it): an HTTP-level
   error from the poll call whose body is NOT a terminal `failed` result
   (see step 4a) — connection errors, 5xx with non-result bodies —
   counts as a failed attempt but the loop continues (same backoff,
   same overall deadline). After **3 consecutive** such failures,
   rethrow the last error unchanged. Any successful poll resets the
   counter. Submit errors are NOT retried (nothing was accepted yet) —
   they pass through unwrapped.
4. Terminal handling:
   - `success`, `partial`, `empty` → **return** the result (callers check
     `status`; `partial`/`empty` still carry usable data/meta).
   - `failed` → throw `GeminaProcessingError` carrying the full result
     (its `errors` list has the details).

   4a. **`failed` usually arrives as HTTP 500** whose body IS the
   `DocumentProcessingResultOutDTO` (live-verified): when the generated
   client throws on a poll (or submit) response, try to parse the error
   body as the result model; `status = failed` → `GeminaProcessingError`
   carrying it. Unparseable / non-`failed` bodies keep the original
   transport error (subject to the transient-poll-retry rule above).
   Handle `failed`-in-200-body too (defensive).

### Error types (hand-written, exported)

- `GeminaError` — base.
- `GeminaProcessingError(result)` — terminal `failed`.
- `GeminaTimeoutError(correlationId, lastResult?)` — deadline exceeded.
- Transport/HTTP errors from the generated client pass through unwrapped.

### Testability requirement

The polling wait must be injectable (a sleep function / scheduler / clock
parameter with a production default) so unit tests can assert the backoff
schedule without real waiting.

## 3. `conversation` — multi-turn chat threading

A thin STATEFUL helper over the one-shot `chat` group that threads the
server-issued `sessionId` across turns, so follow-up questions keep context.
It wraps `chat_query`; the one-shot call stays the primitive and callers may
still thread the id themselves.

Factory on the facade (idiomatic per language):

```
client.conversation(options?) -> Conversation
```

- `options` (all optional): `endUserId` (forwarded on every turn, for
  session-token / per-end-user contexts).
- Holds a single mutable `sessionId`, unset until the first turn returns.

### Methods

- `send(message) -> ChatQueryOutDTO` — the only method that hits the network.
  Calls `chat_query` with `message` (plus `endUserId`) and the current
  `sessionId` when set (omitted on the first turn). Stores the `sessionId`
  from the response before returning, so the next `send` threads it; if the
  response omits one, the previous id is kept.
- `sessionId` — read accessor for the current server session id (unset before
  the first `send` or after `reset`/`delete`), for logging/persistence.
- `reset()` — forget the session locally (clear `sessionId`); the next `send`
  starts a fresh server session. No network call.
- `delete()` — end the session server-side via the `chat` group's
  `delete_chat_session` (mirrors a "New chat" action) AND clear it locally.
  A no-op when no turn has been sent yet.

### Threading & staleness semantics

- A server session expires after **24h of inactivity**. A `send` carrying a
  stale id (idle-expired, or an id from a deleted session) surfaces the API's
  `404 CHAT_SESSION_NOT_FOUND` **unchanged** — the helper does **NOT**
  auto-retry or silently open a new session (that would drop the thread's
  context invisibly). Callers recover explicitly: `reset()` then `send` again.
- Requires a Document Intelligence plan, same as `chat_query` (402/403
  otherwise).

## 4. Unit tests (per language, mocked transport — no network)

Mock at the generated-API boundary (or HTTP layer where more natural) and
cover at minimum:

1. **Happy path**: submit → 2 non-terminal polls → `success`; result returned,
   correct correlationId used.
2. **Failure**: terminal `failed` → `GeminaProcessingError` carrying the result.
3. **Timeout**: never-terminal polls + tiny `timeoutSeconds` →
   `GeminaTimeoutError` with `correlationId`.
4. **Backoff schedule**: captured waits grow ×1.5 from 2.0 capped at max,
   with jitter within [0.8, 1.2] of the nominal value (inject a seeded/fake
   RNG or assert bounds).
5. **URL source** routes to the `/requests/web` endpoint.

## 5. Versioning

Package version lives in the hand-written manifest and in ONE hand-written
constants file per language (e.g. `version.ts`, `_version.py`) consumed by
the UA string. Generated metadata versions are irrelevant and discarded.

## 6. `unwrapWebhook`: verify and parse an incoming webhook

Gemina signs webhooks per Standard Webhooks v1
(https://www.standardwebhooks.com). Every language ships one function that
verifies a delivery and returns a typed event. It makes no network call and
needs no `GeminaClient`.

Signature (idiomatic per language):

```
unwrapWebhook(body, headers, secret, options?) -> WebhookEvent
```

- `body`: the raw request body exactly as received, as bytes or as a string
  (encoded as UTF-8). Callers must NOT pass a parsed-and-reserialised body:
  the signature covers the exact bytes. Each README says this first.
- `headers`: a mapping of header names to values. Names are matched ignoring
  ASCII case. The same header given twice with different values is rejected,
  whether the repeats arrive as separate entries, as a list, or already
  joined with ", " by an HTTP library.
- `secret`: the endpoint's signing secret, `whsec_...`.
- `options`: `toleranceSeconds` (default **300**), and an injectable clock so
  unit tests need no real time (the same requirement as the polling wait in
  §2). The clock returns seconds since the epoch and may return a fraction;
  the helper rounds it down to whole seconds. A clock or a tolerance that is
  not a finite number, or a negative tolerance, rejects the delivery with
  `timestamp_out_of_tolerance`: it never switches the check off. (In C#, Java
  and PHP the tolerance is declared as an `int`, so it cannot hold a
  non-finite value at all. Do not declare it as a `double`, as Java's other
  options in seconds are: with a `double`, `NaN` makes both comparisons false
  and an old, correctly signed delivery would verify.)

Every language accepts the body both as a string and as bytes, with and
without options.

### Algorithm (identical everywhere)

Every helper implements exactly these steps, in this order. The reason names are part of the contract: they are what the shared vectors assert.

1. **Copy the body once.** Take the body as received (bytes, or a string encoded as UTF-8) and make one private copy of the bytes. Every later step, the HMAC and the JSON parse alike, reads that copy. The caller's buffer is never read again. Never parse and re-serialise before verifying. A string that is not well-formed Unicode (an unpaired surrogate) is never a received body: decoding bytes from the wire cannot produce one. Where the platform's encoder raises (Python), the helper fails with `invalid_body`. Where it substitutes the replacement character (the other languages), the helper verifies and parses the substituted bytes like any other bytes. That almost always fails at step 8. It passes only when Gemina really signed those exact bytes, and the event returned is then the one Gemina signed, because it is parsed from the same copy. No native error leaves the helper either way.
2. **Read the three headers.** For each of `webhook-id`, `webhook-timestamp` and `webhook-signature`, in that order, collect the values of every entry whose name matches when ASCII case is ignored. An entry whose value is a list contributes each item. A value that contains a comma followed by a space is a list that an HTTP library already joined (a fetch `Headers` object does this to a repeated header): split it at each `, ` and treat each part as a value. No real value of these three headers contains a comma followed by a space. No value: fail with `missing_header`. Two or more values that are not all identical: fail with `ambiguous_header`. Identical repeats count as one.
3. **Check the timestamp's form.** The text must be 1 to 12 ASCII digits and nothing else: no sign, no spaces, no separators, and it is not trimmed. Otherwise fail with `invalid_timestamp`. Twelve digits always fit a 64-bit integer, so no later step can overflow.
4. **Check the timestamp's age.** Take the clock, round it down to whole seconds, and subtract. If the absolute difference is more than the tolerance (default 300 seconds), fail with `timestamp_out_of_tolerance`. Exactly 300 passes. The clock is injectable and may return a fraction. The clock must return a finite number and the tolerance must be a finite number that is not negative. If either is not (a `NaN` from an unset environment variable is the usual cause), freshness cannot be established: fail with `timestamp_out_of_tolerance` before any arithmetic. A comparison with `NaN` is false in every language, so without this check an old delivery would pass. Where a language's own parameter type refuses such a value before the helper runs (PHP's `int` tolerance refuses `NAN` and `INF` with a `TypeError`), that refusal stands: the delivery is not accepted either way.
5. **Decode the secret.** Remove one leading `whsec_` if present. The rest must be strict base64 (see below) and must decode to at least one byte. Otherwise fail with `invalid_secret`. An empty key is refused because anyone can compute an HMAC with it.
6. **Compute** `expected = HMAC-SHA256(key, id + "." + timestamp + "." + body)`, where `timestamp` is the header's text exactly as received.
7. **Compare.** Split the signature header on single spaces. For each entry, split once at the first comma into version and signature. Skip any entry whose version is not `v1` or whose signature is not strict base64. Compare the decoded signature with `expected` in constant time. Do not stop at the first match.
8. No match: fail with `no_matching_signature`.
9. **Parse the body.** The copy must not start with the UTF-8 byte order mark (`EF BB BF`), must be valid UTF-8, and must be exactly one JSON object: no second value after it, and no `NaN` or `Infinity`. Otherwise fail with `invalid_body`.
10. **Type the data.** For `extraction.completed` and `webhook.test`, `data` must be a JSON object that holds the required fields with the right JSON types (table below). It is then converted to the generated model through the same tolerant settings the polling path uses. For `extraction.completed`, a `result` or an `error` that is present and not null must also hold the fields in the table, and the two must not both be set: the generated converters disagree about a result with missing fields (Java refuses it, TypeScript and PHP return a model with holes), so the helper decides before they run. A missing or wrongly typed field, or any failure in the conversion, fails with `invalid_body`. A known event is never returned half typed. For any other `type`, or none, `data` is returned as parsed, so a new event type never breaks an old SDK.
11. Return an event carrying the id (from the header), `type`, `timestamp`, `data` and `raw`.

**Strict base64** means the standard alphabet, with padding, and no whitespace. One expression defines it in every language, applied before the platform decoder runs:

```
^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$
```

The platform decoders disagree without it: Java and PHP accept a missing `=`, and C# skips whitespace.

**Required fields of a known event's `data`:**

| Event type | Field | JSON type |
|---|---|---|
| `extraction.completed` | `correlationId`, `status`, `resultPath` | string |
| `extraction.completed` | `resultIncluded` | boolean |
| `extraction.completed` | `result`, when present and not null | object holding `status` (string), `meta` (object) and a `data` key (its value may be null) |
| `extraction.completed` | `error`, when present and not null | object holding `status` (string) |
| `extraction.completed` | `result` and `error` | never both set |
| `webhook.test` | `message` | string |

### Result

`WebhookEvent { id, type, timestamp, data, raw }`

- `id`: the `webhook-id` header. Receivers deduplicate on it.
- `type`: `extraction.completed`, `webhook.test`, an unknown string, or null
  when the body has no `type` (never "undefined" or a missing property).
- `data`: for `extraction.completed`, the generated
  `ExtractionCompletedEventData`. Its `result` is the generated
  `DocumentProcessingResultOutDTO` and its `error` is the generated
  `FoundationDTO`, both parsed with the SAME tolerant settings the polling
  path uses. At most one of the two is set: a body with both is rejected, and
  so is a `result` or `error` that lacks its required fields. For
  `webhook.test`, the generated
  `WebhookTestEventData`. Otherwise the raw parsed value.
- `raw`: the whole parsed body.

An unknown `type` is NOT an error. A new event type must not break an old SDK.

TypeScript, whose compiler narrows through a type guard, exports one check
per known type (`isExtractionCompleted`, `isWebhookTest`). In C# and Java
`data` is typed `object` / `Object`, and the caller narrows with the
language's own `is` / `instanceof` on the generated class. Those two test
suites read a typed field that way.

### Error

One hand-written, exported type extending the language's base error:
`GeminaWebhookVerificationError(reason, message)` (`...Exception` in C#, Java
and PHP). `reason` is one of: `missing_header`, `ambiguous_header`,
`invalid_timestamp`, `timestamp_out_of_tolerance`, `invalid_secret`,
`no_matching_signature`, `invalid_body`. No other error type leaves the
helper for any input.

### Tests

Each language runs every entry of `testdata/webhook_test_vectors.json` and of
`testdata/webhook_typed_vectors.json` (PHP: its synced copies). Each `valid`
entry must verify using that entry's `now` as the clock and yield
`expectType` (null means "no type field"). Each `invalid` entry, in either
file, must raise with exactly that entry's `reason`. Load the headers as given: two names that
differ only in case are two entries, so the loader must not fold them.

**What the vectors do not pin.** Some JSON parsers accept more than strict
JSON (Newtonsoft accepts single quotes, for example). The vectors pin the
rejections above and nothing beyond them. Only someone who holds the signing
secret can produce a signed body, so a looser parser on a signed body is not
a way in.

### Not in scope

Sending webhooks, and public-key (`v2a`) signatures. Managing endpoints is
done with the generated `webhooks` group (§1). Those routes need the
account-login JWT, the token the console signs in with. They do not accept an
API key, and they do not accept the retrieval session token that
`POST /v1/sessions/token` mints.
