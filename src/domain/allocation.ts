/**
 * Receipt allocation — §8 "Payment allocation", Day 28. Pure, so every rule is a unit test.
 *
 * Pure auto-FIFO is wrong for wholesale (dealers pay "this invoice, not that one — the other is
 * disputed"); pure manual allocation is a chore for the 90% of receipts that are simple. So the
 * server *proposes* oldest-due-first, the person taking the receipt may change it, and whatever is
 * sent is validated here before a poisha moves.
 */

import type { PaymentStatus } from '@shared/enums.js';

export interface OpenInvoice {
  id: string;
  docNo: string;
  invoiceDate: Date;
  /** Null for an invoice with no terms — due at once, so it orders by its date. */
  dueDate: Date | null;
  balanceMinor: number;
}

export interface Allocation {
  invoiceId: string;
  amountMinor: number;
}

export interface AllocationPlan {
  allocations: Allocation[];
  allocatedMinor: number;
  /** What is left over — an advance on the dealer's account. */
  unallocatedMinor: number;
}

/** Oldest due first; an invoice without a due date is due on its own date; ties by date, then number. */
export function fifoOrder(a: OpenInvoice, b: OpenInvoice): number {
  const due = (i: OpenInvoice) => (i.dueDate ?? i.invoiceDate).getTime();
  return (
    due(a) - due(b) ||
    a.invoiceDate.getTime() - b.invoiceDate.getTime() ||
    a.docNo.localeCompare(b.docNo)
  );
}

/**
 * The proposal: pay the oldest-due invoice in full, then the next, until the money runs out. A
 * receipt larger than everything open leaves the rest unallocated.
 */
export function proposeFifo(open: readonly OpenInvoice[], amountMinor: number): AllocationPlan {
  let left = amountMinor;
  const allocations: Allocation[] = [];
  for (const inv of [...open].sort(fifoOrder)) {
    if (left <= 0) break;
    if (inv.balanceMinor <= 0) continue;
    const take = Math.min(left, inv.balanceMinor);
    allocations.push({ invoiceId: inv.id, amountMinor: take });
    left -= take;
  }
  return { allocations, allocatedMinor: amountMinor - left, unallocatedMinor: left };
}

export interface AllocationProblem {
  /** `allocations.2.amountMinor`, or `allocations` for the total. */
  path: string;
  message: string;
}

/**
 * Check an allocation someone chose. Each line must name an open invoice of this party, once, for
 * no more than it still owes; together they may not exceed the receipt. Returns every problem, not
 * just the first, so the grid can mark them all.
 */
export function validateAllocations(
  open: readonly OpenInvoice[],
  allocations: readonly Allocation[],
  amountMinor: number,
): AllocationProblem[] {
  const byId = new Map(open.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const problems: AllocationProblem[] = [];
  let total = 0;

  allocations.forEach((a, i) => {
    const at = (f: string) => `allocations.${i}.${f}`;
    if (!Number.isInteger(a.amountMinor) || a.amountMinor < 1) {
      problems.push({ path: at('amountMinor'), message: 'A whole amount of at least 1' });
      return;
    }
    if (seen.has(a.invoiceId)) {
      problems.push({ path: at('invoiceId'), message: 'This invoice is already on the list' });
      return;
    }
    seen.add(a.invoiceId);
    const inv = byId.get(a.invoiceId);
    if (!inv) {
      problems.push({
        path: at('invoiceId'),
        message: 'Not an open invoice of this party — paid, cancelled, or someone else’s',
      });
      return;
    }
    if (a.amountMinor > inv.balanceMinor) {
      problems.push({
        path: at('amountMinor'),
        message: `${inv.docNo} only has ${inv.balanceMinor} left to pay`,
      });
    }
    total += a.amountMinor;
  });

  if (total > amountMinor) {
    problems.push({
      path: 'allocations',
      message: `Allocated ${total}, but the receipt is only ${amountMinor}`,
    });
  }
  return problems;
}

/** What an invoice's payment status is, from its total and what has been paid and credited. */
export function paymentStatusOf(
  grandTotalMinor: number,
  paidMinor: number,
  creditedMinor: number,
): PaymentStatus {
  const settled = paidMinor + creditedMinor;
  if (settled === 0) return grandTotalMinor === 0 ? 'PAID' : 'UNPAID';
  if (settled < grandTotalMinor) return 'PARTIAL';
  return settled === grandTotalMinor ? 'PAID' : 'OVERPAID';
}
