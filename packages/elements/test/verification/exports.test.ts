import { describe, expect, it } from 'vitest';

describe('verification subpath', () => {
  it('exports the component and its prop types compile', async () => {
    const mod = await import('../../src/verification/index');
    expect(typeof mod.GeminaVerification).toBe('function');
  });
});

describe('review filter is internal', () => {
  // Deliberately NOT re-exported: it is an implementation detail of the form,
  // and exporting it would make its shape API we have to keep.
  it('is not reachable from the package root or the verification subpath', async () => {
    const root = await import('../../src/index');
    const verification = await import('../../src/verification/index');
    for (const mod of [root, verification]) {
      expect('computeHidden' in mod).toBe(false);
      expect('isHighConfidence' in mod).toBe(false);
      expect('countUnits' in mod).toBe(false);
    }
  });
});

describe('the empty-columns filter is internal too', () => {
  // Same status, same pin: the emptiness rule and the two shared empty
  // instances are internals of the form, published to no one. They are
  // exported ACROSS modules (the root computes the rule, the form will render
  // it) but must not escape a package entry point, where their shape would
  // become API we have to keep.
  it('is not reachable from the package root or the verification subpath', async () => {
    const root = await import('../../src/index');
    const verification = await import('../../src/verification/index');
    for (const mod of [root, verification]) {
      expect('computeEmptyColumns' in mod).toBe(false);
      expect('NO_EMPTY_COLUMNS' in mod).toBe(false);
      expect('NO_PAIR_ERRORS' in mod).toBe(false);
    }
  });
});
