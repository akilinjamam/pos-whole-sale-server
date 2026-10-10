import { Types } from 'mongoose';

import { ageInvoices, bucketTotals, emptyBuckets } from '../../domain/ageing.js';
import { dayIn, dayToDate, startOfDayIn } from '../../lib/period.js';
import { AGEING_BUCKETS } from '../../shared/enums.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';

import { PaymentDoc } from './paymentDoc.model.js';

import type { AgeingInvoice, AllocationEvent } from '../../domain/ageing.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { AgeingQuery } from '@shared/payments.js';
import type { AgeingReport, AgeingRow } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * `GET /payments/ageing` — who owes what, and how late (§8 "Ageing", Day 30).
 *
 * As of a day — today by default, or any past month-end, re-runnable with the same answer. The
 * rules are the pure `domain/ageing.ts`; this file only loads what it needs:
 *
 *   invoices  posted, for a party, raised by the as-of day, and either still open *now* or touched
 *             since the as-of day (a payment, a bounce) — an invoice paid off before the day and
 *             untouched since cannot have been open on it, so it is not loaded at all;
 *   payments  every allocation to those invoices, with when it was made and — for a bounced
 *             cheque — when it was undone.
 *
 * Each invoice's balance on the day is then its total less what had been allocated to it by then
 * and not reversed by then. For today that equals `Invoice.balanceMinor` — the integration test
 * holds the two against each other.
 */
export async function ageingReport(
  actor: RequestActor,
  query: AgeingQuery,
): Promise<AgeingReport> {
  const zone =
    (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
  const asOf = query.asOf ?? dayIn(new Date(), zone);
  const endOfDay = new Date(startOfDayIn(asOf, zone).getTime() + 86_400_000);
  const day = (d: Date) => dayToDate(dayIn(d, zone))!;

  const partyFilter: FilterQuery<unknown> = { orgId: actor.orgId };
  if (query.partyId) partyFilter._id = new Types.ObjectId(query.partyId);
  if (query.territory) partyFilter['dealer.territory'] = query.territory;
  const scoped = Boolean(query.partyId || query.territory);
  const parties = scoped
    ? await Party.find(partyFilter).select('code name displayName phone dealer').lean()
    : null;

  const invoiceDocs = await Invoice.find({
    orgId: actor.orgId,
    status: 'POSTED',
    partyId: parties ? { $in: parties.map((p) => p._id) } : { $ne: null },
    invoiceDate: { $lt: endOfDay },
    $or: [{ balanceMinor: { $gt: 0 } }, { updatedAt: { $gte: endOfDay } }],
  })
    .select('partyId docNo invoiceDate dueDate grandTotalMinor creditedMinor')
    .lean();

  const allocationRows = invoiceDocs.length
    ? await PaymentDoc.aggregate<{
        invoiceId: Types.ObjectId;
        amountMinor: number;
        allocatedAt: Date;
        reversedAt: Date | null;
      }>([
        {
          $match: {
            orgId: actor.orgId,
            'allocations.invoiceId': { $in: invoiceDocs.map((i) => i._id) },
          },
        },
        { $unwind: '$allocations' },
        { $match: { 'allocations.invoiceId': { $in: invoiceDocs.map((i) => i._id) } } },
        {
          $project: {
            _id: 0,
            invoiceId: '$allocations.invoiceId',
            amountMinor: '$allocations.amountMinor',
            allocatedAt: '$allocations.allocatedAt',
            reversedAt: { $ifNull: ['$allocations.reversedAt', null] },
          },
        },
      ])
    : [];

  const invoices: AgeingInvoice[] = invoiceDocs.map((i) => ({
    id: String(i._id),
    partyId: String(i.partyId),
    docNo: i.docNo ?? '',
    invoiceDay: day(i.invoiceDate),
    dueDay: i.dueDate ? day(i.dueDate) : null,
    grandTotalMinor: i.grandTotalMinor,
    creditedMinor: i.creditedMinor ?? 0,
  }));
  const allocations: AllocationEvent[] = allocationRows.map((a) => ({
    invoiceId: String(a.invoiceId),
    amountMinor: a.amountMinor,
    allocatedDay: day(a.allocatedAt),
    reversedDay: a.reversedAt ? day(a.reversedAt) : null,
  }));

  const aged = ageInvoices(invoices, allocations, dayToDate(asOf)!);
  const docBy = new Map(invoiceDocs.map((i) => [String(i._id), i]));

  const partyIds = [...new Set(aged.map((a) => a.partyId))];
  const partyDocs =
    parties ??
    (await Party.find({ orgId: actor.orgId, _id: { $in: partyIds } })
      .select('code name displayName phone dealer')
      .lean());
  const partyBy = new Map(partyDocs.map((p) => [String(p._id), p]));

  const rows: AgeingRow[] = partyIds.map((pid) => {
    const mine = aged
      .filter((a) => a.partyId === pid)
      .sort((x, y) => y.daysOverdue - x.daysOverdue);
    const p = partyBy.get(pid);
    const buckets = bucketTotals(mine);
    return {
      partyId: pid,
      code: p?.code ?? '?',
      name: p ? (p.displayName ?? p.name) : '(no such party)',
      phone: p?.phone ?? null,
      territory: p?.dealer?.territory ?? null,
      creditLimitMinor: p?.dealer?.creditLimitMinor ?? null,
      buckets,
      totalMinor: mine.reduce((t, a) => t + a.balanceMinor, 0),
      oldestDays: mine[0]?.daysOverdue ?? 0,
      invoices: mine.map((a) => {
        const doc = docBy.get(a.id)!;
        return {
          id: a.id,
          docNo: a.docNo,
          invoiceDate: doc.invoiceDate.toISOString(),
          dueDate: doc.dueDate ? doc.dueDate.toISOString() : null,
          balanceMinor: a.balanceMinor,
          daysOverdue: a.daysOverdue,
          bucket: a.bucket,
        };
      }),
    };
  });
  // The most overdue money first: whoever has the most in the oldest bucket.
  const weight = (r: AgeingRow) =>
    AGEING_BUCKETS.slice()
      .reverse()
      .map((b) => r.buckets[b]);
  rows.sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    for (let i = 0; i < wa.length; i += 1) if (wa[i] !== wb[i]) return wb[i]! - wa[i]!;
    return 0;
  });

  const totals = rows.length ? bucketTotals(aged) : emptyBuckets();
  return {
    asOf,
    buckets: [...AGEING_BUCKETS],
    totals,
    totalMinor: aged.reduce((t, a) => t + a.balanceMinor, 0),
    rows,
    generatedAt: new Date().toISOString(),
  };
}
