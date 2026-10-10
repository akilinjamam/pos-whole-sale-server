/**
 * The credit check — pure, so every refusal reason is a unit test.
 *
 * Two questions, asked at counter credit sales (Day 18), order confirm (Day 22) and dispatch post
 * (Day 31): is the dealer on hold, and would this take their **exposure** past their limit?
 *
 * Exposure (§8, Day 31) is everything the dealer could owe us, not just what is invoiced:
 *
 *   exposure = Σ open invoice balances          what they owe on paper
 *            + Σ not-yet-invoiced order value   confirmed orders we are committed to ship
 *            − Σ advances on account            their money we already hold
 *
 * A dealer with ৳5 lakh of confirmed orders waiting in the warehouse is not "owing nothing" because
 * none of it has been invoiced yet; the balance alone would let them confirm another ৳5 lakh.
 */

import { invoicePortion } from './dispatchInvoicing.js';

export interface CreditPosition {
  creditHold: boolean;
  creditHoldReason: string | null;
  creditLimitMinor: number;
  /** Their exposure before this sale or order — see `exposureOf`. */
  exposureMinor: number;
}

export interface ExposureParts {
  /** Σ balanceMinor of their posted, open invoices (opening `OB-` ones included). */
  openInvoicesMinor: number;
  /** Σ not-yet-invoiced value of their confirmed, open orders. */
  openOrdersMinor: number;
  /** Σ unallocatedMinor of their receipts — money on account. A pending cheque is not money yet. */
  unallocatedMinor: number;
}

export const exposureOf = (p: ExposureParts) =>
  p.openInvoicesMinor + p.openOrdersMinor - p.unallocatedMinor;

export interface OrderLineValue {
  qtyBase: number;
  qtyInvoicedBase: number;
  qtyCancelledBase: number;
  lineTotalMinor: number;
  discountMinor: number;
}

/**
 * What an open order will still invoice: each line's total, less what earlier challans already
 * invoiced, less what was short-closed — plus the order's shipping charge while nothing has been
 * invoiced, since it rides on the first invoice. Worked out with the same cumulative-share
 * rounding as the invoices themselves (`invoicePortion`), so the exposure an order adds is exactly
 * what its future invoices will charge — to the poisha.
 */
export function uninvoicedValue(order: {
  lines: readonly OrderLineValue[];
  shippingMinor?: number;
}): number {
  let total = 0;
  let invoicedAny = false;
  for (const l of order.lines) {
    if (l.qtyInvoicedBase > 0) invoicedAny = true;
    const left = l.qtyBase - l.qtyInvoicedBase - l.qtyCancelledBase;
    if (left > 0) total += invoicePortion(l, left).netMinor;
  }
  return total + (invoicedAny ? 0 : (order.shippingMinor ?? 0));
}

export type CreditVerdict =
  | { ok: true; exposureAfterMinor: number }
  | {
      ok: false;
      reason: 'ON_HOLD' | 'OVER_LIMIT' | 'CASH_ONLY';
      message: string;
      exposureAfterMinor: number;
      limitMinor: number;
    };

/**
 * Whether `newCreditMinor` more of credit may be extended.
 *
 * `enforceLimit` is `org.settings.enforceCreditLimit`. A hold is refused regardless — it is a
 * person's explicit decision, not a threshold. A limit of zero means cash only.
 */
export function checkCredit(
  p: CreditPosition,
  newCreditMinor: number,
  enforceLimit: boolean,
): CreditVerdict {
  const exposureAfterMinor = p.exposureMinor + newCreditMinor;
  if (newCreditMinor <= 0) return { ok: true, exposureAfterMinor };

  if (p.creditHold) {
    return {
      ok: false,
      reason: 'ON_HOLD',
      message: `On credit hold${p.creditHoldReason ? `: ${p.creditHoldReason}` : ''}`,
      exposureAfterMinor,
      limitMinor: p.creditLimitMinor,
    };
  }
  if (!enforceLimit) return { ok: true, exposureAfterMinor };
  if (p.creditLimitMinor <= 0) {
    return {
      ok: false,
      reason: 'CASH_ONLY',
      message: 'This dealer has no credit limit — cash only',
      exposureAfterMinor,
      limitMinor: 0,
    };
  }
  if (exposureAfterMinor > p.creditLimitMinor) {
    return {
      ok: false,
      reason: 'OVER_LIMIT',
      message: 'This sale would take the dealer over their credit limit',
      exposureAfterMinor,
      limitMinor: p.creditLimitMinor,
    };
  }
  return { ok: true, exposureAfterMinor };
}
