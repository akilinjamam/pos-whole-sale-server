import { describe, expect, it } from 'vitest';

import { checkCredit, exposureOf, uninvoicedValue } from '../src/domain/creditCheck.js';
import { invoicePortion } from '../src/domain/dispatchInvoicing.js';

/** Day 31: exposure is open invoices + what confirmed orders will still invoice − advances. */

const line = (over: Partial<Parameters<typeof uninvoicedValue>[0]['lines'][number]> = {}) => ({
  qtyBase: 24,
  qtyInvoicedBase: 0,
  qtyCancelledBase: 0,
  lineTotalMinor: 144_000,
  discountMinor: 0,
  ...over,
});

describe('exposureOf', () => {
  it('adds open invoices and open orders, and takes off money on account', () => {
    expect(
      exposureOf({
        openInvoicesMinor: 500_000,
        openOrdersMinor: 144_000,
        unallocatedMinor: 50_000,
      }),
    ).toBe(594_000);
  });

  it('goes negative when the dealer has paid ahead — headroom beyond the limit', () => {
    const exposureMinor = exposureOf({
      openInvoicesMinor: 0,
      openOrdersMinor: 0,
      unallocatedMinor: 30_000,
    });
    expect(exposureMinor).toBe(-30_000);
    expect(
      checkCredit(
        { creditHold: false, creditHoldReason: null, creditLimitMinor: 100_000, exposureMinor },
        130_000,
        true,
      ).ok,
    ).toBe(true);
  });
});

describe('uninvoicedValue', () => {
  it('a fresh order adds its whole value, shipping included', () => {
    expect(uninvoicedValue({ lines: [line()], shippingMinor: 5_000 })).toBe(149_000);
  });

  it('after a partial challan: only what is left, and the shipping has gone on the first invoice', () => {
    expect(
      uninvoicedValue({ lines: [line({ qtyInvoicedBase: 12 })], shippingMinor: 5_000 }),
    ).toBe(72_000);
  });

  it('short-closed quantity will never be invoiced, so it is not exposure', () => {
    expect(
      uninvoicedValue({ lines: [line({ qtyInvoicedBase: 12, qtyCancelledBase: 12 })] }),
    ).toBe(0);
    expect(uninvoicedValue({ lines: [line({ qtyCancelledBase: 4 })] })).toBe(120_000);
  });

  it('is exactly what the remaining invoices will charge, to the poisha', () => {
    // ৳1,000.00 gross over 3 units with ৳0.01 off — shares that do not divide evenly.
    const l = line({ qtyBase: 3, lineTotalMinor: 99_999, discountMinor: 1 });
    const first = invoicePortion(l, 1).netMinor;
    const left = uninvoicedValue({ lines: [{ ...l, qtyInvoicedBase: 1 }] });
    expect([first, left]).toEqual([33_333, 66_666]);
    expect(first + left).toBe(l.lineTotalMinor);
  });
});
