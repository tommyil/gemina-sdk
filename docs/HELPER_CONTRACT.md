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
- `extractionTypes`: required, non-empty list of `ExtractionTypeModel`.
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
4. Terminal handling:
   - `success`, `partial`, `empty` → **return** the result (callers check
     `status`; `partial`/`empty` still carry usable data/meta).
   - `failed` → throw `GeminaProcessingError` carrying the full result
     (its `errors` list has the details).

### Error types (hand-written, exported)

- `GeminaError` — base.
- `GeminaProcessingError(result)` — terminal `failed`.
- `GeminaTimeoutError(correlationId, lastResult?)` — deadline exceeded.
- Transport/HTTP errors from the generated client pass through unwrapped.

### Testability requirement

The polling wait must be injectable (a sleep function / scheduler / clock
parameter with a production default) so unit tests can assert the backoff
schedule without real waiting.

## 3. Unit tests (per language, mocked transport — no network)

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

## 4. Versioning

Package version lives in the hand-written manifest and in ONE hand-written
constants file per language (e.g. `version.ts`, `_version.py`) consumed by
the UA string. Generated metadata versions are irrelevant and discarded.
