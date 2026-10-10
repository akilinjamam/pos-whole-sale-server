/**
 * Receivables ageing — §8 "Ageing", Day 30. Pure, so every bucket edge is a unit test.
 *
 * Computed from open **invoices**, not ledger entries: an ageing line must point at a document the
 * dealer can be shown. An invoice without a due date is due on its own date.
 *
 *   CURRENT  not yet due (0 or fewer days past)
 *   1-30 · 31-60 · 61-90 · 90+   days past the due date, on the as-of day
 *
 * **As of a date**, not just today: month-end ageing must be re-runnable later and give the same
 * answer. So an invoice's balance is worked out *as it stood then* — its total, less what had been
 * allocated to it by then and not reversed by then. Payments since, and invoices raised since, do
 * not change last month's ageing.
 */

import { AGEING_BUCKETS } from '@shared/enums.js';

import type { AgeingBucket } from '@shared/enums.js';

const DAY = 86_400_000;

/** Whole days from the due day to the as-of day, both as calendar days (UTC midnight). */
export function daysOverdue(asOfDay: Date, dueDay: Date): number {
  return Math.round((asOfDay.getTime() - dueDay.getTime()) / DAY);
}

export function bucketOf(days: number): AgeingBucket {
  if (days <= 0) return 'CURRENT';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export interface AgeingInvoice {
  id: string;
  partyId: string;
  docNo: string;
  /** Calendar days (UTC midnight) in the org's zone. */
  invoiceDay: Date;
  dueDay: Date | null;
  grandTotalMinor: number;
  /** Credited by returns. Day 36's credit notes will carry their own dates. */
  creditedMinor: number;
}

export interface AllocationEvent {
  invoiceId: string;
  amountMinor: number;
  /** The calendar day it was allocated, and — for a bounced cheque — reversed. */
  allocatedDay: Date;
  reversedDay: Date | null;
}

export interface AgedInvoice {
  id: string;
  partyId: string;
  docNo: string;
  balanceMinor: number;
  daysOverdue: number;
  bucket: AgeingBucket;
}

export type BucketTotals = Record<AgeingBucket, number>;

export const emptyBuckets = (): BucketTotals =>
  Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as BucketTotals;

/**
 * Each invoice's balance as of `asOfDay`, aged. Invoices raised after the day, and those with
 * nothing owing on it, are left out.
 */
export function ageInvoices(
  invoices: readonly AgeingInvoice[],
  allocations: readonly AllocationEvent[],
  asOfDay: Date,
): AgedInvoice[] {
  const paid = new Map<string, number>();
  for (const a of allocations) {
    const counted = a.allocatedDay <= asOfDay && (!a.reversedDay || a.reversedDay > asOfDay);
    if (counted) paid.set(a.invoiceId, (paid.get(a.invoiceId) ?? 0) + a.amountMinor);
  }
  const out: AgedInvoice[] = [];
  for (const inv of invoices) {
    if (inv.invoiceDay > asOfDay) continue;
    const balanceMinor = inv.grandTotalMinor - inv.creditedMinor - (paid.get(inv.id) ?? 0);
    if (balanceMinor <= 0) continue;
    const days = daysOverdue(asOfDay, inv.dueDay ?? inv.invoiceDay);
    out.push({
      id: inv.id,
      partyId: inv.partyId,
      docNo: inv.docNo,
      balanceMinor,
      daysOverdue: days,
      bucket: bucketOf(days),
    });
  }
  return out;
}

/** Sum aged invoices into buckets — overall, or for one party. */
export function bucketTotals(aged: readonly AgedInvoice[]): BucketTotals {
  const t = emptyBuckets();
  for (const a of aged) t[a.bucket] += a.balanceMinor;
  return t;
}
