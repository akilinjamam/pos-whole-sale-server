import { describe, expect, it } from 'vitest';

import {
  fifoOrder,
  paymentStatusOf,
  proposeFifo,
  validateAllocations,
} from '../src/domain/allocation.js';

import type { OpenInvoice } from '../src/domain/allocation.js';

/** Day 28: the FIFO proposal, the checks on a chosen allocation, and invoice payment status. */

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const inv = (
  id: string,
  invoiceDate: string,
  dueDate: string | null,
  balanceMinor: number,
): OpenInvoice => ({
  id,
  docNo: `WS-${id}`,
  invoiceDate: day(invoiceDate),
  dueDate: dueDate ? day(dueDate) : null,
  balanceMinor,
});

// Deliberately out of order: the oldest *due* is B, though A was raised first.
const open = [
  inv('A', '2026-08-01', '2026-10-01', 50_000),
  inv('B', '2026-08-10', '2026-09-10', 30_000),
  inv('C', '2026-09-01', '2026-10-15', 20_000),
];

describe('fifoOrder', () => {
  it('orders by due date, not by invoice date', () => {
    expect([...open].sort(fifoOrder).map((i) => i.id)).toEqual(['B', 'A', 'C']);
  });

  it('an invoice without terms is due on its own date; ties break by date then number', () => {
    const cash = inv('D', '2026-09-05', null, 1);
    const twin = inv('E', '2026-09-05', null, 1);
    // D and E have no terms: due 5 Sep, their own date — before B's 10 Sep.
    expect([cash, twin, ...open].sort(fifoOrder).map((i) => i.id)).toEqual([
      'D',
      'E',
      'B',
      'A',
      'C',
    ]);
  });
});

describe('proposeFifo', () => {
  it('a receipt larger than the oldest invoice splits across invoices, oldest due first', () => {
    expect(proposeFifo(open, 45_000)).toEqual({
      allocations: [
        { invoiceId: 'B', amountMinor: 30_000 },
        { invoiceId: 'A', amountMinor: 15_000 },
      ],
      allocatedMinor: 45_000,
      unallocatedMinor: 0,
    });
  });

  it('more than everything open: the rest is an advance', () => {
    expect(proposeFifo(open, 130_000)).toMatchObject({
      allocatedMinor: 100_000,
      unallocatedMinor: 30_000,
    });
  });

  it('nothing open: the whole receipt is an advance', () => {
    expect(proposeFifo([], 5_000)).toEqual({
      allocations: [],
      allocatedMinor: 0,
      unallocatedMinor: 5_000,
    });
  });

  it('allocated + unallocated always equals the receipt', () => {
    for (const amount of [1, 29_999, 30_000, 30_001, 99_999, 100_000, 250_000]) {
      const p = proposeFifo(open, amount);
      expect(p.allocatedMinor + p.unallocatedMinor).toBe(amount);
      expect(p.allocations.reduce((s, a) => s + a.amountMinor, 0)).toBe(p.allocatedMinor);
    }
  });
});

describe('validateAllocations', () => {
  it('accepts a chosen allocation within each invoice and within the receipt', () => {
    expect(
      validateAllocations(open, [{ invoiceId: 'C', amountMinor: 20_000 }], 25_000),
    ).toEqual([]);
  });

  it('refuses more than an invoice still owes', () => {
    expect(
      validateAllocations(open, [{ invoiceId: 'B', amountMinor: 30_001 }], 50_000),
    ).toEqual([
      { path: 'allocations.0.amountMinor', message: 'WS-B only has 30000 left to pay' },
    ]);
  });

  it('refuses allocating more than the receipt', () => {
    expect(
      validateAllocations(
        open,
        [
          { invoiceId: 'A', amountMinor: 40_000 },
          { invoiceId: 'B', amountMinor: 20_000 },
        ],
        50_000,
      ),
    ).toEqual([
      { path: 'allocations', message: 'Allocated 60000, but the receipt is only 50000' },
    ]);
  });

  it('refuses an invoice that is not open, a duplicate, and a zero line — all at once', () => {
    const problems = validateAllocations(
      open,
      [
        { invoiceId: 'Z', amountMinor: 1 },
        { invoiceId: 'A', amountMinor: 1 },
        { invoiceId: 'A', amountMinor: 1 },
        { invoiceId: 'C', amountMinor: 0 },
      ],
      100,
    );
    expect(problems.map((p) => p.path)).toEqual([
      'allocations.0.invoiceId',
      'allocations.2.invoiceId',
      'allocations.3.amountMinor',
    ]);
  });
});

describe('paymentStatusOf', () => {
  it.each([
    [10_000, 0, 0, 'UNPAID'],
    [10_000, 4_000, 0, 'PARTIAL'],
    [10_000, 4_000, 6_000, 'PAID'],
    [10_000, 10_000, 0, 'PAID'],
    [10_000, 10_001, 0, 'OVERPAID'],
    [0, 0, 0, 'PAID'],
  ] as const)('total %i, paid %i, credited %i → %s', (total, paid, credited, status) => {
    expect(paymentStatusOf(total, paid, credited)).toBe(status);
  });
});
