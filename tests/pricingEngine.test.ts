import { describe, expect, it } from 'vitest';

import { computeTotals, PricingError, resolvePrice } from '../src/domain/pricing.js';

import type { EntryLike, ResolveInput } from '../src/domain/pricing.js';

/**
 * The pricing engine, branch by branch.
 *
 * Fixture: a frame sold per PCS, in DOZ ×12 and CTN ×144; a dealer on tier DEALER_A with a 5%
 * trade discount; RETAIL as the counter's tier. Entries are added per test, so each test shows
 * exactly which rows produced its price.
 */

const DATE = '2026-06-15';
const DEALER = 'party-rahman';
const TIER_A = 'tier-dealer-a';
const RETAIL = 'tier-retail';
const VARIANT = 'variant-black-52';

let seq = 0;
function entry(over: Partial<EntryLike>): EntryLike {
  seq += 1;
  return {
    id: `e${seq}`,
    tierId: null,
    partyId: null,
    variantId: null,
    uomCode: 'DOZ',
    priceMinor: 0,
    minQty: 1,
    validFrom: null,
    validTo: null,
    isActive: true,
    ...over,
  };
}

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    productId: 'p1',
    product: {
      baseUom: 'PCS',
      packs: [
        { code: 'DOZ', name: 'Dozen', factor: 12 },
        { code: 'CTN', name: 'Carton', factor: 144 },
      ],
      defaultSellPriceMinor: 6_000, // ৳60 per piece
    },
    variant: null,
    dealer: { partyId: DEALER, tierId: TIER_A, discountPct: 5 },
    retailTierId: RETAIL,
    uomCode: 'DOZ',
    qty: 3,
    date: DATE,
    entries: [],
    ...over,
  };
}

const outcomes = (r: ReturnType<typeof resolvePrice>) =>
  r.trace.map((t) => `${t.step}:${t.outcome}`);

// ─── The four steps ─────────────────────────────────────────────────────────────────────

describe('resolution order', () => {
  it('1 — the dealer’s own price wins, and the trade discount is NOT applied to it', () => {
    const r = resolvePrice(
      input({
        entries: [
          entry({ partyId: DEALER, priceMinor: 50_000 }),
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
          entry({ tierId: RETAIL, priceMinor: 70_000 }),
        ],
      }),
    );
    expect(r.source).toBe('DEALER');
    expect(r.unitPriceMinor).toBe(50_000);
    expect(r.discountPct).toBe(0);
    expect(r.lineTotalMinor).toBe(150_000);
    expect(outcomes(r)).toEqual([
      'DEALER:MATCHED',
      'TIER:NOT_REACHED',
      'RETAIL:NOT_REACHED',
      'PRODUCT_DEFAULT:NOT_REACHED',
    ]);
  });

  it('2 — with no dealer price, the tier price applies, less the trade discount', () => {
    const r = resolvePrice(
      input({
        entries: [
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
          entry({ tierId: RETAIL, priceMinor: 70_000 }),
        ],
      }),
    );
    expect(r.source).toBe('TIER');
    expect(r.listUnitPriceMinor).toBe(54_000);
    expect(r.discountPct).toBe(5);
    expect(r.unitPriceMinor).toBe(51_300);
    expect(outcomes(r).slice(0, 2)).toEqual(['DEALER:NO_ENTRY', 'TIER:MATCHED']);
  });

  it('3 — with neither, the retail tier applies (discount still applies for a dealer)', () => {
    const r = resolvePrice(input({ entries: [entry({ tierId: RETAIL, priceMinor: 70_000 })] }));
    expect(r.source).toBe('RETAIL');
    expect(r.unitPriceMinor).toBe(66_500);
    expect(outcomes(r)).toEqual([
      'DEALER:NO_ENTRY',
      'TIER:NO_ENTRY',
      'RETAIL:MATCHED',
      'PRODUCT_DEFAULT:NOT_REACHED',
    ]);
  });

  it('4 — with no entries at all, the product default × pack factor, less discount', () => {
    const r = resolvePrice(input());
    expect(r.source).toBe('PRODUCT_DEFAULT');
    expect(r.listUnitPriceMinor).toBe(72_000); // ৳60 × 12
    expect(r.unitPriceMinor).toBe(68_400);
    expect(r.entryId).toBeNull();
    expect(r.unpriced).toBe(false);
  });

  it('adds the variant delta to the product default (and only there)', () => {
    const r = resolvePrice(
      input({ variant: { id: VARIANT, priceDeltaMinor: 500 }, dealer: null }),
    );
    expect(r.listUnitPriceMinor).toBe((6_000 + 500) * 12);

    const listed = resolvePrice(
      input({
        variant: { id: VARIANT, priceDeltaMinor: 500 },
        dealer: null,
        entries: [entry({ tierId: RETAIL, priceMinor: 70_000 })],
      }),
    );
    expect(listed.unitPriceMinor).toBe(70_000);
  });

  it('floors a default pushed negative by a large negative delta at zero, and flags it unpriced', () => {
    const r = resolvePrice(
      input({ variant: { id: VARIANT, priceDeltaMinor: -9_000 }, dealer: null }),
    );
    expect(r.unitPriceMinor).toBe(0);
    expect(r.unpriced).toBe(true);
  });
});

describe('steps that do not apply', () => {
  it('a counter sale (no dealer) skips steps 1 and 2 and gets no discount', () => {
    const r = resolvePrice(
      input({ dealer: null, entries: [entry({ tierId: RETAIL, priceMinor: 70_000 })] }),
    );
    expect(outcomes(r).slice(0, 3)).toEqual([
      'DEALER:NOT_APPLICABLE',
      'TIER:NOT_APPLICABLE',
      'RETAIL:MATCHED',
    ]);
    expect(r.unitPriceMinor).toBe(70_000);
    expect(r.partyId).toBeNull();
  });

  it('a dealer with no tier skips step 2', () => {
    const r = resolvePrice(
      input({
        dealer: { partyId: DEALER, tierId: null, discountPct: 0 },
        entries: [
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
          entry({ tierId: RETAIL, priceMinor: 70_000 }),
        ],
      }),
    );
    expect(outcomes(r)[1]).toBe('TIER:NOT_APPLICABLE');
    expect(r.source).toBe('RETAIL');
  });

  it('skips step 3 when the dealer’s tier IS the retail tier', () => {
    const r = resolvePrice(
      input({ dealer: { partyId: DEALER, tierId: RETAIL, discountPct: 0 } }),
    );
    expect(outcomes(r)[2]).toBe('RETAIL:NOT_APPLICABLE');
    expect(r.trace[2]!.note).toMatch(/same as/i);
    expect(r.source).toBe('PRODUCT_DEFAULT');
  });

  it('skips step 3 when no default retail tier is configured', () => {
    const r = resolvePrice(input({ dealer: null, retailTierId: null }));
    expect(outcomes(r)[2]).toBe('RETAIL:NOT_APPLICABLE');
    expect(r.source).toBe('PRODUCT_DEFAULT');
  });

  it('ignores entries from scopes that are not in play', () => {
    const r = resolvePrice(
      input({
        entries: [
          entry({ partyId: 'someone-else', priceMinor: 1 }),
          entry({ tierId: 'tier-distributor', priceMinor: 2 }),
        ],
      }),
    );
    expect(r.source).toBe('PRODUCT_DEFAULT');
  });
});

// ─── Qty breaks ─────────────────────────────────────────────────────────────────────────

describe('qty breaks', () => {
  const breaks = [
    entry({ tierId: TIER_A, minQty: 1, priceMinor: 54_000 }),
    entry({ tierId: TIER_A, minQty: 5, priceMinor: 51_000 }),
    entry({ tierId: TIER_A, minQty: 10, priceMinor: 48_000 }),
  ];
  const noDiscount = { partyId: DEALER, tierId: TIER_A, discountPct: 0 };

  it.each([
    [1, 54_000],
    [4, 54_000],
    [5, 51_000],
    [9, 51_000],
    [10, 48_000],
    [250, 48_000],
  ])('qty %i → the highest break not above it (%i)', (qty, price) => {
    expect(
      resolvePrice(input({ qty, dealer: noDiscount, entries: breaks })).unitPriceMinor,
    ).toBe(price);
  });

  it('reports the next break, discounted like the price itself', () => {
    const r = resolvePrice(input({ qty: 3, entries: breaks }));
    expect(r.nextBreak).toEqual({ minQty: 5, uomCode: 'DOZ', unitPriceMinor: 51_000 - 2_550 });
    expect(resolvePrice(input({ qty: 12, entries: breaks })).nextBreak).toBeNull();
  });

  it('falls through to the next step when every break needs more than was asked', () => {
    const r = resolvePrice(
      input({
        qty: 2,
        dealer: noDiscount,
        entries: [
          entry({ partyId: DEALER, minQty: 5, priceMinor: 45_000 }),
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
        ],
      }),
    );
    expect(outcomes(r).slice(0, 2)).toEqual(['DEALER:BELOW_MIN_QTY', 'TIER:MATCHED']);
    expect(r.trace[0]!.note).toMatch(/starts at 5 DOZ/);
    expect(r.unitPriceMinor).toBe(54_000);
  });
});

// ─── Variants and units ─────────────────────────────────────────────────────────────────

describe('specificity within a list', () => {
  const noDiscount = { partyId: DEALER, tierId: TIER_A, discountPct: 0 };

  it('a variant-specific price beats the all-variants price', () => {
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        variant: { id: VARIANT, priceDeltaMinor: 0 },
        entries: [
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
          entry({ tierId: TIER_A, variantId: VARIANT, priceMinor: 58_000 }),
        ],
      }),
    );
    expect(r.unitPriceMinor).toBe(58_000);
    expect(r.trace[1]!.note).toMatch(/this variant/);
  });

  it("ignores another variant's price and uses the all-variants one", () => {
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        variant: { id: VARIANT, priceDeltaMinor: 0 },
        entries: [
          entry({ tierId: TIER_A, variantId: 'other-variant', priceMinor: 1 }),
          entry({ tierId: TIER_A, priceMinor: 54_000 }),
        ],
      }),
    );
    expect(r.unitPriceMinor).toBe(54_000);
  });

  it('a variant price per base unit beats an all-variants price in the exact unit', () => {
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        variant: { id: VARIANT, priceDeltaMinor: 0 },
        entries: [
          entry({ tierId: TIER_A, uomCode: 'DOZ', priceMinor: 54_000 }),
          entry({ tierId: TIER_A, variantId: VARIANT, uomCode: 'PCS', priceMinor: 4_900 }),
        ],
      }),
    );
    expect(r.unitPriceMinor).toBe(4_900 * 12);
    expect(r.convertedFromBase).toBe(true);
  });

  it('an exact-unit price beats a scaled base-unit price', () => {
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        entries: [
          entry({ tierId: TIER_A, uomCode: 'PCS', priceMinor: 4_000 }),
          entry({ tierId: TIER_A, uomCode: 'DOZ', priceMinor: 54_000 }),
        ],
      }),
    );
    expect(r.unitPriceMinor).toBe(54_000);
    expect(r.convertedFromBase).toBe(false);
  });

  it('scales a per-piece price to a carton, and compares its break in pieces', () => {
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        uomCode: 'CTN',
        qty: 1,
        entries: [
          entry({ tierId: TIER_A, uomCode: 'PCS', minQty: 1, priceMinor: 4_500 }),
          // 144 pieces is exactly one carton — the break is met.
          entry({ tierId: TIER_A, uomCode: 'PCS', minQty: 144, priceMinor: 4_200 }),
        ],
      }),
    );
    expect(r.unitPriceMinor).toBe(4_200 * 144);
    expect(r.qtyBase).toBe(144);
    expect(r.entryUomCode).toBe('PCS');
  });

  it('never converts a pack price down to a smaller unit', () => {
    // A DOZ price says nothing reliable about a single piece — the piece price falls through.
    const r = resolvePrice(
      input({
        dealer: noDiscount,
        uomCode: 'PCS',
        qty: 6,
        entries: [entry({ tierId: TIER_A, uomCode: 'DOZ', priceMinor: 54_000 })],
      }),
    );
    expect(r.source).toBe('PRODUCT_DEFAULT');
    expect(r.unitPriceMinor).toBe(6_000);
  });
});

// ─── Status and windows ─────────────────────────────────────────────────────────────────

describe('only prices in force count', () => {
  const noDiscount = { partyId: DEALER, tierId: TIER_A, discountPct: 0 };
  const run = (e: Partial<EntryLike>) =>
    resolvePrice(
      input({
        dealer: noDiscount,
        entries: [entry({ tierId: TIER_A, priceMinor: 54_000, ...e })],
      }),
    ).source;

  it('ignores an inactive entry', () =>
    expect(run({ isActive: false })).toBe('PRODUCT_DEFAULT'));
  it('ignores an entry that has ended', () =>
    expect(run({ validTo: '2026-06-14' })).toBe('PRODUCT_DEFAULT'));
  it('ignores an entry not yet started', () =>
    expect(run({ validFrom: '2026-06-16' })).toBe('PRODUCT_DEFAULT'));
  it('counts the first and last day of a window', () => {
    expect(run({ validFrom: DATE })).toBe('TIER');
    expect(run({ validTo: DATE })).toBe('TIER');
  });

  it('picks the price for the requested date when two windows follow each other', () => {
    const entries = [
      entry({ tierId: TIER_A, priceMinor: 54_000, validTo: '2026-06-30' }),
      entry({ tierId: TIER_A, priceMinor: 57_000, validFrom: '2026-07-01' }),
    ];
    expect(resolvePrice(input({ dealer: noDiscount, entries })).unitPriceMinor).toBe(54_000);
    expect(
      resolvePrice(input({ dealer: noDiscount, entries, date: '2026-07-01' })).unitPriceMinor,
    ).toBe(57_000);
  });
});

describe('invalid requests', () => {
  it('refuses a unit the product does not declare, naming uomCode', () => {
    expect(() => resolvePrice(input({ uomCode: 'BOX' }))).toThrowError(PricingError);
    try {
      resolvePrice(input({ uomCode: 'BOX' }));
    } catch (e) {
      expect((e as PricingError).field).toBe('uomCode');
    }
  });

  it.each([0, -1, 1.5])('refuses qty %s', (qty) => {
    expect(() => resolvePrice(input({ qty }))).toThrowError(/whole quantity/i);
  });
});

describe('trade discount rounding', () => {
  it('rounds the discount once per unit, half up, so the line needs no rounding', () => {
    // ৳333.33 less 7.5% = ৳333.33 − ৳25.00 (24.99975 → 25.00) = ৳308.33
    const r = resolvePrice(
      input({
        qty: 7,
        dealer: { partyId: DEALER, tierId: TIER_A, discountPct: 7.5 },
        entries: [entry({ tierId: TIER_A, priceMinor: 33_333 })],
      }),
    );
    expect(r.unitPriceMinor).toBe(30_833);
    expect(r.lineTotalMinor).toBe(30_833 * 7);
  });
});

// ─── Totals ─────────────────────────────────────────────────────────────────────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('computeTotals', () => {
  it('with no discount, total is the sum of the lines', () => {
    const t = computeTotals(
      [
        { unitPriceMinor: 54_000, qty: 3 },
        { unitPriceMinor: 12_345, qty: 2 },
      ],
      { kind: 'NONE' },
    );
    expect(t.totalMinor).toBe(162_000 + 24_690);
    expect(t.lines.map((l) => l.orderDiscountMinor)).toEqual([0, 0]);
  });

  it('prorates an awkward amount across four awkward lines, to the poisha', () => {
    // Line amounts ৳59.97, ৳319.69, ৳0.13, ৳987.65 and a ৳100.01 discount: no share is a whole
    // number, so naive per-line rounding would drift.
    const lines = [
      { unitPriceMinor: 1_999, qty: 3 },
      { unitPriceMinor: 4_567, qty: 7 },
      { unitPriceMinor: 1, qty: 13 },
      { unitPriceMinor: 98_765, qty: 1 },
    ];
    const t = computeTotals(lines, { kind: 'AMOUNT', amountMinor: 10_001 });

    expect(sum(t.lines.map((l) => l.orderDiscountMinor))).toBe(10_001);
    expect(sum(t.lines.map((l) => l.netMinor))).toBe(t.totalMinor);
    expect(t.totalMinor).toBe(t.subtotalMinor - 10_001);
    // Proportionate: the largest line carries the largest share.
    expect(t.lines[3]!.orderDiscountMinor).toBeGreaterThan(t.lines[1]!.orderDiscountMinor);
  });

  it('splits ৳1.00 three ways without losing the odd poisha', () => {
    const t = computeTotals(
      [
        { unitPriceMinor: 1_000, qty: 1 },
        { unitPriceMinor: 1_000, qty: 1 },
        { unitPriceMinor: 1_000, qty: 1 },
      ],
      { kind: 'AMOUNT', amountMinor: 100 },
    );
    expect(t.lines.map((l) => l.orderDiscountMinor).sort()).toEqual([33, 33, 34]);
    expect(sum(t.lines.map((l) => l.netMinor))).toBe(2_900);
  });

  it('rounds a percentage discount once, on the subtotal', () => {
    const t = computeTotals(
      [
        { unitPriceMinor: 33_333, qty: 1 },
        { unitPriceMinor: 33_333, qty: 1 },
        { unitPriceMinor: 33_334, qty: 1 },
      ],
      { kind: 'PCT', pct: 2.5 },
    );
    expect(t.orderDiscountMinor).toBe(2_500);
    expect(sum(t.lines.map((l) => l.orderDiscountMinor))).toBe(2_500);
  });

  it('prorates by net-after-line-discount, not by gross', () => {
    const t = computeTotals(
      [
        { unitPriceMinor: 10_000, qty: 1, lineDiscountMinor: 10_000 },
        { unitPriceMinor: 10_000, qty: 1 },
      ],
      { kind: 'AMOUNT', amountMinor: 500 },
    );
    // The fully discounted line has nothing left to discount.
    expect(t.lines.map((l) => l.orderDiscountMinor)).toEqual([0, 500]);
    expect(t.subtotalMinor).toBe(10_000);
  });

  it('refuses discounts larger than what they discount', () => {
    expect(() =>
      computeTotals([{ unitPriceMinor: 100, qty: 1 }], { kind: 'AMOUNT', amountMinor: 101 }),
    ).toThrow(/exceed/);
    expect(() =>
      computeTotals([{ unitPriceMinor: 100, qty: 1, lineDiscountMinor: 101 }], {
        kind: 'NONE',
      }),
    ).toThrow(PricingError);
    expect(() =>
      computeTotals([{ unitPriceMinor: 100, qty: 1 }], { kind: 'PCT', pct: 101 }),
    ).toThrow(PricingError);
  });

  it('refuses a fractional quantity or price', () => {
    expect(() => computeTotals([{ unitPriceMinor: 100, qty: 1.5 }], { kind: 'NONE' })).toThrow(
      PricingError,
    );
    expect(() => computeTotals([{ unitPriceMinor: 10.5, qty: 1 }], { kind: 'NONE' })).toThrow(
      PricingError,
    );
  });

  it('handles an empty order', () => {
    expect(computeTotals([], { kind: 'NONE' }).totalMinor).toBe(0);
  });

  it('holds sum(lines) === total and no negative line for 2,000 random orders', () => {
    // A seeded generator, so a failure is reproducible rather than a flake.
    let s = 20260926;
    const rand = (n: number) => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return s % n;
    };

    for (let run = 0; run < 2_000; run += 1) {
      const lines = Array.from({ length: 3 + rand(8) }, () => {
        const unitPriceMinor = 1 + rand(250_000);
        const qty = 1 + rand(40);
        return {
          unitPriceMinor,
          qty,
          lineDiscountMinor: rand(3) === 0 ? rand(unitPriceMinor * qty) : 0,
        };
      });
      const subtotal = sum(lines.map((l) => l.unitPriceMinor * l.qty - l.lineDiscountMinor));
      const discount =
        rand(2) === 0
          ? ({ kind: 'AMOUNT', amountMinor: rand(subtotal + 1) } as const)
          : ({ kind: 'PCT', pct: rand(10_001) / 100 } as const);

      const t = computeTotals(lines, discount);
      expect(sum(t.lines.map((l) => l.orderDiscountMinor))).toBe(t.orderDiscountMinor);
      expect(sum(t.lines.map((l) => l.netMinor))).toBe(t.totalMinor);
      expect(t.lines.every((l) => l.netMinor >= 0 && Number.isInteger(l.netMinor))).toBe(true);
    }
  });
});
