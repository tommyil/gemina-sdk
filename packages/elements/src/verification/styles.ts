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

/* --- Two-pane layout ------------------------------------------------------ */
.gemina-verification__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.gemina-verification--stacked .gemina-verification__panes {
  grid-template-columns: minmax(0, 1fr);
}
.gemina-verification--stacked .gemina-verification__viewer {
  position: sticky;
  top: 0; /* block axis, not inline — RTL-safe */
  z-index: 2;
}

/* --- Document viewer ------------------------------------------------------ */
.gemina-verification__viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--gemina-verification-bg);
  border: 1px solid var(--gemina-verification-border);
  border-radius: var(--gemina-verification-radius);
  overflow: hidden;
}
.gemina-verification__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 8px 10px;
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
     EXACTLY the console's per-channel fade: it multiplies the border (1·o),
     background (0.25·o), and glow (0.6·o / 0.3·o) alphas uniformly, which is
     what the console computed channel by channel. */
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
.gemina-verification__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
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
.gemina-verification__table-wrap { overflow-x: auto; }
.gemina-verification__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.gemina-verification__table th {
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
.gemina-verification__fallback {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--gemina-verification-surface);
  border-radius: calc(var(--gemina-verification-radius) - 4px);
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

/* --- Focus ---------------------------------------------------------------- */
.gemina-verification__input:focus-visible {
  outline: 2px solid var(--gemina-verification-accent);
  outline-offset: -1px;
}
.gemina-verification__toolbar-btn:focus-visible,
.gemina-verification__eye:focus-visible,
.gemina-verification__submit:focus-visible,
.gemina-verification__retry:focus-visible {
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
