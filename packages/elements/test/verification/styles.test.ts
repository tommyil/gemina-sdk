import { afterEach, describe, expect, it } from 'vitest';

import { VERSION } from '../../src/version';

// Order-proofing: every test leaves a clean head, so the pristine-import
// assertion below holds under ANY test order (shuffle/isolate) instead of
// depending on running first.
afterEach(() => {
  document.head.querySelector('style[data-gemina-verification]')?.remove();
});

/**
 * The class names below are the styling contract for Tasks 7–17: every
 * selector a later task renders must already exist in the injected sheet.
 */
const CONTRACT_CLASS_NAMES = [
  '.gemina-verification',
  '.gemina-verification--dark',
  '.gemina-verification--auto',
  '.gemina-verification--rtl',
  '.gemina-verification--stacked',
  '.gemina-verification__viewer',
  '.gemina-verification__toolbar',
  '.gemina-verification__toolbar-btn',
  '.gemina-verification__toolbar-btn--active',
  '.gemina-verification__canvas',
  '.gemina-verification__rect',
  '.gemina-verification__rect-badge',
  '.gemina-verification__flash-rect',
  '.gemina-verification__panes',
  '.gemina-verification__form',
  '.gemina-verification__section',
  '.gemina-verification__section-header',
  '.gemina-verification__overall-confidence',
  '.gemina-verification__confidence-summary',
  '.gemina-verification__dl',
  '.gemina-verification__dt',
  '.gemina-verification__dd',
  '.gemina-verification__input',
  '.gemina-verification__input--dirty',
  '.gemina-verification__input--missed',
  '.gemina-verification__edited',
  '.gemina-verification__dot',
  '.gemina-verification__eye',
  '.gemina-verification__table',
  '.gemina-verification__table-wrap',
  '.gemina-verification__cell',
  '.gemina-verification__list',
  '.gemina-verification__card',
  '.gemina-verification__card-header',
  '.gemina-verification__section-body',
  '.gemina-verification__fallback',
  '.gemina-verification__banner',
  '.gemina-verification__banner--error',
  '.gemina-verification__progress',
  // The footer's two review switches and the notes/counts they render
  // alongside. Added late: the list's stated job is that every selector a
  // later task renders must already exist, and by the time both filters had
  // shipped these five were being rendered by nothing that would notice if
  // the rule behind them were deleted — an unstyled switch or an unstyled
  // note would have gone out green.
  '.gemina-verification__attention',
  '.gemina-verification__review-filter',
  '.gemina-verification__filter-count',
  '.gemina-verification__filter-note',
  '.gemina-verification__all-scored',
  '.gemina-verification__confirm',
  '.gemina-verification__confirm-dialog',
  '.gemina-verification__confirm-text',
  '.gemina-verification__confirm-actions',
  '.gemina-verification__confirm-cancel',
  '.gemina-verification__submit-error',
  '.gemina-verification__footer',
  '.gemina-verification__submit',
  '.gemina-verification__retry',
  '.gemina-verification__state',
  '.gemina-verification__state--done',
  '.gemina-verification__done-check',
  '.gemina-verification__done-title',
  '.gemina-verification__magnifier',
];

/**
 * A class name at a SELECTOR BOUNDARY, not merely somewhere in the sheet.
 *
 * The list above used to be checked with `toContain`, which is a substring
 * match — and a substring match cannot see a rename. `.gemina-verification__
 * filter-noteX` still contains `.gemina-verification__filter-note`, so a
 * selector renamed out from under the JSX that renders it passed, and the
 * feature shipped unstyled with this test green. (Deleting a rule was caught;
 * renaming one was not, and renaming is what a refactor actually does.)
 *
 * The lookahead is the whole fix: `-`, `_` and alphanumerics are the characters
 * a CSS identifier may continue with, so forbidding them after the name means
 * the match ended where the class does. Everything a real selector can be
 * followed by — ` `, `,`, `{`, `:`, `.`, `[`, `>`, a newline — is a boundary.
 * It also stops `.gemina-verification` itself from being satisfied by the 40
 * `.gemina-verification__*` rules that contain it.
 */
function selectorPattern(className: string): RegExp {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9_-])`);
}

describe('verification styles', () => {
  it('importing the module does not touch the document', async () => {
    await import('../../src/verification/styles');
    expect(document.head.querySelector('style[data-gemina-verification]')).toBeNull();
  });

  it('injects exactly one stylesheet across repeated calls, stamped with VERSION', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');

    ensureVerificationStylesInjected();
    ensureVerificationStylesInjected();

    const styles = document.head.querySelectorAll('style[data-gemina-verification]');
    expect(styles.length).toBe(1);
    expect(styles[0]?.getAttribute('data-gemina-verification')).toBe(VERSION);
    expect(styles[0]?.textContent).toContain('.gemina-verification');
    expect(styles[0]?.textContent).toContain('--gemina-verification-bg');
  });

  it('defines every contract class name later tasks render', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const css = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    for (const className of CONTRACT_CLASS_NAMES) {
      expect(css, `missing contract selector ${className}`).toMatch(selectorPattern(className));
    }
  });

  it('wraps the toolbar on narrow roots and keeps the counts copy LTR under RTL', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const css = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    // Below ~330px the 7 toolbar buttons overflow a single line; they must
    // wrap instead of clipping past the canvas edge.
    expect(css).toMatch(/\.gemina-verification__toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
    // "N confirmed · M corrected" is untranslated LTR chrome; without
    // plaintext the RTL paragraph direction reorders its leading number.
    // The done-state recap reuses __progress, so this one rule covers both.
    expect(css).toMatch(/\.gemina-verification__progress\s*\{[^}]*unicode-bidi:\s*plaintext/);
  });

  /* Task 7's browser pass, as four assertions. Each one is a rule that was
   * MEASURED to be needed, not a preference: probed in chromium and firefox at
   * 1440/1280/780/390/320, LTR and RTL, with both review filters on
   * (scripts/visual/probe-empty-columns.mjs in the console repo). */
  it('wraps the section header and keeps its notes quiet and LTR', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();
    const css = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';

    // With both filters on the header carries four children, the last of them
    // `white-space: nowrap` on `margin-inline-start: auto`. At 320 it was
    // pushed 36px (chromium) / 48px (firefox) past the header edge and
    // clipped, both directions — the same failure the footer's wrap fixed in
    // v0.13.1, on the row the fix never reached.
    expect(css).toMatch(/\.gemina-verification__section-header\s*\{[^}]*flex-wrap:\s*wrap/);
    // The header sets font-weight 600 for its LABEL. Without an explicit
    // weight the notes inherit it and a muted report becomes the boldest thing
    // in the row after the label — the opposite of what its own styling
    // comment says it is for.
    expect(css).toMatch(/\.gemina-verification__filter-note\s*\{[^}]*font-weight:\s*400/);
    // "1 column hidden — empty in this extraction" rendered as "empty 1 column
    // hidden" at 320 RTL before this: the RTL paragraph direction reorders a
    // leading number run. Same for the footer's "Showing 6 of 11".
    expect(css).toMatch(/\.gemina-verification__filter-note\s*\{[^}]*unicode-bidi:\s*plaintext/);
    expect(css).toMatch(/\.gemina-verification__filter-count\s*\{[^}]*unicode-bidi:\s*plaintext/);
    // Two adjacent notes are separated by a hairline rather than a character:
    // plaintext resolves the note's own content LTR, so a ::before lands on
    // the side AWAY from the sibling under RTL. A logical border resolves
    // against `direction`, which plaintext does not touch.
    expect(css).toMatch(
      /\.gemina-verification__filter-note \+ \.gemina-verification__filter-note\s*\{[^}]*border-inline-start/,
    );
  });

  it('keeps viewer chrome sticky, field eyes inline, and table actions padded', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();
    const css = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';

    expect(css).toMatch(/\.gemina-verification__toolbar\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.gemina-verification__dd\s*>\s*\.gemina-verification__input,[\s\S]*?width:\s*auto/);
    expect(css).toMatch(/\.gemina-verification__table-footer\s*\{[^}]*padding:\s*8px 10px;/);
  });

  it('owns the canvas img geometry and the data-cursor affordance states', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const css = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    // Task 8: the img's block/max-size geometry moved out of JSX into the sheet.
    expect(css).toContain('.gemina-verification__canvas img');
    // Cursor states are state-driven; a bare :active rule would promise
    // "grabbing" even at fit scale where pan never engages.
    expect(css).toContain(`.gemina-verification__canvas[data-cursor='zoom-in']`);
    expect(css).toContain(`.gemina-verification__canvas[data-cursor='grab']`);
    expect(css).toContain(`.gemina-verification__canvas[data-cursor='grabbing']`);
    expect(css).not.toContain('.gemina-verification__canvas:active');
  });
});

describe('rtl layout pinning', () => {
  it('pins the pane grid LTR and restores RTL only on the form pane', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const cssText = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    // The grid container is forced LTR so the document pane never swaps sides.
    expect(cssText).toMatch(
      /\.gemina-verification--rtl \.gemina-verification__panes \{[^}]*direction: ltr;/,
    );
    // The form pane restores RTL for Hebrew-first labels/values.
    expect(cssText).toMatch(
      /\.gemina-verification--rtl \.gemina-verification__form \{[^}]*direction: rtl;/,
    );
  });
});

describe('sticky table headers', () => {
  it('bounds the table wrapper and sticks the header row inside it', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const cssText = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    expect(cssText).toMatch(
      /\.gemina-verification__table-wrap \{[^}]*max-block-size: min\(56vh, 520px\);/,
    );
    expect(cssText).toMatch(/\.gemina-verification__table th \{[^}]*position: sticky;/);
    // collapse -> separate: collapsed borders belong to the row grid and
    // visually detach from a stuck header; separate keeps the th underline.
    expect(cssText).toMatch(/\.gemina-verification__table \{[^}]*border-collapse: separate;/);
  });

  it('isolates the form so a stuck header can never paint over the document', async () => {
    const { ensureVerificationStylesInjected } = await import('../../src/verification/styles');
    ensureVerificationStylesInjected();

    const cssText = document.head.querySelector('style[data-gemina-verification]')?.textContent ?? '';
    // The stacked-mode viewer is sticky at z-index 2; the sticky th is 3. In a
    // shared stacking context the header wins and covers the document image
    // (measured in both engines). The form must own a stacking context so its
    // internal z-indexes cannot escape it.
    expect(cssText).toMatch(/\.gemina-verification__form \{[^}]*isolation: isolate;/);
  });
});
