import { describe, expect, it } from 'vitest';

import { countVariances, UncountedLinesError } from '../src/domain/stockCount.js';
import { fiscalYearLabel, formatDocNo } from '../src/lib/numbering.js';
import { createTransferSchema, createAdjustmentSchema } from '../src/shared/stockDocs.js';

/**
 * Day 14's pure rules: a count posts only its variances, document numbers carry the fiscal year,
 * and the document schemas refuse the shapes that would move stock wrongly.
 */

const line = (
  productId: string,
  expectedBase: number,
  countedBase: number | null,
  variantId: string | null = null,
) => ({
  productId,
  variantId,
  expectedBase,
  countedBase,
});

describe('countVariances — a count posts only the variance', () => {
  it('posts nothing for lines that match, and the difference for lines that do not', () => {
    const r = countVariances([
      line('frame', 60, 60), // matches → nothing
      line('case', 40, 37), // 3 missing
      line('cloth', 0, 12), // 12 found
      line('lens', 24, 24, 'sph-200'), // matches
    ]);
    expect(r.movements).toEqual([
      { productId: 'case', variantId: null, varianceBase: -3 },
      { productId: 'cloth', variantId: null, varianceBase: 12 },
    ]);
    expect(r.netVarianceBase).toBe(9);
    expect(r.counted).toBe(4);
  });

  it('posts no movement at all when everything matches', () => {
    expect(countVariances([line('a', 5, 5), line('b', 0, 0)]).movements).toEqual([]);
  });

  it('treats a counted zero as "none found", not as uncounted', () => {
    expect(countVariances([line('a', 7, 0)]).movements).toEqual([
      { productId: 'a', variantId: null, varianceBase: -7 },
    ]);
  });

  it('refuses uncounted lines by default — a missed shelf must not be written off', () => {
    expect(() => countVariances([line('a', 5, 5), line('b', 9, null)])).toThrow(
      UncountedLinesError,
    );
    try {
      countVariances([line('a', 5, null), line('b', 9, null)]);
    } catch (e) {
      expect((e as UncountedLinesError).uncounted).toBe(2);
    }
  });

  it('with skipUncounted, leaves uncounted lines as the system had them', () => {
    const r = countVariances([line('a', 5, 3), line('b', 9, null)], { skipUncounted: true });
    expect(r.movements).toEqual([{ productId: 'a', variantId: null, varianceBase: -2 }]);
    expect(r.uncounted).toBe(1);
  });
});

describe('fiscalYearLabel', () => {
  it('uses a July–June year, as Bangladesh does', () => {
    expect(fiscalYearLabel('2026-06-30', 7)).toBe('2526');
    expect(fiscalYearLabel('2026-07-01', 7)).toBe('2627');
    expect(fiscalYearLabel('2027-01-15', 7)).toBe('2627');
  });

  it('is the calendar year with a January start', () => {
    expect(fiscalYearLabel('2026-12-31', 1)).toBe('2026');
  });

  it('crosses a century boundary cleanly', () => {
    expect(fiscalYearLabel('2099-08-01', 7)).toBe('9900');
  });

  it('formats a document number', () => {
    expect(formatDocNo('ADJ', '2627', 7)).toBe('ADJ-2627-00007');
    expect(formatDocNo('TRF', '2627', 123456)).toBe('TRF-2627-123456');
  });
});

describe('document schemas', () => {
  const id = (c: string) => c.repeat(24);

  it('refuses a transfer to the same location, naming the destination', () => {
    const r = createTransferSchema.safeParse({
      fromLocationId: id('a'),
      toLocationId: id('a'),
      lines: [{ productId: id('c'), qty: 1 }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['toLocationId']);
  });

  it('refuses a transit leg equal to either end', () => {
    const r = createTransferSchema.safeParse({
      fromLocationId: id('a'),
      toLocationId: id('b'),
      transitLocationId: id('b'),
      lines: [{ productId: id('c'), qty: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a negative transfer quantity but allows a negative adjustment', () => {
    expect(
      createTransferSchema.safeParse({
        fromLocationId: id('a'),
        toLocationId: id('b'),
        lines: [{ productId: id('c'), qty: -1 }],
      }).success,
    ).toBe(false);
    expect(
      createAdjustmentSchema.safeParse({
        locationId: id('a'),
        reason: 'DAMAGED',
        lines: [{ productId: id('c'), qty: -3 }],
      }).success,
    ).toBe(true);
  });

  it('refuses a zero adjustment line', () => {
    expect(
      createAdjustmentSchema.safeParse({
        locationId: id('a'),
        reason: 'FOUND',
        lines: [{ productId: id('c'), qty: 0 }],
      }).success,
    ).toBe(false);
  });
});
