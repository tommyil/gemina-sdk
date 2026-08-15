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
      expect(css, `missing contract selector ${className}`).toContain(className);
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
