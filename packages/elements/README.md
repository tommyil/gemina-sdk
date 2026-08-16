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
  re-mints (used internally by `<GeminaChat>` and `<GeminaVerification>`
  on a 401).
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

Importing any of the three modules touches no `window`/`document`, and no
timers are created at construction — safe for Next.js/Remix server
rendering. Style injection happens in an effect (mount, client-only).
Render `<GeminaChat>` or `<GeminaVerification>` normally; they become
interactive on hydration.

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

### The flow, end to end

1. **Process the document** as usual, with your Gemina SDK. Turn on
   `evaluation` if you want the reviewer to see confidence scores.
2. **Mint a session token scoped to that extraction**, server-side, and hand
   it to the browser. Never the API key.
3. **Render the component.** The reviewer corrects what's wrong and submits
   once.
4. **Read the verified data back** — either from `onComplete` in the browser,
   or from the extraction itself server-side. See *Getting the verified data*
   below.

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

### What the reviewer sees

The document on one side, every extracted field as an editable input on the
other. The form's shape is derived from the extraction itself — you don't
describe your schema to the component:

| Section | What lands there |
|---|---|
| **Details** | Flat header fields (`supplier_name`, `total_amount`) and simple lists |
| Entity cards | Repeating objects that aren't tabular — e.g. several suppliers |
| Tables | Line items and other row/column arrays, rendered as an editable grid |
| **Additional Data** | Anything the classifier couldn't place — collapsible, read-only JSON |
| **Not detected** | Fields the server expects a value for that the extraction didn't find. Empty inputs, ready to fill in |

Inputs are typed from the server's own validation descriptors — the same
source of truth the scorer uses — so a `date` field gets a date input, a
`number` field rejects letters, and a closed roster becomes a dropdown.
Currency fields suggest ISO 4217 codes without requiring one: a reviewer
looking at a real invoice is the authority on what currency it's in. Invalid
input blocks **Submit** until it's fixed, with the reason inline.

Every field you change picks up an "edited" badge — a word, not just a color,
so it survives a field that's also flagged invalid. Where the extraction
carries coordinates, each field gets an eye button that zooms the viewer to
that spot on the page; fields without coordinates simply don't get the button.
The viewer itself pans, zooms (wheel, pinch, double-click to fit), rotates,
and has a magnifier loupe.

Submitting asks for confirmation first — *"Submit these values? This is final
— they can be submitted once and can't be changed."* — then reports back
`N confirmed · M corrected`.

### Review filters

The footer carries two of them. Both are **view modes, off by default**, both
reset whenever the component loads a different extraction, and **neither one
changes what gets submitted** — a hidden field, and a hidden column, are
submitted exactly as they would have been on screen. They are also independent
of each other: turning one on never changes what the other hides.

What it takes to *get* each switch is different, and it is the first thing to
check when one of them isn't there:

| Switch | Appears when |
|---|---|
| **Hide high-confidence fields** | The extraction carries confidence scores — i.e. it was uploaded with **`evaluation` enabled** |
| **Hide empty columns** | Some table has at least one hideable column — blank in every row, by the rules below. No upload option is involved; nothing has to be enabled |

#### Hide high-confidence fields

**Prerequisite:** run the extraction with **`evaluation` enabled** (the upload
option of that name in every Gemina SDK). Without it there are no scores, and
everything in this subsection is silently absent — no dots, no switch. That is
by design, but it is the first thing to check if you expected them.

With scores present, each field and each table row carries a colored
confidence dot, always paired with a text label and a tooltip listing the
model's reasons (color is never the only signal). The extraction's own overall
score sits at the top of the form, and each table's above its rows; those are
summaries rather than review units, so the filter never hides them. A switch
appears in the footer:

> **Hide high-confidence fields** — `Showing 12 of 47`

What it hides, precisely:

| Rule | Why |
|---|---|
| Only an explicit `high` hides | Unscored is not "reviewed" — nothing checked it, so hiding it would drop it from review silently. Low, medium and unknown always stay |
| A field you edited never hides | Your own change is the thing most worth a second look |
| A field with a validation error never hides | It can't be submitted as-is, so hiding it would strand the reviewer |
| A row hides whole, never per-cell | A line item is read as a line; half a row is worse than none |
| A row you added never hides | It was never extracted, so it has no score |

While the filter is on, row add/remove is disabled — the row numbers on screen
would no longer be the row numbers being edited. The section header says so:
*"Row editing is off while filtering"*.

The count next to the switch is the safety rail: a filtered form that looks
unfiltered is how a reviewer concludes data went missing. A table with nothing
left shows `All 169 rows scored high`; when the whole form is clear, it says
`Nothing needs review — all 47 fields scored high.`

#### Hide empty columns

**No prerequisite.** This one needs nothing enabled at upload — it reads the
extraction the component already has. It does need something to hide: the
switch appears only when some table has a column that is blank in every row,
and once you turn it on it stays put until you turn it off again.

It exists because a line-items table declares the columns its document *type*
can have, not the ones your document used. Across the invoice extractions we
measured, every line-items table declared 19 columns and left between 5 and 16
of them blank in every single row — so on the largest tables we sampled, the
reviewer scrolls a 19-column grid sideways to check 8 values. With the switch
on, that table reads as 8 columns. This is the normal state of the data, not an
edge case.

> **Hide empty columns**

Tables only — the **Details** section and entity cards are untouched, and no
count sits beside the switch (`Showing X of Y` counts review *units*, and a
column is not one). Each table that lost something says so in its own header
instead:

> `11 columns hidden — blank in every row`

What hides, precisely:

| Rule | Why |
|---|---|
| A column hides only when **every** cell in it is blank | One populated cell is a value the reviewer has to see. A column that is mostly blank stays |
| A cell you typed into keeps its column — even if you cleared it back to blank | Otherwise the column would unmount under the cursor of the person filling it in |
| A column holding a validation error never hides | It blocks Submit; hiding it strands the reviewer with a form that won't send and nothing on screen to fix. (Dropped in the already-verified read-only view, where nothing can be submitted anyway) |
| A table with no extracted rows hides nothing | An empty table is one you're still filling in, and every column of it is blank by definition |
| A table never hides **all** of its columns | The document-eye button, the confidence dot and *Remove line* are cells of the row; a table with no columns left would lose them too |

"Blank in every row" means every row of that table as it stands right now:
rows you added count, rows you removed don't, and rows the confidence filter is
hiding still count. So the set of hidden columns **moves while you work**, and
it moves in both directions. A cell you type into keeps its own column for the
rest of the session, whatever you leave in it — but an edit can move a
*different* column. Fill in a `unit_size` whose `unit_size_uom` partner is
blank throughout, and the error that raises on the partner brings that column
straight back; the cell blocking **Submit** is never one you can't see. Undo
that edit, or remove the row that carried it, and the partner is blank,
untouched and unerrored once more — so it hides again, in front of you. A
column populated only in a row you remove goes the same way.

**Row editing stays available while columns are hidden** — the opposite of the
confidence filter, which disables it. That filter hides *rows*, so the numbers
on screen stop being the numbers being edited; hiding columns leaves every row
where it was. The accepted cost is that a line you add now has no input for the
columns that are hidden, so the table says so beside *Add line*:

> `New lines can only fill the visible columns — turn off “Hide empty columns”
> to reach the rest.`

The switch is offered in the read-only view of an already-verified extraction
too. Reading someone else's completed review is exactly when column noise costs
the most.

### Editing table rows

Where the server declares a table row-mutable, each row gets **Insert line
below** and **Remove line** controls. This is not cosmetic: the component
sends the server an alignment between submitted rows and extracted ones, so an
inserted row scores as `missing` and a deleted one as `extra` — *without*
cascading a false correction onto every row below it. Corrections follow the
row, not the position, so a value typed into the third line stays with that
line after the first is deleted.

Tables the server hasn't declared row-mutable render as an editable grid with
a fixed row count.

### Getting the verified data

Two routes, and you'll usually want both:

| Route | Available | Carries |
|---|---|---|
| The `onComplete` prop | The instant the reviewer submits | `correctedValues` — every submitted entry keyed by human label — and `summary`, Gemina's scoring of the submission |
| Reading the extraction back, server-side | Any time afterwards, forever | `verifiedValues`, `verifiedDiff`, `meta.validated` |

`onComplete` is for continuing the user's session — closing the modal,
advancing your wizard, showing a thank-you. **The server read is the source of
truth.** If the network drops the success response the verification is still
recorded, and `onComplete` never fires.

The server read is one call, with your API key, using any Gemina SDK:

```ts
const view = await client.documents.getDocumentExtraction({
  documentExtractionId: extractionId,
});

view.meta.validated;   // has a human verified this yet?
view.values;           // what the model extracted
view.verifiedValues;   // the same shape, corrections merged in — null until verified
view.verifiedDiff;     // what the reviewer changed
```

`verifiedValues` is deliberately the *same shape* as `values`, from the same
serializer — switching your pipeline from raw to human-verified data is a
one-key change, not a reshape.

`verifiedDiff` is the change list, one entry per field the reviewer touched:

```ts
[{ field: "vendorTaxId", pointer: "/vendorTaxId/value",
   original: "51-234567", verified: "514234567", status: "corrected" }]
```

`status` is `"corrected"`, `"added"` or `"removed"`. Each `pointer` resolves
against **both** payloads, so you can show the before and after side by side.

The same three fields appear on the results-poll and list surfaces, so a batch
job can sweep for `meta.validated` without fetching extractions one at a time.

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

Submission is final. An extraction can be verified once: a second attempt is
rejected, and the component lands in the read-only already-verified view. The
UI puts an explicit confirm step, saying exactly that, in front of the submit.

What's submitted is not lost — it reaches your `onComplete`, Gemina's accuracy
scoring, and the extraction's `verifiedValues` / `verifiedDiff` on any later
read. What can't happen is a *second* round of corrections.

### Theming

Same mechanism as chat, different namespace: styles are injected once on
mount into a `<style data-gemina-verification>` tag, every class is scoped
under `.gemina-verification`, and every color and shape is an overridable
custom property.

```css
.my-app .gemina-verification {
  --gemina-verification-accent: #7c3aed;
  --gemina-verification-radius: 4px;
}
```

| Variable | Purpose |
|---|---|
| `--gemina-verification-bg` / `-fg` | Widget background / text |
| `--gemina-verification-surface` | Section panels, table headers, toolbar |
| `--gemina-verification-border` | Frames, table rules, dividers |
| `--gemina-verification-accent` / `-accent-fg` | Submit button, focus ring, switch |
| `--gemina-verification-input-bg` / `-input-border` | Field inputs |
| `--gemina-verification-muted` | Labels, captions, counts |
| `--gemina-verification-error` | Validation errors and failure states |
| `--gemina-verification-dirty` | The "edited" badge and its field border |
| `--gemina-verification-confidence-high` / `-medium` / `-low` / `-unknown` | The four confidence dots |
| `--gemina-verification-overlay-rgb` | Coordinate boxes and the flash highlight. An `R, G, B` triplet, not a color — it's composited at several opacities |
| `--gemina-verification-radius` | Corner radius |
| `--gemina-verification-font` | Font stack |

`theme="dark"` swaps the background/text/border/input set. The confidence and
overlay colors are deliberately shared across both themes — they encode
meaning, not mood. Your own overrides always win.

### RTL

`dir="auto"` (the default) inspects the extraction's field *values* and flips
the whole widget to RTL when they contain Hebrew, so a Hebrew invoice reads
correctly without you detecting anything. Layout uses CSS logical properties
throughout, so labels, table columns, row controls and the footer all mirror.

Two things deliberately don't: the **document pane keeps its side** — it's
content, not chrome, and since `dir="auto"` resolves per extraction, mirroring
it made the image jump sides between documents — and the viewer canvas stays
physical, because that's page geometry. Pass `dir="rtl"` or `dir="ltr"` to pin
the direction.

### Integration notes

- **`onComplete` is best-effort delivery.** If the network drops the success
  response, the verification IS recorded server-side but `onComplete` does
  not fire (the component lands in the already-verified state on retry).
  Treat the server's verification status as the source of truth.
- **The corrections outlive the callback.** Reading the extraction back
  server-side gives you `verifiedValues` — the same shape as `values` with the
  reviewer's corrections merged in — and `verifiedDiff`, the typed list of
  what changed. Both are null until someone verifies. Prefer these over
  storing the callback payload yourself.
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

No-build-system manual demos live in [`demo/`](./demo) — one page per
component. From `packages/elements/`:

```bash
# Chat -> demo/index.html
npx esbuild demo/demo.tsx --bundle --outfile=demo/demo.js --jsx=automatic \
  --define:process.env.NODE_ENV='"production"'

# Verification -> demo/verification.html
npx esbuild demo/verification-demo.tsx --bundle \
  --outfile=demo/verification-demo.js --jsx=automatic \
  --define:process.env.NODE_ENV='"production"'

npx serve demo
```

Mint a session token server-side (each page's HTML comment has the exact
`curl`), paste it into the page, and mount. The verification page also asks
for an extraction id, which must be inside that token's `extractionIds`
scope. Neither demo ever touches an API key.

## License

MIT
