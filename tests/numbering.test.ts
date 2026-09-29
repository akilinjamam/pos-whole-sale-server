import { describe, expect, it } from 'vitest';

import { defaultSeriesConfig, formatNumber, periodFor } from '../src/shared/numbering.js';

/** The formatting half of numbering — pure. The concurrency half is `tests/integration`. */
describe('document number format', () => {
  it('defaults match what Day 14 was already issuing, so nothing is renumbered', () => {
    expect(formatNumber(defaultSeriesConfig('ADJ'), '2627', 1)).toBe('ADJ-2627-00001');
    expect(defaultSeriesConfig('WS').resetPolicy).toBe('YEARLY');
  });

  it('keeps party codes on a never-resetting series, in the shape the party service issues', () => {
    expect(defaultSeriesConfig('DLR').resetPolicy).toBe('NEVER');
    expect(formatNumber(defaultSeriesConfig('DLR'), 'ALL', 2)).toBe('P-00002');
  });

  it('omits the period for a series that never resets', () => {
    expect(
      formatNumber(
        { prefix: 'RCPT', padding: 6, resetPolicy: 'NEVER', separator: '/' },
        'ALL',
        42,
      ),
    ).toBe('RCPT/000042');
  });

  it('uses the fiscal year, the month, or nothing, by policy', () => {
    expect(periodFor('YEARLY', '2026-09-29', '2627')).toBe('2627');
    expect(periodFor('MONTHLY', '2026-09-29', '2627')).toBe('202609');
    expect(periodFor('NEVER', '2026-09-29', '2627')).toBe('ALL');
  });

  it('never truncates a sequence longer than its padding', () => {
    expect(formatNumber(defaultSeriesConfig('POS'), '2627', 1_234_567)).toBe(
      'POS-2627-1234567',
    );
  });
});
