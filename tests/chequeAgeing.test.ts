import { describe, expect, it } from 'vitest';

import { ageInvoices, bucketOf, bucketTotals, daysOverdue } from '../src/domain/ageing.js';
import { bounceReverses, canMoveCheque, capToOpen } from '../src/domain/cheque.js';
import { CHEQUE_STATUSES } from '../src/shared/enums.js';

import type { AgeingInvoice, AllocationEvent } from '../src/domain/ageing.js';
import type { ChequeStatus } from '../src/shared/enums.js';

/** Day 30's pure rules: the cheque lifecycle, applying a stale split on clearing, and ageing. */

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('the cheque lifecycle', () => {
  const LEGAL: [ChequeStatus, ChequeStatus][] = [
    ['PENDING', 'DEPOSITED'],
    ['PENDING', 'CLEARED'],
    ['PENDING', 'BOUNCED'],
    ['DEPOSITED', 'CLEARED'],
    ['DEPOSITED', 'BOUNCED'],
    ['CLEARED', 'BOUNCED'],
  ];

  it.each(CHEQUE_STATUSES.flatMap((f) => CHEQUE_STATUSES.map((t) => [f, t] as const)))(
    '%s → %s',
    (from, to) => {
      const legal = LEGAL.some(([f, t]) => f === from && t === to);
      expect(canMoveCheque(from, to)).toBe(legal);
    },
  );

  it('only a cleared cheque has postings for a bounce to reverse', () => {
    expect(bounceReverses('CLEARED')).toBe(true);
    expect(bounceReverses('PENDING')).toBe(false);
    expect(bounceReverses('DEPOSITED')).toBe(false);
  });
});

describe('capToOpen — applying the intended split when the cheque finally clears', () => {
  const open = new Map([
    ['A', 30_000],
    ['B', 5_000], // part-paid by something else since the cheque was taken
  ]);

  it('applies what still fits; the rest becomes an advance', () => {
    expect(
      capToOpen(
        [
          { invoiceId: 'A', amountMinor: 20_000 },
          { invoiceId: 'B', amountMinor: 20_000 },
          { invoiceId: 'C', amountMinor: 10_000 }, // paid off meanwhile — no longer open
        ],
        open,
      ),
    ).toEqual([
      { invoiceId: 'A', amountMinor: 20_000 },
      { invoiceId: 'B', amountMinor: 5_000 },
    ]);
  });

  it('never over-applies, even with the same invoice twice', () => {
    expect(
      capToOpen(
        [
          { invoiceId: 'B', amountMinor: 3_000 },
          { invoiceId: 'B', amountMinor: 3_000 },
        ],
        open,
      ),
    ).toEqual([
      { invoiceId: 'B', amountMinor: 3_000 },
      { invoiceId: 'B', amountMinor: 2_000 },
    ]);
  });
});

describe('ageing buckets', () => {
  it.each([
    [-5, 'CURRENT'],
    [0, 'CURRENT'],
    [1, '1-30'],
    [30, '1-30'],
    [31, '31-60'],
    [60, '31-60'],
    [61, '61-90'],
    [90, '61-90'],
    [91, '90+'],
    [400, '90+'],
  ] as const)('%i days past due → %s', (days, bucket) => {
    expect(bucketOf(days)).toBe(bucket);
  });

  it('counts calendar days', () => {
    expect(daysOverdue(d('2026-10-10'), d('2026-09-10'))).toBe(30);
    expect(daysOverdue(d('2026-10-10'), d('2026-10-10'))).toBe(0);
  });
});

describe('ageInvoices — as of a date, from the invoices and their allocation history', () => {
  const inv = (
    id: string,
    day: string,
    due: string | null,
    total: number,
    credited = 0,
  ): AgeingInvoice => ({
    id,
    partyId: 'P',
    docNo: id,
    invoiceDay: d(day),
    dueDay: due ? d(due) : null,
    grandTotalMinor: total,
    creditedMinor: credited,
  });
  const invoices = [
    inv('OLD', '2026-05-01', '2026-06-01', 100_000), // due 1 Jun
    inv('MID', '2026-08-01', '2026-08-31', 50_000), // due 31 Aug
    inv('NEW', '2026-10-05', '2026-11-04', 20_000), // not due yet
    inv('RET', '2026-09-01', '2026-10-01', 10_000, 4_000), // part returned
  ];
  const allocations: AllocationEvent[] = [
    // OLD part-paid on 15 Sep.
    { invoiceId: 'OLD', amountMinor: 30_000, allocatedDay: d('2026-09-15'), reversedDay: null },
    // MID paid in full by a cheque that cleared 20 Sep and bounced 2 Oct.
    {
      invoiceId: 'MID',
      amountMinor: 50_000,
      allocatedDay: d('2026-09-20'),
      reversedDay: d('2026-10-02'),
    },
  ];

  it('today: each open invoice at its balance, in the right bucket', () => {
    const aged = ageInvoices(invoices, allocations, d('2026-10-10'));
    expect(aged.map((a) => [a.id, a.balanceMinor, a.daysOverdue, a.bucket])).toEqual([
      ['OLD', 70_000, 131, '90+'],
      ['MID', 50_000, 40, '31-60'], // the bounce put it back
      ['NEW', 20_000, -25, 'CURRENT'],
      ['RET', 6_000, 9, '1-30'],
    ]);
    // The buckets tie to the sum of open balances, to the poisha.
    const t = bucketTotals(aged);
    expect(Object.values(t).reduce((s, n) => s + n, 0)).toBe(146_000);
    expect(t).toEqual({
      CURRENT: 20_000,
      '1-30': 6_000,
      '31-60': 50_000,
      '61-90': 0,
      '90+': 70_000,
    });
  });

  it('as of 30 Sep: the cheque had cleared, NEW did not exist, OLD was 121 days late', () => {
    const aged = ageInvoices(invoices, allocations, d('2026-09-30'));
    expect(aged.map((a) => [a.id, a.balanceMinor, a.bucket])).toEqual([
      ['OLD', 70_000, '90+'],
      ['RET', 6_000, 'CURRENT'],
    ]);
  });

  it('as of 31 Aug: before any payment — OLD whole, MID due that very day', () => {
    const aged = ageInvoices(invoices, allocations, d('2026-08-31'));
    expect(aged.map((a) => [a.id, a.balanceMinor, a.daysOverdue, a.bucket])).toEqual([
      ['OLD', 100_000, 91, '90+'],
      ['MID', 50_000, 0, 'CURRENT'],
    ]);
  });
});
