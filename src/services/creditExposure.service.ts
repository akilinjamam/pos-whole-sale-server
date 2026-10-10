import { exposureOf, uninvoicedValue } from '../domain/creditCheck.js';
import { Invoice } from '../modules/invoice/invoice.model.js';
import { PaymentDoc } from '../modules/payment/paymentDoc.model.js';
import { WholesaleOrder } from '../modules/wholesaleOrder/wholesaleOrder.model.js';

import type { ExposureParts } from '../domain/creditCheck.js';
import type { OrderStatus } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * A dealer's credit exposure, as of the caller's transaction (§8, Day 31). The rule is the pure
 * `exposureOf`; this only gathers its three parts:
 *
 *   open invoices   posted, with a balance — wholesale, counter credit, and opening `OB-` ones;
 *   open orders     confirmed and not yet fully invoiced — their remaining value. An order waiting
 *                   for approval is not counted: nobody has committed to it yet;
 *   advances        receipts with money left on account. A pending cheque has none — it is not
 *                   money until it clears.
 *
 * Read with the caller's session, so a confirm or a dispatch is judged on the dealer as they stand
 * inside that transaction — not as they looked a moment before it began.
 */

/** Orders the business is committed to: stock reserved or on its way. */
export const COMMITTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'CONFIRMED',
  'PICKING',
  'PACKED',
  'PARTIALLY_DISPATCHED',
];

export interface Exposure extends ExposureParts {
  exposureMinor: number;
}

export async function creditExposure(
  orgId: Types.ObjectId,
  partyId: Types.ObjectId,
  {
    session,
    excludeOrderId,
    excludeInvoiceId,
  }: {
    session?: ClientSession;
    /** The order being judged — counted as the new credit, so not also as an open order. */
    excludeOrderId?: Types.ObjectId;
    /** The invoice being posted in this transaction — likewise counted once, as the new credit. */
    excludeInvoiceId?: Types.ObjectId;
  } = {},
): Promise<Exposure> {
  // One after another, not Promise.all: operations on one session inside a transaction must not
  // run in parallel.
  const invoices = await Invoice.aggregate<{ n: number }>([
    {
      $match: {
        orgId,
        partyId,
        status: 'POSTED',
        balanceMinor: { $gt: 0 },
        ...(excludeInvoiceId ? { _id: { $ne: excludeInvoiceId } } : {}),
      },
    },
    { $group: { _id: null, n: { $sum: '$balanceMinor' } } },
  ]).session(session ?? null);
  const orders = await WholesaleOrder.find({
    orgId,
    dealerPartyId: partyId,
    status: { $in: COMMITTED_ORDER_STATUSES },
    isDeleted: false,
    ...(excludeOrderId ? { _id: { $ne: excludeOrderId } } : {}),
  })
    .select('lines shippingMinor')
    .session(session ?? null)
    .lean();
  const advances = await PaymentDoc.aggregate<{ n: number }>([
    {
      $match: {
        orgId,
        partyId,
        direction: 'IN',
        status: 'POSTED',
        unallocatedMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, n: { $sum: '$unallocatedMinor' } } },
  ]).session(session ?? null);

  const parts: ExposureParts = {
    openInvoicesMinor: invoices[0]?.n ?? 0,
    openOrdersMinor: orders.reduce((t, o) => t + uninvoicedValue(o), 0),
    unallocatedMinor: advances[0]?.n ?? 0,
  };
  return { ...parts, exposureMinor: exposureOf(parts) };
}
