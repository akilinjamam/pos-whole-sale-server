/**
 * An order line's five counters, and the two rollups derived from them — §7 "Partial dispatch".
 *
 * Every line carries `qtyBase` (ordered) plus what has happened to it since: reserved, dispatched,
 * invoiced, cancelled (and returned, from Day 36). These never go backwards except by an explicit
 * document — a posted dispatch, a short close, a return — and the order's `fulfillmentStatus` and
 * `billingStatus` are *computed* from them, never set by hand. Pure, so every edge is a test.
 */

import type { BillingStatus, FulfillmentStatus } from '@shared/enums.js';

export interface OrderLineQty {
  qtyBase: number;
  qtyReservedBase: number;
  qtyDispatchedBase: number;
  qtyInvoicedBase: number;
  qtyCancelledBase: number;
}

/** What is still to ship on a line: ordered − dispatched − cancelled. A dispatch is validated against it. */
export function lineOutstanding(l: OrderLineQty): number {
  return l.qtyBase - l.qtyDispatchedBase - l.qtyCancelledBase;
}

/**
 * Why a line's counters are impossible, or null. The model has no cross-field validators on
 * `$inc` updates, so services call this on the re-read order before committing.
 */
export function lineInvariantViolation(l: OrderLineQty): string | null {
  const fields = [
    l.qtyBase,
    l.qtyReservedBase,
    l.qtyDispatchedBase,
    l.qtyInvoicedBase,
    l.qtyCancelledBase,
  ];
  if (fields.some((n) => !Number.isInteger(n) || n < 0))
    return 'Quantities must be whole and ≥ 0';
  if (l.qtyBase < 1) return 'Ordered quantity must be at least 1';
  const outstanding = lineOutstanding(l);
  if (outstanding < 0) return 'Dispatched plus cancelled exceeds the ordered quantity';
  if (l.qtyReservedBase > outstanding) return 'Reserved exceeds what is still to ship';
  if (l.qtyInvoicedBase > l.qtyDispatchedBase) return 'Invoiced exceeds what was dispatched';
  return null;
}

export interface OrderTotals {
  orderedBase: number;
  reservedBase: number;
  dispatchedBase: number;
  invoicedBase: number;
  cancelledBase: number;
  outstandingBase: number;
}

export function orderTotals(lines: readonly OrderLineQty[]): OrderTotals {
  const t: OrderTotals = {
    orderedBase: 0,
    reservedBase: 0,
    dispatchedBase: 0,
    invoicedBase: 0,
    cancelledBase: 0,
    outstandingBase: 0,
  };
  for (const l of lines) {
    t.orderedBase += l.qtyBase;
    t.reservedBase += l.qtyReservedBase;
    t.dispatchedBase += l.qtyDispatchedBase;
    t.invoicedBase += l.qtyInvoicedBase;
    t.cancelledBase += l.qtyCancelledBase;
    t.outstandingBase += lineOutstanding(l);
  }
  return t;
}

/**
 * NONE until something ships; COMPLETE when nothing is outstanding (a short-closed remainder
 * counts as settled); PARTIAL in between.
 */
export function fulfillmentStatusOf(lines: readonly OrderLineQty[]): FulfillmentStatus {
  const t = orderTotals(lines);
  if (t.dispatchedBase === 0) return 'NONE';
  return t.outstandingBase === 0 ? 'COMPLETE' : 'PARTIAL';
}

/**
 * Billed against what will ship — ordered minus cancelled. With invoice-per-dispatch every
 * dispatched unit is invoiced as it leaves, so an order is BILLED once it is fully dispatched.
 */
export function billingStatusOf(lines: readonly OrderLineQty[]): BillingStatus {
  const t = orderTotals(lines);
  if (t.invoicedBase === 0) return 'UNBILLED';
  return t.invoicedBase >= t.orderedBase - t.cancelledBase ? 'BILLED' : 'PARTIAL';
}
