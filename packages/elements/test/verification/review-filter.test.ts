import { describe, expect, it } from 'vitest';
import { isHighConfidence } from '../../src/verification/review-filter';

const conf = (level: string | null) => (level ? { level, reasons: [] } : null);

describe('isHighConfidence', () => {
  it('is true only for an explicit high level', () => {
    expect(isHighConfidence(conf('high'))).toBe(true);
    expect(isHighConfidence(conf('HIGH'))).toBe(true);
  });

  // Unmeasured is not "reviewed and fine" — hiding it would drop it silently.
  it('is false for null, medium, low and anything unrecognised', () => {
    for (const level of [null, 'medium', 'low', 'certain', '']) {
      expect(isHighConfidence(conf(level))).toBe(false);
    }
  });

  it('is false for undefined', () => {
    expect(isHighConfidence(undefined)).toBe(false);
  });
});
