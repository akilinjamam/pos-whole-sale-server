import { describe, expect, it } from 'vitest';

import {
  adjustPrice,
  bulkAdjustSchema,
  createPriceEntrySchema,
  windowsOverlap,
} from '../src/shared/pricing.js';

/**
 * The two pieces of price-list arithmetic both sides must agree on. `windowsOverlap` decides
 * whether a new price is refused as a duplicate; `adjustPrice` is what a bulk % change writes —
 * and what its preview promises it will write.
 */

const w = (validFrom: string | null, validTo: string | null) => ({ validFrom, validTo });

describe('windowsOverlap', () => {
  it('treats two open-ended windows as overlapping', () => {
    expect(windowsOverlap(w(null, null), w(null, null))).toBe(true);
  });

  it('is inclusive at both ends — sharing one day is an overlap', () => {
    expect(windowsOverlap(w('2026-01-01', '2026-03-31'), w('2026-03-31', null))).toBe(true);
  });

  it('allows back-to-back windows — the normal way to change a price', () => {
    expect(windowsOverlap(w('2026-01-01', '2026-03-31'), w('2026-04-01', null))).toBe(false);
    expect(windowsOverlap(w('2026-04-01', null), w('2026-01-01', '2026-03-31'))).toBe(false);
  });

  it('catches a partial overlap the unique index cannot see', () => {
    expect(windowsOverlap(w('2026-01-01', '2026-03-31'), w('2026-03-01', '2026-06-30'))).toBe(
      true,
    );
  });

  it('treats an open start as reaching back forever', () => {
    expect(windowsOverlap(w(null, '2026-03-31'), w('2025-01-01', '2025-01-31'))).toBe(true);
    expect(windowsOverlap(w(null, '2026-03-31'), w('2026-04-01', null))).toBe(false);
  });

  it('is symmetric', () => {
    const a = w('2026-02-01', '2026-02-28');
    const b = w('2026-02-15', null);
    expect(windowsOverlap(a, b)).toBe(windowsOverlap(b, a));
  });
});

describe('adjustPrice', () => {
  it('applies the percentage and rounds half up to the step', () => {
    // ৳4,500 + 10% = ৳4,950, already on a ৳50 step.
    expect(adjustPrice(450_000, 10, 5000)).toBe(495_000);
    // ৳4,505 + 0% would be refused by the schema; +1% = ৳4,550.05 → nearest ৳10 = ৳4,550.
    expect(adjustPrice(450_500, 1, 1000)).toBe(455_000);
  });

  it('rounds an exact half upwards', () => {
    // ৳12.50 at a ৳1 step → ৳13.
    expect(adjustPrice(1000, 25, 100)).toBe(1300);
    expect(adjustPrice(1250, 0.0001, 100)).toBe(1300);
  });

  it('cuts prices too', () => {
    expect(adjustPrice(100_000, -15, 100)).toBe(85_000);
  });

  it('never rounds a paid item down to free', () => {
    expect(adjustPrice(300, -90, 500)).toBe(500);
  });

  it('leaves a free item free', () => {
    expect(adjustPrice(0, 50, 100)).toBe(0);
  });
});

describe('price entry schema', () => {
  const base = { productId: 'a'.repeat(24), uomCode: 'doz', priceMinor: 540_000 };

  it('needs exactly one of a tier or a dealer', () => {
    expect(createPriceEntrySchema.safeParse(base).success).toBe(false);
    expect(
      createPriceEntrySchema.safeParse({
        ...base,
        tierId: 'b'.repeat(24),
        partyId: 'c'.repeat(24),
      }).success,
    ).toBe(false);
    const ok = createPriceEntrySchema.safeParse({ ...base, tierId: 'b'.repeat(24) });
    expect(ok.success && ok.data.uomCode).toBe('DOZ');
  });

  it('refuses a window that ends before it starts, naming validTo', () => {
    const result = createPriceEntrySchema.safeParse({
      ...base,
      partyId: 'c'.repeat(24),
      validFrom: '2026-05-01',
      validTo: '2026-04-30',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['validTo']);
  });

  it('refuses a 0% bulk adjustment', () => {
    const result = bulkAdjustSchema.safeParse({
      tierId: 'b'.repeat(24),
      pct: 0,
      roundToMinor: 100,
      dryRun: true,
    });
    expect(result.success).toBe(false);
  });
});
