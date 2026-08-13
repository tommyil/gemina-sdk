# @gemina/elements

Embeddable browser UI for [Gemina](https://gemina.co) Document Intelligence:
drop-in React components for chat (`<GeminaChat>`) and human verification of
extractions (`<GeminaVerification>`), plus a security-hardened session-token
manager (`GeminaTokenManager`). Ask natural-language questions about the
invoices and financial documents you've processed with Gemina, or put a
verify-and-correct step in front of your workflow — without ever exposing
your Gemina API key to the browser.

## Install

```bash
npm i @gemina/elements @gemina/sdk react
```

- `react >= 18` is a peer dependency.
- `react-dom` is only needed by *your* app to render (and by the bundled
  demo) — the library itself never imports it.
- `GeminaTokenManager` has zero dependencies and no React requirement:
  import it alone via `@gemina/elements/token-manager`.

Subpath exports:

| Import | Contents | Needs React? |
|---|---|---|
| `@gemina/elements` | Everything | For the UI components only |
| `@gemina/elements/token-manager` | `GeminaTokenManager` | No |
| `@gemina/elements/chat` | `<GeminaChat>` | Yes |
| `@gemina/elements/verification` | `<GeminaVerification>` | Yes |

Both components are also exported from the package root, for bundlers and
TS configs that can't resolve `exports` subpaths.

## The security model (read this first)

Your Gemina **API key is a master key** — it can upload, read everything,
delete, and purge. It must live only on your server. The browser gets a
**short-lived (≤ 15 min), signed, query-only session token** instead:

```
┌─────────────────┐  1. POST /api/gemina-session        ┌──────────────────┐
│    Browser      │ ───(your own auth: cookie/JWT)────► │  YOUR backend    │
│                 │                                     │  (holds the      │
│ GeminaTokenMgr  │                                     │   API key)       │
│   + GeminaChat  │ ◄──{ token, expiresIn }─────────────│                  │
└───────┬─────────┘  4.                                 └───────┬──────────┘
        │                                                       │ 2. POST /v1/sessions/token
        │ 5. POST /v1/chat/query                                │    X-API-Key: <API key>
        │    Authorization: Bearer <session token>              ▼
        │                                               ┌──────────────────┐
        └─────────────────────────────────────────────► │   Gemina API     │
                                                        │ 3. mints signed, │
                                                        │    scoped token  │
                                                        └──────────────────┘
```

1. The browser asks **your backend** for a session token, authenticated by
   your existing user session.
2. Your backend calls Gemina's mint endpoint
   (`POST /api/v1/sessions/token`, `sessions.mintRetrievalToken` in
   `@gemina/sdk`) with your **API key — server-side only**.
3. Gemina returns a signed, query-only token pinned to your account
   (optionally narrowed to one `endUserId`). Scope is **signed into the
   token**; the browser cannot widen it.
4. Your backend hands the token (never the key) to the browser.
5. The chat component calls Gemina with the token; Gemina validates
   signature, expiry, and scope on every call.

## `GeminaTokenManager`

Holds the session token **in memory only** and keeps it fresh.

```ts
import { GeminaTokenManager } from "@gemina/elements/token-manager";

const tokenManager = new GeminaTokenManager({
  // Points at YOUR backend — see the mint endpoint below.
  fetchToken: async () => {
    const res = await fetch("/api/gemina-session", { method: "POST" });
    if (!res.ok) throw new Error("Failed to mint Gemina session token");
    return res.json(); // { token, expiresIn }
  },
  // Optional: seconds before expiry to refresh (default 60).
  refreshSkewSeconds: 60,
});
```

- `getToken(): Promise<string>` — fetches lazily on first use, caches, and
  auto-refreshes once the token is within `refreshSkewSeconds` of expiry.
  Concurrent callers share a single in-flight fetch (no request stampede).
- `invalidate(): void` — drops the cached token so the next `getToken()`
  re-mints (used internally by `<GeminaChat>` on a 401).
- No timers run while idle; refresh happens lazily inside `getToken()`, so
  it is SSR-safe and never keeps a Node process alive.
- The token is stored in module-private state (a `WeakMap` keyed by the
  instance), not as an instance property — it won't show up in
  `JSON.stringify`, spreads, or casual devtools inspection. This is
  hardening against accidental exposure, not encryption.

### The mint endpoint (server-side, yours)

Your backend mints tokens with `@gemina/sdk` — **this code must never run
in a browser**:

```ts
// Express
import express from "express";
import { GeminaClient } from "@gemina/sdk";

const gemina = new GeminaClient(process.env.GEMINA_API_KEY!);
const app = express();

app.post("/api/gemina-session", requireYourAppAuth, async (req, res) => {
  const minted = await gemina.sessions.mintRetrievalToken({
    sessionTokenInDTO: {
      // Optional: narrow this session to one of your end-users. The scope
      // is SIGNED into the token — the browser can't change it.
      endUserId: req.user.id,
      ttlSeconds: 900, // clamped server-side to [300, 900]
    },
  });
  res.json({ token: minted.token, expiresIn: minted.expiresIn });
});
```

```ts
// Next.js (App Router) — app/api/gemina-session/route.ts
import { NextResponse } from "next/server";
import { GeminaClient } from "@gemina/sdk";

const gemina = new GeminaClient(process.env.GEMINA_API_KEY!);

export async function POST(request: Request) {
  const user = await requireYourAppAuth(request); // your session check
  const minted = await gemina.sessions.mintRetrievalToken({
    sessionTokenInDTO: { endUserId: user.id, ttlSeconds: 900 },
  });
  return NextResponse.json({ token: minted.token, expiresIn: minted.expiresIn });
}
```

## `<GeminaChat>`

```tsx
import { GeminaChat } from "@gemina/elements";

<GeminaChat
  tokenManager={tokenManager}
  onCitationClick={(documentId) => openDocumentViewer(documentId)}
/>;
```

### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `tokenManager` | `GeminaTokenManager` | **required** | Session-token source. |
| `baseUrl` | `string` | `https://api.gemina.co` | Gemina API base URL. |
| `endUserId` | `string` | — | Forwarded with each query. On the token path the token's **signed** scope always wins server-side — this is a hint, not a security control. |
| `theme` | `"light" \| "dark" \| "auto"` | `"auto"` | `"auto"` follows `prefers-color-scheme`. |
| `dir` | `"ltr" \| "rtl" \| "auto"` | `"auto"` | `"auto"` flips the widget to RTL when the user's latest message contains Hebrew; bubbles also self-resolve via `dir="auto"`. |
| `placeholder` | `string` | `"Ask about your documents…"` | Input placeholder. |
| `title` | `string` | — | Header text — your brand or assistant persona (`"Acme Invoices"`, `"Gemina's AI Rep"`). When set, the header is always visible. Tint the bar with `--gemina-chat-header-bg`. |
| `intro` | `string` | — | Plain text centered in the empty conversation area until the first message — set expectations about what the assistant can see (e.g. `"Answers come from your indexed document data."`). Newlines split it into separately spaced paragraphs. |
| `onCitationClick` | `(documentId: string) => void` | — | Called when a citation chip is clicked. |
| `className` | `string` | — | Extra class(es) on the root (handy for CSS-variable overrides). |

Answers arrive with `documentId` citations rendered as chips; answers the
backend marks `confident: false` get a visually distinct low-confidence
treatment. Enter sends, Shift+Enter inserts a newline. The message list is
a `role="log"` live region with `aria-busy` while a reply is in flight, and
the input and send button are ARIA-labelled.

### Conversation memory

The widget keeps conversation memory automatically. The first message starts
a new server-side conversation; the response carries a `sessionId`, which the
component threads back into every following turn so the assistant can resolve
referents ("what about the total?", "and last year?") against what came
before. The id is held in memory for the life of the component — nothing is
persisted, and it's never surfaced as a prop or exposed to your app.

Once a conversation has any messages, a **New chat** button appears in the
widget header. Clicking it clears the transcript and forgets the current
`sessionId`, so the next message opens a fresh conversation; the previous
server-side session is deleted best-effort at the same time. The local reset
is authoritative — if the delete can't be reached, that session simply lapses
on its own idle TTL.

Server conversations expire after **24 hours of inactivity**. If you send a
message on a conversation the server has since forgotten (idle expiry, an
explicit reset, or end-user scope drift), the widget notices, drops the stale
id, and transparently retries as a new conversation — you just get your answer
back, with the prior memory gone. (A stale id that slips past this restart
falls back to the reset error below.)

### Error behavior

| API response | What the widget does |
|---|---|
| `401` | `tokenManager.invalidate()` + one automatic retry with a fresh token; if the retry also 401s → "Session expired — please reload the page or sign in again." |
| `429` | "You're sending messages too quickly — try again shortly." |
| `402` / `403` | "Document Intelligence isn't enabled on this plan." |
| `404` (a conversation the server forgot, past the transparent restart) | "This conversation is no longer available — send your message again to start a new one." with a **Retry** button. |
| anything else | Generic failure with a **Retry** button that resends the last message. |

### Theming

Styles are injected once, on mount, into a `<style data-gemina-chat>` tag.
All class names are scoped under `.gemina-chat`, and every color/shape is a
CSS custom property you can override from your own stylesheet (or via
`className`/inline style):

```css
.my-app .gemina-chat {
  --gemina-chat-accent: #7c3aed;
  --gemina-chat-radius: 4px;
}
```

| Variable | Purpose |
|---|---|
| `--gemina-chat-bg` / `--gemina-chat-fg` | Widget background / text |
| `--gemina-chat-border` | Borders (frame, input, chips) |
| `--gemina-chat-accent` / `--gemina-chat-accent-fg` | User bubble, send button, focus ring, citation chips |
| `--gemina-chat-assistant-bg` / `--gemina-chat-assistant-fg` | Assistant bubble |
| `--gemina-chat-muted` | Secondary text ("Thinking…") |
| `--gemina-chat-error` | Error messages and the retry button |
| `--gemina-chat-low-confidence` | Low-confidence border/caption |
| `--gemina-chat-radius` | Corner radius |
| `--gemina-chat-font` | Font stack |

`theme="dark"` (or `"auto"` under a dark `prefers-color-scheme`) swaps the
variable defaults; explicit overrides via the variables above always win.

### RTL

`dir="auto"` (the default) renders LTR until the user writes Hebrew, then
flips the widget to RTL; individual bubbles resolve their own direction so
mixed-language conversations stay readable. Pass `dir="rtl"` or
`dir="ltr"` to pin it.

### SSR

Importing either module touches no `window`/`document`, and no timers are
created at construction — safe for Next.js/Remix server rendering. Style
injection happens in an effect (mount, client-only). Render `<GeminaChat>`
normally; it becomes interactive on hydration.

## `<GeminaVerification>`

A human-in-the-loop verification step for one extraction: the document image
(zoomable, with per-field location flashes) next to every extracted field as
an editable input. The end-user confirms or corrects, submits once, and the
corrections go to Gemina's accuracy scoring **and** to your `onComplete`
callback so your workflow can continue with the verified data. Same security
model as chat, with one addition: the session token should be **scoped to the
extraction** being verified.

```tsx
import { useMemo } from "react";
import { GeminaVerification } from "@gemina/elements/verification";
import { GeminaTokenManager } from "@gemina/elements/token-manager";

function VerifyStep({ extractionId }: { extractionId: string }) {
  // Stable per extraction — never construct the manager inline in JSX.
  const tokenManager = useMemo(
    () =>
      new GeminaTokenManager({
        fetchToken: async () => {
          const res = await fetch("/api/gemina-verify-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ extractionId }),
          });
          if (!res.ok) throw new Error("Failed to mint Gemina session token");
          return res.json(); // { token, expiresIn }
        },
      }),
    [extractionId]
  );

  return (
    <GeminaVerification
      extractionId={extractionId}
      tokenManager={tokenManager}
      onComplete={({ correctedValues, summary }) => {
        // Continue your workflow with the verified data.
      }}
    />
  );
}
```

The `extractionId` in that request comes from the browser — a curious
end-user can substitute any ID:

> **Shared responsibility:** Your mint endpoint MUST authorize the requested
> `extractionIds` against the requesting end-user before minting. Gemina
> enforces the claim; you enforce who gets the claim.

### The scoped mint endpoint (server-side, yours)

Same as the chat mint endpoint, plus `extractionIds` — a claim signed into
the token that pins it to specific extractions:

```bash
curl -X POST https://api.gemina.co/api/v1/sessions/token \
  -H "X-API-Key: $GEMINA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlSeconds": 900, "extractionIds": ["<extraction-uuid>"]}'
```

A token minted without `extractionIds` still works (scope falls back to the
`endUserId` pin, or tenant-wide) — but an unscoped browser token lets any
end-user with devtools read any extraction in your account. Scope it.

### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `extractionId` | `string` | **required** | The extraction to verify. Must be inside the session token's scope. |
| `tokenManager` | `GeminaTokenManager` | **required** | Session-token source. Must be a stable instance — see the notes below. |
| `baseUrl` | `string` | `https://api.gemina.co` | Gemina API base URL. |
| `theme` | `"light" \| "dark" \| "auto"` | `"auto"` | `"auto"` follows `prefers-color-scheme`. |
| `dir` | `"ltr" \| "rtl" \| "auto"` | `"auto"` | `"auto"` flips to RTL when the extraction's field values contain Hebrew. |
| `onComplete` | `(result: VerificationCompletion) => void` | — | Called exactly once, after a successful submission. `correctedValues` is every submitted entry keyed by human label; `summary` is Gemina's scoring response. |
| `onError` | `(reason, detail?) => void` | — | Called on each terminal error/edge-state entry (a failed Retry re-fires it). Never fires for the already-verified read-only view. |
| `className` | `string` | — | Extra class(es) on the root (handy for CSS-variable overrides). |

`onError`'s `reason` is a stable union — match on it, never on message text:

```
"purged" | "not-available" | "not-completed" | "verification-unavailable"
  | "session-expired" | "load-failed" | "submit-failed"
```

### Edge states

| Situation | Behavior |
|---|---|
| `validated: true` on load | Read-only review + "already verified" banner; no submit. A success state — no `onError`. |
| Purged (retention policy) | "No longer available" state; `onError("purged")`. |
| 404 — nonexistent *or* out of token scope | Neutral "not available" state (no existence leak); `onError("not-available")`. |
| Extraction didn't complete | "Extraction did not complete" state; `onError("not-completed")`. |
| Completed, but no verification schema | `onError("verification-unavailable")`. |
| `401` | `tokenManager.invalidate()` + one automatic retry with a fresh token; a second 401 → `onError("session-expired")`. On the submit path, edits are preserved. |
| Network/5xx on load | Retry button; `onError("load-failed")`. |
| Network/5xx on submit | Corrections preserved in place, inline retry — user input is never lost; `onError("submit-failed")`. |
| `409` on submit (verified concurrently) | Silent refetch → the read-only already-verified view; no `onError`. |

### One-shot semantics

Submission is final; corrections are delivered to your `onComplete` and to
Gemina's accuracy scoring — they are not retrievable afterwards. The UI puts
an explicit confirm step, stating exactly that, in front of the submit.

### Integration notes

- **`onComplete` is best-effort delivery.** If the network drops the success
  response, the verification IS recorded server-side but `onComplete` does
  not fire (the component lands in the already-verified state on retry).
  Treat the server's verification status as the source of truth.
- **`tokenManager` must be a stable instance** — module-level, `useMemo`, or
  `useRef`. Constructing it inline in JSX re-fetches on every render.
- **`getToken()` has no built-in timeout** — enforce your own inside
  `fetchToken` (e.g. `AbortSignal.timeout`).

## What this package refuses to do

The five footguns from Gemina's token spec, designed out:

1. **Put the API key in the browser.** `GeminaTokenManager` throws at
   construction if handed a raw string, and rejects any API-key-shaped
   (32-alphanumeric) credential coming out of `fetchToken`. Non-JWT tokens
   are rejected too.
2. **Persist the token.** No `localStorage`, `sessionStorage`, cookies, or
   IndexedDB anywhere in this package — in-memory only, in module-private
   state. (A test suite enforces this.)
3. **Assert its own identity or scope.** Scope lives in the token's signed
   claims; the server derives every data filter from them. `endUserId` on
   the browser path is a hint the server ignores in favor of the signature.
4. **Reuse login credentials.** Session tokens come only from
   `POST /v1/sessions/token`; the widget never touches Gemina login JWTs.
5. **Mint, hold refresh tokens, or widen TTL/scope.** Renewal always
   round-trips through *your* authenticated backend via `fetchToken`.

## Demo

A no-build-system manual demo lives in [`demo/`](./demo). From
`packages/elements/`:

```bash
npx esbuild demo/demo.tsx --bundle --outfile=demo/demo.js --jsx=automatic \
  --define:process.env.NODE_ENV='"production"'
npx serve demo
```

Mint a session token server-side (see the comment in `demo/index.html`),
paste it into the page, and mount the chat. The demo never touches an API
key.

## License

MIT
