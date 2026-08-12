import { describe, expect, it } from 'vitest';

describe('verification subpath', () => {
  it('exports the component and its prop types compile', async () => {
    const mod = await import('../../src/verification/index');
    expect(typeof mod.GeminaVerification).toBe('function');
  });
});
