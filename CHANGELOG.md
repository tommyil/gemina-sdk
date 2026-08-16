# Changelog

One version number covers all six published artifacts — the five language SDKs
and `@gemina/elements`. A tag moves them together even when a release only
changes one of them, so a version present on npm, PyPI, NuGet, Maven Central
and Packagist may be a no-op republish for some of them. SDK versions are
semver and independent of the Gemina API version; each entry names the API
spec snapshot it was generated from where that matters.

Pre-1.0: minor versions carry features and may change behaviour.

## v0.13.2 — 2026-08-16

Fixes from an external review of the confidence filter, each with a test that
fails without it:

- Planned tables are now matched with the same pointer rule the renderer uses.
  A server pointer of `/line_items` against a payload pointer of `/lineItems`
  silently matched nothing, so no row ever hid and no error was raised.
- Filtering entity cards no longer renumbers them. A hidden first card used to
  shift every following card's heading, React key, and accessible name while
  the inputs still edited the original field.
- Added the two states the design called for and the implementation had
  skipped: the whole-form all-clear (`Nothing needs review — all N fields
  scored high.`) and the section note explaining that row editing is off while
  filtering.

## v0.13.1 — 2026-08-16

Self-review fixes for the confidence filter: `unmatched` bindings and promoted
empty tables are counted as review units, so `Showing X of Y` can no longer
disagree with what's on screen; the footer wraps at 320px under RTL.

## v0.13.0 — 2026-08-16

**Confidence filter in `<GeminaVerification>`.** A switch — *Hide
high-confidence fields* — that hides everything the model already scored
`high`, so a reviewer sees only what needs a decision. On a 169-row invoice
that is 169 rows down to 7.

It appears only when the extraction carries confidence scores (upload with
`evaluation` enabled), is off by default, and never changes what gets
submitted. Only an explicit `high` hides: unscored, low, medium and unknown
always stay, as do fields you edited, fields with validation errors, and rows
you added. Row editing is disabled while filtering, because the row numbers on
screen would no longer be the row numbers being edited.

## v0.12.0 — 2026-08-16

Regenerated from API spec **1.6.2**. Every extraction read surface gains:

- `verifiedValues` — the same payload as `values`, from the same serializer,
  with the reviewer's stored corrections merged in. Switching payloads is a
  one-key change for clients.
- `verifiedDiff` — the typed change list (`VerifiedDiffEntry`), each entry
  carrying a pointer that resolves against both payloads.
- `meta.validated`, carried forward from wave 2.

`meta.verifiedFields` is gone. It only ever existed in API 1.6.1, which was
never frozen into a spec, so no generated SDK exposed it — not a break for any
released client.

## v0.11.0 — 2026-08-15

Verification UX wave 2, CSS-only in `@gemina/elements`:

- The document pane keeps its physical position under RTL. It is content, not
  chrome, and since `dir="auto"` flips per document the image used to jump
  sides between rows. This also fixes the RTL magnifier, whose inner layer
  inherited direction and landed a constant 704px off-target — Hebrew users
  saw an empty loupe.
- Line-item tables get sticky column headers, on a bounded scrollport on the
  table wrapper. The form gained its own stacking context so a stuck header
  can never paint over the document image in stacked mode.

## v0.10.0 — 2026-08-15

Generated from the frozen **1.6.0** spec. Verification UI fixes, plus
row-mutable taxes tables and typed custom-template tables.

## v0.9.0 — 2026-08-14

**Typed verification contract and row editing** — the feature half of a
two-tag release (see v0.8.0 for why it was split).

- Typed inputs with blocking validation and messages that name the fix.
- Enum selects that preserve an off-roster extracted value rather than
  discarding it.
- Add and remove line items, with a `rowSources` alignment so an insert scores
  `missing` and a delete scores `extra` without cascading a false correction
  onto every row below.
- Low-confidence row markers; the field descriptions the backend already
  publishes; portalled tooltips replacing every `title=`.
- Magnifier loupe fixes (border skew, off-image clamp).

`@gemina/elements` now requires `@gemina/sdk ^0.8.0`: on the older converter,
`validationFields` and `rowMutableTables` are dropped at the client boundary
and every typed feature above would have shipped inert.

## v0.8.0 — 2026-08-14

Regenerated from API **1.5.0**: the typed validation contract reaches all five
SDKs. `ValidationSchemaModel` now keeps `validationFields` and
`rowMutableTables`, and `ExtractionValidationInDTO` emits `rowSources`.

`@gemina/elements` 0.8.0 is a deliberate no-op republish of 0.7.0 — publishing
the new typed UI against the old converter would have produced a public
version with every typed feature dead and nothing failing anywhere.

## v0.7.0 — 2026-08-13

**`<GeminaVerification>`** — a human-in-the-loop review step for one
extraction, in `@gemina/elements`. The document (zoomable, with per-field
location flashes driven by extraction coordinates) beside every extracted
field as an editable input; the reviewer confirms or corrects, submits once
behind a confirm-final dialog, and the corrections go to Gemina's accuracy
scoring and to the host's `onComplete`.

Ships with the full edge-state contract (purged, out of scope, incomplete,
session expiry with one silent retry, 409-on-resubmission), theming and RTL,
silent image-URL refresh, and a manual demo page.

## v0.6.0 and earlier

Chat widget, retrieval and chat-history endpoints, extraction-cost endpoints,
and the initial generated clients. See `git log` between the `v*` tags.
