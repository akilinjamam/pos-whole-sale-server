import { describe, expect, it } from 'vitest';

import {
  invoicePortion,
  invoiceQuantity,
  InvoicingError,
} from '../src/domain/dispatchInvoicing.js';

/**
 * Day 24: a line shipped in several challans is invoiced in several parts, and the parts add up
 * to the order line exactly — never a poisha more or less.
 */

const line = (over: Partial<Parameters<typeof invoicePortion>[0]> = {}) => ({
  qtyBase: 120,
  qtyInvoicedBase: 0,
  lineTotalMinor: 100_001,
  discountMinor: 3_333,
  ...over,
});

/** Invoice a line in the given portions, as successive dispatches would. */
function invoiceInParts(l: ReturnType<typeof line>, parts: number[]) {
  let invoiced = 0;
  return parts.map((q) => {
    const p = invoicePortion({ ...l, qtyInvoicedBase: invoiced }, q);
    invoiced += q;
    return p;
  });
}

describe('invoicePortion', () => {
  it('a whole line in one go is the line, exactly', () => {
    expect(invoicePortion(line(), 120)).toEqual({
      grossMinor: 103_334,
      discountMinor: 3_333,
      netMinor: 100_001,
    });
  });

  it('three awkward thirds add up to the line exactly', () => {
    const parts = invoiceInParts(line({ qtyBase: 3 }), [1, 1, 1]);
    expect(parts.reduce((s, p) => s + p.netMinor, 0)).toBe(100_001);
    expect(parts.reduce((s, p) => s + p.discountMinor, 0)).toBe(3_333);
    // And each part is within a poisha of a true third.
    for (const p of parts) expect(Math.abs(p.netMinor - 100_001 / 3)).toBeLessThanOrEqual(1);
  });

  it('every portion is gross − discount, exactly', () => {
    for (const p of invoiceInParts(line(), [7, 13, 50, 1, 49])) {
      expect(p.netMinor).toBe(p.grossMinor - p.discountMinor);
    }
  });

  it('holds for 2,000 random lines split into random challans', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const qtyBase = 1 + rand(500);
      const discountMinor = rand(50_000);
      const l = line({ qtyBase, lineTotalMinor: rand(5_000_000), discountMinor });
      const parts: number[] = [];
      let left = qtyBase;
      while (left > 0) {
        const q = 1 + rand(left);
        parts.push(q);
        left -= q;
      }
      const out = invoiceInParts(l, parts);
      expect(out.reduce((s, p) => s + p.netMinor, 0)).toBe(l.lineTotalMinor);
      expect(out.reduce((s, p) => s + p.discountMinor, 0)).toBe(discountMinor);
      expect(out.every((p) => p.netMinor >= 0 && p.discountMinor >= 0)).toBe(true);
    }
  });

  it('a short-closed line is invoiced only for what shipped', () => {
    // 120 ordered, 80 shipped in two challans, the rest short-closed.
    const parts = invoiceInParts(line(), [40, 40]);
    const net = parts.reduce((s, p) => s + p.netMinor, 0);
    expect(net).toBe(Math.round((100_001 * 80) / 120));
  });

  it('does not overflow on a large line', () => {
    const p = invoicePortion(
      line({ qtyBase: 1_000_000, lineTotalMinor: 9_000_000_000_000, discountMinor: 0 }),
      999_999,
    );
    expect(p.netMinor).toBe(8_999_991_000_000);
  });

  it('refuses invoicing past the ordered quantity, or nothing', () => {
    expect(() => invoicePortion(line({ qtyInvoicedBase: 100 }), 21)).toThrow(InvoicingError);
    expect(() => invoicePortion(line(), 0)).toThrow(InvoicingError);
    expect(() => invoicePortion(line(), 1.5)).toThrow(InvoicingError);
  });
});

describe('invoiceQuantity', () => {
  const dozen = { uomCode: 'DOZ', factor: 12, unitPriceMinor: 72_000 };

  it('keeps the order unit when the quantity is whole packs', () => {
    expect(invoiceQuantity(24, dozen, 'PCS')).toEqual({
      uomCode: 'DOZ',
      uomQty: 2,
      unitPriceMinor: 72_000,
    });
  });

  it('falls back to pieces at the per-piece price otherwise', () => {
    expect(invoiceQuantity(18, dozen, 'PCS')).toEqual({
      uomCode: 'PCS',
      uomQty: 18,
      unitPriceMinor: 6_000,
    });
  });

  it('a base-unit order line is always itself', () => {
    expect(
      invoiceQuantity(7, { uomCode: 'PCS', factor: 1, unitPriceMinor: 500 }, 'PCS'),
    ).toEqual({
      uomCode: 'PCS',
      uomQty: 7,
      unitPriceMinor: 500,
    });
  });
});
