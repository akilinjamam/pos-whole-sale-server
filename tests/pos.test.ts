import { describe, expect, it } from 'vitest';

import { checkCredit } from '../src/domain/creditCheck.js';
import { returnValueMinor } from '../src/domain/returns.js';
import { applyTenders, TenderError } from '../src/domain/tenders.js';

/** The counter's money arithmetic: change, split tenders, and the credit check. */

describe('applyTenders', () => {
  it('gives change from cash only', () => {
    const r = applyTenders([{ method: 'CASH', amountMinor: 100_000 }], 64_000);
    expect(r).toEqual({ applied: [64_000], paidMinor: 64_000, changeMinor: 36_000 });
  });

  it('applies card exactly and lets cash cover the rest', () => {
    const r = applyTenders(
      [
        { method: 'CARD', amountMinor: 50_000 },
        { method: 'CASH', amountMinor: 20_000 },
      ],
      64_000,
    );
    expect(r).toEqual({ applied: [50_000, 14_000], paidMinor: 64_000, changeMinor: 6_000 });
  });

  it('refuses a card payment larger than the bill — nobody gives change on a card', () => {
    expect(() => applyTenders([{ method: 'CARD', amountMinor: 70_000 }], 64_000)).toThrow(
      TenderError,
    );
  });

  it('reports an under-payment as unpaid, with no change', () => {
    const r = applyTenders([{ method: 'MFS', amountMinor: 30_000 }], 64_000);
    expect(r).toEqual({ applied: [30_000], paidMinor: 30_000, changeMinor: 0 });
  });

  it('marks cash that the other tenders made unnecessary as applying zero', () => {
    const r = applyTenders(
      [
        { method: 'CARD', amountMinor: 64_000 },
        { method: 'CASH', amountMinor: 1_000 },
      ],
      64_000,
    );
    expect(r.applied).toEqual([64_000, 0]);
    expect(r.changeMinor).toBe(1_000);
  });
});

describe('checkCredit', () => {
  const dealer = {
    creditHold: false,
    creditHoldReason: null,
    creditLimitMinor: 5_000_000,
    currentBalanceMinor: 4_000_000,
  };

  it('allows credit within the limit', () => {
    expect(checkCredit(dealer, 900_000, true)).toEqual({
      ok: true,
      exposureAfterMinor: 4_900_000,
    });
  });

  it('refuses credit that would cross the limit', () => {
    expect(checkCredit(dealer, 1_100_000, true)).toMatchObject({
      ok: false,
      reason: 'OVER_LIMIT',
      exposureAfterMinor: 5_100_000,
    });
  });

  it('allows exactly reaching the limit', () => {
    expect(checkCredit(dealer, 1_000_000, true).ok).toBe(true);
  });

  it('refuses any credit to a dealer on hold, even with the limit not enforced', () => {
    expect(
      checkCredit(
        { ...dealer, creditHold: true, creditHoldReason: 'Cheque bounced' },
        1,
        false,
      ),
    ).toMatchObject({
      ok: false,
      reason: 'ON_HOLD',
      message: 'On credit hold: Cheque bounced',
    });
  });

  it('treats a zero limit as cash only', () => {
    expect(
      checkCredit({ ...dealer, creditLimitMinor: 0, currentBalanceMinor: 0 }, 100, true),
    ).toMatchObject({ reason: 'CASH_ONLY' });
  });

  it('lets a limit be exceeded when the org does not enforce limits', () => {
    expect(checkCredit(dealer, 9_000_000, false).ok).toBe(true);
  });

  it('asks nothing when no credit is being extended', () => {
    expect(checkCredit({ ...dealer, creditHold: true }, 0, true).ok).toBe(true);
  });
});

describe('returnValueMinor', () => {
  // A line of 3 at a net ৳100.00 — thirds do not divide into poisha evenly.
  const line = { lineTotalMinor: 10_000, qtyBase: 3, qtyReturnedBase: 0 };

  it('returns a whole line for exactly its net total', () => {
    expect(returnValueMinor(line, 3)).toBe(10_000);
  });

  it('adds up to the line total however it is returned piece by piece', () => {
    const one = returnValueMinor(line, 1);
    const two = returnValueMinor({ ...line, qtyReturnedBase: 1 }, 1);
    const three = returnValueMinor({ ...line, qtyReturnedBase: 2 }, 1);
    expect([one, two, three]).toEqual([3_333, 3_334, 3_333]);
    expect(one + two + three).toBe(10_000);
  });

  it('refuses returning more than was sold', () => {
    expect(() => returnValueMinor({ ...line, qtyReturnedBase: 2 }, 2)).toThrow(RangeError);
  });
});
