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
