import { Types } from 'mongoose';

import { dayIn } from '../../lib/period.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';

import { PaymentDoc } from './paymentDoc.model.js';

import type { RequestActor } from '../../lib/requestUser.js';
import type { CollectionSheetQuery } from '@shared/payments.js';
import type { CollectionRow, CollectionSheet } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * The collection sheet (Day 29): the collector's round. Every dealer with an open invoice, what
 * they owe, how much of it is past due, the invoices behind it — and any advance of theirs we
 * already hold, which is set off before asking them for more.
 *
 * Built from open invoices (opening `OB-` ones included), not the ledger balance: a collector asks
 * for invoices, and needs the numbers to write on the receipt. Most overdue first.
 */

const DAY = 86_400_000;

export async function collectionSheet(
  actor: RequestActor,
  query: CollectionSheetQuery,
): Promise<CollectionSheet> {
  const now = new Date();
  const zone =
    (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';

  const dealerFilter: FilterQuery<unknown> = { orgId: actor.orgId, roles: 'DEALER' };
  if (query.salespersonUserId) {
    dealerFilter['dealer.salespersonUserId'] = new Types.ObjectId(query.salespersonUserId);
  }
  if (query.territory) dealerFilter['dealer.territory'] = query.territory;
  const dealers = await Party.find(dealerFilter)
    .select('code name displayName phone addresses dealer')
    .lean();
  const ids = dealers.map((d) => d._id);

  const [invoices, advances] = await Promise.all([
    Invoice.find({
      orgId: actor.orgId,
      partyId: { $in: ids },
      status: 'POSTED',
      balanceMinor: { $gt: 0 },
    })
      .select('partyId docNo invoiceDate dueDate balanceMinor')
      .sort({ dueDate: 1, invoiceDate: 1 })
      .lean(),
    PaymentDoc.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          orgId: actor.orgId,
          partyId: { $in: ids },
          direction: 'IN',
          status: 'POSTED',
          unallocatedMinor: { $gt: 0 },
        },
      },
      { $group: { _id: '$partyId', n: { $sum: '$unallocatedMinor' } } },
    ]),
  ]);
  const advanceOf = new Map(advances.map((a) => [String(a._id), a.n]));

  const byParty = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    const k = String(inv.partyId);
    byParty.set(k, [...(byParty.get(k) ?? []), inv]);
  }

  const rows: CollectionRow[] = [];
  for (const d of dealers) {
    const open = byParty.get(String(d._id));
    if (!open?.length) continue;
    const list = open.map((i) => {
      const daysOverdue = i.dueDate
        ? Math.floor((now.getTime() - i.dueDate.getTime()) / DAY)
        : null;
      return {
        id: String(i._id),
        docNo: i.docNo ?? '',
        invoiceDate: i.invoiceDate.toISOString(),
        dueDate: i.dueDate ? i.dueDate.toISOString() : null,
        balanceMinor: i.balanceMinor,
        daysOverdue,
      };
    });
    const overdueMinor = list
      .filter((i) => (i.daysOverdue ?? 0) > 0)
      .reduce((t, i) => t + i.balanceMinor, 0);
    if (query.overdueOnly && overdueMinor === 0) continue;
    const a = d.addresses.find((x) => x.isDefaultBilling) ?? d.addresses[0];
    rows.push({
      partyId: String(d._id),
      code: d.code,
      name: d.displayName ?? d.name,
      phone: d.phone ?? null,
      address: a ? [a.line1, a.city].filter(Boolean).join(', ') : null,
      territory: d.dealer?.territory ?? null,
      salespersonUserId: d.dealer?.salespersonUserId
        ? String(d.dealer.salespersonUserId)
        : null,
      totalDueMinor: list.reduce((t, i) => t + i.balanceMinor, 0),
      overdueMinor,
      advanceMinor: advanceOf.get(String(d._id)) ?? 0,
      invoices: list,
    });
  }
  rows.sort((x, y) => y.overdueMinor - x.overdueMinor || y.totalDueMinor - x.totalDueMinor);

  return {
    asOf: dayIn(now, zone),
    rows,
    totals: {
      dueMinor: rows.reduce((t, r) => t + r.totalDueMinor, 0),
      overdueMinor: rows.reduce((t, r) => t + r.overdueMinor, 0),
      dealers: rows.length,
    },
  };
}
