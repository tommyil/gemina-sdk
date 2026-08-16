import { VERSION } from '../version';

// --- Styles -----------------------------------------------------------------
// Hand-rolled, no UI deps. Everything is scoped under .gemina-verification and
// driven by CSS custom properties so host apps can re-theme without touching
// the DOM. The palette and rhythm deliberately match the chat widget
// (chat.tsx) so both widgets read as one product when embedded side by side.
//
// Design intent: a focused reviewing tool. Document viewer on one pane, form
// on the other; quiet neutral surfaces everywhere; the confidence dots are the
// only saturated color in the form, and the overlay blue is reserved for the
// document canvas. Values are set in tabular numerals so amounts line up with
// the scanned document the reviewer is comparing them against.
//
// Layout uses logical properties exclusively (margin-inline-*, padding-inline,
// border-block-*) so RTL works for free. Physical left/top appear only inside
// the viewer canvas, where later tasks position geometry inline from JS —
// that is geometry, not layout.

const DARK_VARS = `
  --gemina-verification-bg: #101418;
  --gemina-verification-fg: #e6e9ee;
  --gemina-verification-border: #2a323c;
  --gemina-verification-accent: #4c8dff;
  --gemina-verification-accent-fg: #ffffff;
  --gemina-verification-surface: #1c232b;
  --gemina-verification-muted: #98a2b3;
  --gemina-verification-error: #f97066;
  --gemina-verification-input-bg: #12171d;
  --gemina-verification-input-border: #2a323c;
  --gemina-verification-dirty: #f7b27a;
`;

const VERIFICATION_CSS = `
.gemina-verification {
  --gemina-verification-bg: #ffffff;
  --gemina-verification-fg: #1a1d21;
  --gemina-verification-border: #d9dce1;
  --gemina-verification-accent: #2f6fed;
  --gemina-verification-accent-fg: #ffffff;
  --gemina-verification-surface: #f2f4f7;
  --gemina-verification-muted: #667085;
  --gemina-verification-error: #b42318;
  --gemina-verification-input-bg: #ffffff;
  --gemina-verification-input-border: #d0d5e2;
  --gemina-verification-dirty: #b54708;
  --gemina-verification-confidence-high: #52c41a;
  --gemina-verification-confidence-medium: #faad14;
  --gemina-verification-confidence-low: #ff4d4f;
  --gemina-verification-confidence-unknown: #d9d9d9;
  --gemina-verification-overlay-rgb: 24, 144, 255;
  --gemina-verification-radius: 10px;
  --gemina-verification-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  box-sizing: border-box;
  position: relative; /* anchors __confirm; never overflow:hidden here — it would break the stacked sticky viewer */
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  background: var(--gemina-verification-bg);
  color: var(--gemina-verification-fg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  font-family: var(--gemina-verification-font);
  font-size: 14px;
  line-height: 1.5;
}
.gemina-verification *, .gemina-verification *::before, .gemina-verification *::after { box-sizing: border-box; }
.gemina-verification--dark { ${DARK_VARS} }
@media (prefers-color-scheme: dark) {
  .gemina-verification--auto { ${DARK_VARS} }
}
.gemina-verification--rtl { direction: rtl; }
/* Content is not chrome: the document pane never mirrors (industry rule —
   images/players/clocks keep their physical position under RTL), and dir="auto"
   flips per DOCUMENT, so mirroring would make the image jump side per row.
   Forcing the grid container LTR pins physical order (image inline-left, form
   right, every language); the form pane alone restores RTL so Hebrew labels
   and values keep their natural direction (per-input dir="auto" still handles
   mixed-language values). The viewer subtree deliberately stays LTR: it is
   pure geometry (scroll math, loupe projection, absolute positioning) and none
   of that math may be direction-dependent.

   That last point is not theoretical — it IS the magnifier bug. The loupe's
   magnified inner layer is absolutely positioned with no inset (viewer.tsx
   gives it only a transform), so its static position is wherever the inherited
   direction puts the inline start. Under RTL that flips to the right edge and
   the layer lands (layerWidth - loupeWidth) away — measured as a constant
   -704px skew in BOTH chromium and firefox, at every pointer position, leaving
   the user an empty circle rather than a shifted one. Pinning this subtree LTR
   restores the skew to (0, 0), matching the LTR baseline exactly. Do not
   "simplify" this by mirroring the panes again. */
.gemina-verification--rtl .gemina-verification__panes { direction: ltr; }
.gemina-verification--rtl .gemina-verification__form { direction: rtl; }

/* --- Two-pane layout ------------------------------------------------------ */
.gemina-verification__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.gemina-verification--stacked .gemina-verification__panes {
  /* Flex column, NOT a one-column grid: a sticky GRID item is confined to its
     own grid area — whose auto row is exactly its own height, leaving zero
     travel — while a sticky FLEX child's containing block is the whole panes
     box, so the viewer genuinely floats over the form as it scrolls. The gap
     carries over from the base rule. */
  display: flex;
  flex-direction: column;
}
.gemina-verification--stacked .gemina-verification__viewer {
  position: sticky;
  top: 0; /* block axis, not inline — RTL-safe */
  z-index: 2;
  /* Cap AND height in one declaration: the canvas is absolutely-positioned
     geometry with no intrinsic height (it contributes only its min-height),
     so a max-block-size alone would never bind — the explicit block-size is
     what the canvas fills. 48vh keeps the majority of a short viewport for
     the form the reviewer is working through; 420px stops a tall narrow
     window from devoting a huge sticky band to the document. The dvh line
     wins where supported (mobile browser chrome shrinks the visual viewport). */
  flex: 0 0 auto;
  block-size: min(48vh, 420px);
  block-size: min(48dvh, 420px);
}
.gemina-verification--stacked .gemina-verification__canvas {
  /* The stacked cap owns the height; the side-by-side 280px floor would
     overflow it on short viewports (48vh of a 568px screen is ~273px). */
  min-height: 120px;
}

/* --- Document viewer ------------------------------------------------------ */
.gemina-verification__viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--gemina-verification-bg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  /* overflow hidden creates a scroll container and prevents the toolbar's sticky
     positioning from following the host modal's scrollport. Clip keeps the
     rounded frame without stealing sticky containment. */
  overflow: clip;
}
.gemina-verification__toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  /* Narrow roots (~<330px) can't fit all 7 buttons on one line: wrap to a
     second row instead of clipping past the canvas edge. The gap shorthand
     below already provides the 6px row-gap between wrapped rows. */
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px 10px;
  background: var(--gemina-verification-bg);
  border-block-end: 1px solid var(--gemina-verification-border);
}
.gemina-verification__toolbar-btn {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: calc(var(--gemina-verification-radius) - 4px);
  border: 1px solid var(--gemina-verification-border);
  background: transparent;
  color: var(--gemina-verification-fg);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}
.gemina-verification__toolbar-btn svg { display: block; } /* no inline-baseline slack under the icons */
.gemina-verification__toolbar-btn:hover:not(:disabled) { border-color: var(--gemina-verification-accent); }
.gemina-verification__toolbar-btn:disabled { opacity: 0.5; cursor: default; }
.gemina-verification__toolbar-btn--active {
  background: var(--gemina-verification-accent);
  border-color: var(--gemina-verification-accent);
  color: var(--gemina-verification-accent-fg);
}
.gemina-verification__canvas {
  position: relative;
  flex: 1;
  min-height: 280px;
  overflow: hidden;
  background: var(--gemina-verification-surface);
  touch-action: none;
  cursor: zoom-in; /* initial truth: at fit a drag is inert, wheel/dblclick zooms */
  user-select: none;
  -webkit-user-select: none;
}
/* Cursor is the promise of what a drag will do, so it follows viewer state
   (data-cursor), never :active — a bare :active rule would claim "grabbing"
   at fit scale where pan never engages. */
.gemina-verification__canvas[data-cursor='zoom-in'] { cursor: zoom-in; }
.gemina-verification__canvas[data-cursor='grab'] { cursor: grab; }
.gemina-verification__canvas[data-cursor='grabbing'] { cursor: grabbing; }
/* The document image is geometry, not layout: a block box at natural size,
   positioned purely by the JS transform layer above it. */
.gemina-verification__canvas img {
  display: block;
  max-width: unset;
  max-height: unset;
}
/* Overlay geometry (left/top/width/height) is set inline by the viewer from
   transform math; CSS owns only the appearance. */
.gemina-verification__rect {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  border: 2px solid rgba(var(--gemina-verification-overlay-rgb), 0.85);
  background: rgba(var(--gemina-verification-overlay-rgb), 0.16);
  border-radius: 2px;
}
/* Numbered "#1" chip on each overlay rect. Physical left/top: the badge lives
   in image coordinate space inside the transform layer (geometry, not layout),
   so it scales and rotates with the document exactly like the console's.
   Explicit line-height pins the chip height across host font stacks. */
.gemina-verification__rect-badge {
  position: absolute;
  top: -18px;
  left: 0;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  color: rgb(var(--gemina-verification-overlay-rgb));
  background: rgba(255, 255, 255, 0.92); /* floats over the document, not the theme surface */
  padding: 0 6px;
  border-radius: 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
  pointer-events: none;
}
.gemina-verification__flash-rect {
  /* Fade is driven by JS via element-level opacity (rAF travel animation);
     no CSS animation here so the two never fight. Element-level opacity is
     equivalent to the console's per-channel fade — border (1·o), background
     (0.25·o), glow (0.6·o / 0.3·o) — modulo overlapping-layer compositing:
     per-channel alphas blend border-over-background where they overlap,
     element opacity flattens the group first. Indistinguishable in practice. */
  position: absolute;
  z-index: 3;
  pointer-events: none;
  border: 5px solid rgba(var(--gemina-verification-overlay-rgb), 1);
  background: rgba(var(--gemina-verification-overlay-rgb), 0.25);
  box-shadow: 0 0 20px rgba(var(--gemina-verification-overlay-rgb), 0.6),
    inset 0 0 10px rgba(var(--gemina-verification-overlay-rgb), 0.3);
  border-radius: 2px;
}
.gemina-verification__magnifier {
  position: absolute;
  z-index: 4;
  pointer-events: none;
  overflow: hidden;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  background: var(--gemina-verification-surface);
}

/* --- Form pane ------------------------------------------------------------ */
/* A real <form> element (labeled AT landmark) — margin reset guards against
   host/UA form margins. */
.gemina-verification__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  margin: 0;
  /* Every z-index inside the form is form-internal business, and nothing in
     here may ever paint over the document. Without a stacking context of its
     own, the form's descendants resolve against the SAME context as the
     stacked-mode viewer (position: sticky, z-index: 2) — so the sticky header
     row (z-index: 3) painted straight over the document image as the form
     scrolled under the floating viewer. Confirmed in chromium and firefox
     before this line existed. Isolating caps the whole subtree beneath the
     viewer no matter what numbers it uses later. */
  isolation: isolate;
}
.gemina-verification__confidence-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  background: var(--gemina-verification-surface);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  color: var(--gemina-verification-muted);
  font-size: 12px;
  font-weight: 600;
}
.gemina-verification__section {
  background: var(--gemina-verification-bg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  overflow: hidden;
}
.gemina-verification__section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--gemina-verification-surface);
  border-block-end: 1px solid var(--gemina-verification-border);
  font-size: 13px;
  font-weight: 600;
}
.gemina-verification__overall-confidence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
  color: var(--gemina-verification-muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.gemina-verification__dl {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  column-gap: 12px;
  margin: 0;
  padding: 8px 12px;
}
.gemina-verification__dt {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-block: 5px;
  min-width: 0;
  font-size: 12px;
  color: var(--gemina-verification-muted);
  overflow-wrap: break-word;
}
.gemina-verification__dd {
  display: flex;
  /* Wrap so a field error takes its OWN line (it sets flex-basis:100%).
     Without this it competes with the input for width, and at 390px the
     message wrapped to one word per line while the input shrank to ~55px. */
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0; /* resets the UA's margin-inline-start on <dd> */
  padding-block: 5px;
  min-width: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}
.gemina-verification__input {
  width: 100%;
  font: inherit;
  font-size: 13px;
  color: var(--gemina-verification-fg);
  background: var(--gemina-verification-input-bg);
  border: 1px solid var(--gemina-verification-input-border);
  border-radius: calc(var(--gemina-verification-radius) - 4px);
  padding: 5px 8px;
}
/* FieldInput is a fragment. Let its control take the remaining row width
   instead of forcing width:100%, so a coordinate eye can sit beside it rather
   than wrapping onto a visually disconnected second line. */
.gemina-verification__dd > .gemina-verification__input,
.gemina-verification__cell > .gemina-verification__input {
  flex: 1 1 8ch;
  width: auto;
  min-width: 0;
}
.gemina-verification__input--dirty { border-color: var(--gemina-verification-dirty); }
.gemina-verification__input--missed {
  border-color: var(--gemina-verification-error);
  box-shadow: 0 0 0 1px var(--gemina-verification-error);
}
/* Non-color dirty channel: the word itself is the signal (WCAG 1.4.1) — it
   stays legible when --missed's error border overrides the dirty border. */
.gemina-verification__edited {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gemina-verification-dirty);
}
.gemina-verification__dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gemina-verification-confidence-unknown);
}
.gemina-verification__dot--high { background: var(--gemina-verification-confidence-high); }
.gemina-verification__dot--medium { background: var(--gemina-verification-confidence-medium); }
.gemina-verification__dot--low { background: var(--gemina-verification-confidence-low); }
.gemina-verification__dot--unknown { background: var(--gemina-verification-confidence-unknown); }
.gemina-verification__eye {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: calc(var(--gemina-verification-radius) - 4px);
  background: transparent;
  color: var(--gemina-verification-muted);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.gemina-verification__eye:hover {
  color: var(--gemina-verification-accent);
  background: var(--gemina-verification-surface);
}

/* --- Tables and cards ----------------------------------------------------- */
/* Section content that is not flush with the section frame (cards, fallback
   details) sits inside this padded body. */
.gemina-verification__section-body { padding: 8px 12px; }
/* Flex row for FieldInput's fragment (input + "edited" badge) inside <td>s
   and list items — the fragment has no container of its own. */
.gemina-verification__cell {
  display: flex;
  flex-wrap: wrap; /* same reason as __dd: the field error needs its own line */
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* Simple-list items stack inside a __dd; each item row is a __cell. */
.gemina-verification__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.gemina-verification__table-wrap {
  overflow-x: auto;
  /* Sticky binds to the nearest scrollport, and in an embedded widget that
     must be THIS wrapper (no per-host offset math). Bounding the block size
     turns it into a vertical scrollport too: long tables scroll internally
     with the header row pinned; short tables never reach the cap and are
     unchanged. */
  overflow-y: auto;
  max-block-size: min(56vh, 520px);
}
.gemina-verification__table {
  width: 100%;
  /* separate, not collapse: collapsed borders belong to the row grid, so a
     stuck header sheds its underline mid-scroll. With separate borders the
     border-block-end travels with the th. */
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.gemina-verification__table th {
  position: sticky;
  inset-block-start: 0;
  /* Above cell content and focus rings; below the viewer toolbar (5) and the
     confirm scrim. */
  z-index: 3;
  text-align: start;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--gemina-verification-muted);
  background: var(--gemina-verification-surface);
  border-block-end: 1px solid var(--gemina-verification-border);
}
.gemina-verification__table td {
  padding: 6px 10px;
  vertical-align: top;
  border-block-end: 1px solid var(--gemina-verification-border);
}
.gemina-verification__table tr:last-child td { border-block-end: 0; }
/* Wide tables lean on __table-wrap's scroll; the clamp keeps a cell input
   usable instead of letting the table squeeze it to nothing. */
.gemina-verification__table .gemina-verification__input { min-width: 6ch; }
.gemina-verification__card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--gemina-verification-bg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: calc(var(--gemina-verification-radius) - 4px);
}
.gemina-verification__card + .gemina-verification__card { margin-block-start: 8px; }
.gemina-verification__card-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--gemina-verification-muted);
}
/* The card already pads; its inner description list must not double it. */
.gemina-verification__card .gemina-verification__dl { padding: 0; }
/* Fallback blobs are a native <details>: summary is the toggle, the JSON
   lives in a <pre> so only the code is monospace/pre-wrapped. */
.gemina-verification__fallback {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  background: var(--gemina-verification-surface);
  border-radius: calc(var(--gemina-verification-radius) - 4px);
}
.gemina-verification__fallback + .gemina-verification__fallback { margin-block-start: 8px; }
.gemina-verification__fallback summary {
  cursor: pointer;
  font-weight: 600;
  user-select: none;
}
.gemina-verification__fallback pre {
  margin: 0;
  margin-block-start: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow-x: auto;
}

/* --- Messaging, progress, actions ----------------------------------------- */
.gemina-verification__banner {
  padding: 10px 12px;
  font-size: 13px;
  background: var(--gemina-verification-surface);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
}
.gemina-verification__banner--error {
  background: transparent;
  border-color: var(--gemina-verification-error);
  color: var(--gemina-verification-error);
}
.gemina-verification__progress {
  font-size: 12px;
  color: var(--gemina-verification-muted);
  font-variant-numeric: tabular-nums;
  /* The counts copy ("N confirmed · M corrected") is untranslated English
     chrome; under dir="rtl" the RTL paragraph direction reorders its
     leading-number run ("confirmed · 0 corrected 7"). plaintext makes the
     line take its base direction from its own first strong character, so
     the English copy lays out LTR inside the RTL widget. The done-state
     recap reuses this same class, so it is covered too. */
  unicode-bidi: plaintext;
}
.gemina-verification__footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-block-start: 12px;
  border-block-start: 1px solid var(--gemina-verification-border);
}
.gemina-verification__footer .gemina-verification__submit { margin-inline-start: auto; }
.gemina-verification__submit {
  font: inherit;
  border: none;
  border-radius: var(--gemina-verification-radius);
  background: var(--gemina-verification-accent);
  color: var(--gemina-verification-accent-fg);
  padding: 8px 16px;
  cursor: pointer;
}
.gemina-verification__submit:disabled { opacity: 0.5; cursor: default; }
/* The review filter is a VIEW MODE, not an action, so it stays quiet: an
   outline control in the muted color, next to the one loud thing in the
   footer. Turning it on fills it from the same accent token — the state has
   to be unmistakable, because the form is hiding content while it is on. */
.gemina-verification__review-filter {
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: var(--gemina-verification-radius);
  border: 1px solid var(--gemina-verification-border);
  background: transparent;
  color: var(--gemina-verification-muted);
  cursor: pointer;
}
.gemina-verification__review-filter:hover {
  color: var(--gemina-verification-accent);
  border-color: var(--gemina-verification-accent);
}
.gemina-verification__review-filter[aria-checked='true'] {
  background: var(--gemina-verification-accent);
  border-color: var(--gemina-verification-accent);
  color: var(--gemina-verification-accent-fg);
}
/* Stands in for a table's grid when every row of it scored high. Muted and
   unemphatic on purpose — it reports an absence, it is not a finding. */
.gemina-verification__filter-count {
  font-size: 12px;
  color: var(--gemina-verification-muted);
}
.gemina-verification__all-scored {
  margin: 0;
  padding: 12px;
  color: var(--gemina-verification-muted);
  font-size: 13px;
}
.gemina-verification__retry {
  font: inherit;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: var(--gemina-verification-radius);
  border: 1px solid var(--gemina-verification-error);
  background: transparent;
  color: var(--gemina-verification-error);
  cursor: pointer;
}
.gemina-verification__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 220px;
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--gemina-verification-muted);
}
/* Submit-error banner: message + inline Retry on one line. */
.gemina-verification__submit-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
/* Done: the one saturated moment outside the form — a single accent check. */
.gemina-verification__state--done { color: var(--gemina-verification-fg); }
/* Programmatic focus landing (tabIndex -1), not an interactive control: no
   ring — the accent check IS the visual landing; focus moves here purely so
   keyboard/AT users don't drop to <body> when the dialog unmounts. */
.gemina-verification__state--done:focus,
.gemina-verification__state--done:focus-visible { outline: none; }
.gemina-verification__done-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--gemina-verification-accent);
  color: var(--gemina-verification-accent-fg);
}
.gemina-verification__done-title {
  font-size: 14px;
  font-weight: 600;
}
.gemina-verification__state--done .gemina-verification__progress { font-size: 13px; }

/* --- Confirm dialog ------------------------------------------------------- */
.gemina-verification__confirm {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  /* flex-start + a sticky dialog: the scrim spans the whole component, but the
     dialog slides with the page so it is in view even when the user is
     scrolled deep into a long stacked form. Sticky (not fixed) so it survives
     transformed-ancestor hosts where fixed re-anchors. */
  align-items: flex-start;
  justify-content: center;
  padding: 16px;
  background: rgba(16, 20, 24, 0.45);
  border-radius: var(--gemina-verification-radius);
}
.gemina-verification__confirm-dialog {
  position: sticky;
  top: 20vh; /* block axis — RTL-safe */
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 380px;
  padding: 16px;
  background: var(--gemina-verification-bg);
  color: var(--gemina-verification-fg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  box-shadow: 0 12px 32px rgba(16, 20, 24, 0.24);
}
.gemina-verification__confirm-text {
  margin: 0;
  font-size: 13px;
}
.gemina-verification__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* Quiet counterpart to __submit: same geometry, bordered, no fill — the
   accent stays on the final action. */
.gemina-verification__confirm-cancel {
  font: inherit;
  padding: 8px 16px;
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  background: transparent;
  color: var(--gemina-verification-fg);
  cursor: pointer;
  transition: border-color 120ms ease;
}
.gemina-verification__confirm-cancel:hover:not(:disabled) {
  border-color: var(--gemina-verification-accent);
}
.gemina-verification__confirm-cancel:disabled { opacity: 0.5; cursor: default; }

/* --- Focus ---------------------------------------------------------------- */
.gemina-verification__input:focus-visible {
  outline: 2px solid var(--gemina-verification-accent);
  outline-offset: -1px;
}
.gemina-verification__toolbar-btn:focus-visible,
.gemina-verification__eye:focus-visible,
.gemina-verification__submit:focus-visible,
.gemina-verification__retry:focus-visible,
.gemina-verification__confirm-cancel:focus-visible,
.gemina-verification__fallback summary:focus-visible {
  outline: 2px solid var(--gemina-verification-accent);
  outline-offset: 1px;
}

/* --- Reduced motion -------------------------------------------------------- */
/* The viewer also checks this in JS before animating; the CSS block is the
   backstop that stills the canvas (flash, travel, micro-transitions). */
@media (prefers-reduced-motion: reduce) {
  .gemina-verification__flash-rect,
  .gemina-verification__rect,
  .gemina-verification__canvas,
  .gemina-verification__canvas * {
    animation: none;
    transition: none;
  }
}

/* A label that carries a description. Dotted underline is the long-standing
   convention for "there is more here", and tabIndex makes it reachable, so the
   tooltip is not mouse-only. */
.gemina-verification__label-described {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
}
.gemina-verification__label-described:focus-visible {
  outline: 2px solid var(--gemina-verification-accent);
  outline-offset: 2px;
}

/* Rows worth a second look. Uses the EXISTING confidence tokens — no new
   colours — as a start-edge rule, which is the one edge a reviewer scans down
   a long table. Logical property, so it lands on the right side under RTL. */
.gemina-verification__row--low > td:first-child,
.gemina-verification__row--medium > td:first-child {
  border-inline-start: 3px solid transparent;
}
.gemina-verification__row--low > td:first-child {
  border-inline-start-color: var(--gemina-verification-confidence-low);
}
.gemina-verification__row--medium > td:first-child {
  border-inline-start-color: var(--gemina-verification-confidence-medium);
}

/* --- Row editing ----------------------------------------------------------
   Quiet by design: adding and removing lines is a correction, not the primary
   action, so the controls stay muted until hovered and the accent is left to
   Submit. */
.gemina-verification__row-actions {
  white-space: nowrap;
  text-align: end; /* logical — RTL for free */
}
.gemina-verification__row-btn {
  font: inherit;
  line-height: 1;
  padding: 2px 7px;
  margin-inline-start: 4px;
  border-radius: calc(var(--gemina-verification-radius) - 5px);
  border: 1px solid var(--gemina-verification-border);
  background: transparent;
  color: var(--gemina-verification-muted);
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease;
}
.gemina-verification__row-btn:hover {
  border-color: var(--gemina-verification-accent);
  color: var(--gemina-verification-fg);
}
.gemina-verification__table-footer {
  display: flex;
  padding: 8px 10px;
}
.gemina-verification__add-row {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: calc(var(--gemina-verification-radius) - 4px);
  border: 1px dashed var(--gemina-verification-border);
  background: transparent;
  color: var(--gemina-verification-muted);
  cursor: pointer;
}
.gemina-verification__add-row:hover {
  border-style: solid;
  border-color: var(--gemina-verification-accent);
  color: var(--gemina-verification-fg);
}

/* --- Typed controls -------------------------------------------------------
   A <select> for a closed roster must sit on the same baseline as the text
   inputs beside it in a table row, so it inherits the input's box entirely and
   only overrides what a select needs. */
.gemina-verification__input:is(select) {
  cursor: pointer;
  /* A select's intrinsic width follows its longest option — the 24-member unit
     roster would blow out the column. */
  max-width: 100%;
}
/* The error border must beat --dirty and --missed: an invalid value is the
   most urgent thing true about the field, and the reviewer cannot submit
   until it is fixed. Placed after both for cascade order. */
.gemina-verification__input--invalid,
.gemina-verification__input--invalid:focus-visible {
  border-color: var(--gemina-verification-error);
}
/* Sits under the control it describes. Basis 100% breaks it onto its own line
   inside the flex row FieldInput renders into, so it never squeezes the
   input. */
.gemina-verification__field-error {
  flex-basis: 100%;
  margin-block-start: 4px;
  color: var(--gemina-verification-error);
  font-size: 12px;
  line-height: 1.35;
}

/* Replaces __progress while anything is invalid — same slot, so the footer
   never grows a second status line competing for the same attention. */
.gemina-verification__attention {
  color: var(--gemina-verification-error);
  font-size: 13px;
}

/* --- Tooltip -------------------------------------------------------------
   Renders in a portal on document.body, inside a div carrying the root's
   class list — so these rules and every --gemina-verification-* custom
   property resolve exactly as they do in the component.

   Quieter than __confirm-dialog on purpose: an annotation, not a decision.
   Same border and shadow family, one step down in radius (the nested-element
   convention used by __chip et al), surface rather than bg so it separates
   from the panel it floats over, and a shorter shadow so it reads as sitting
   just above the page rather than over a scrim. */
.gemina-verification__tip {
  position: fixed;
  z-index: 2147483000; /* above the host's own modal — this is the topmost layer */
  max-width: 260px;    /* ~60 characters: past that a tooltip should be body copy */
  padding: 8px 10px;
  background: var(--gemina-verification-surface);
  color: var(--gemina-verification-fg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: calc(var(--gemina-verification-radius) - 4px);
  box-shadow: 0 6px 16px rgba(16, 20, 24, 0.18);
  font-family: var(--gemina-verification-font);
  font-size: 12px;
  line-height: 1.45;
  text-align: start;   /* logical — RTL for free */
  pointer-events: none; /* never eat the hover that opened it */
}
/* Structured content: a level heading over a reasons list. The list is the
   reason this exists at all — title= could only ever have been one line. */
.gemina-verification__tip-title {
  display: block;
  font-weight: 600;
  margin-block-end: 4px;
}
.gemina-verification__tip-list {
  margin: 0;
  padding-inline-start: 16px;
}
.gemina-verification__tip-list li + li {
  margin-block-start: 2px;
}
/* A muted lead-in for single-fact tips ("Was:"), so the VALUE reads first. */
.gemina-verification__tip-label {
  color: var(--gemina-verification-muted);
}
`;

const STYLE_ATTR = 'data-gemina-verification';

/**
 * Inject the verification stylesheet once per document (idempotent across
 * instances; intentionally not removed on unmount so sibling instances and
 * quick remounts never flash unstyled). Safe to call during SSR: it no-ops
 * when there is no document, and importing this module never touches it.
 */
export function ensureVerificationStylesInjected(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.head.querySelector(`style[${STYLE_ATTR}]`) !== null) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, VERSION);
  style.textContent = VERIFICATION_CSS;
  document.head.appendChild(style);
}
