import { describe, expect, it } from 'vitest';

import { VERSION } from '../../src/version';

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
  '.gemina-verification__flash-rect',
  '.gemina-verification__panes',
  '.gemina-verification__form',
  '.gemina-verification__section',
  '.gemina-verification__section-header',
  '.gemina-verification__dl',
  '.gemina-verification__dt',
  '.gemina-verification__dd',
  '.gemina-verification__input',
  '.gemina-verification__input--dirty',
  '.gemina-verification__input--missed',
  '.gemina-verification__dot',
  '.gemina-verification__eye',
  '.gemina-verification__table',
  '.gemina-verification__table-wrap',
  '.gemina-verification__card',
  '.gemina-verification__fallback',
  '.gemina-verification__banner',
  '.gemina-verification__banner--error',
  '.gemina-verification__progress',
  '.gemina-verification__confirm',
  '.gemina-verification__confirm-dialog',
  '.gemina-verification__footer',
  '.gemina-verification__submit',
  '.gemina-verification__retry',
  '.gemina-verification__state',
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
});
