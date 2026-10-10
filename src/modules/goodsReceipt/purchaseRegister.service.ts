import { Types } from 'mongoose';

import { dayIn, startOfDayIn } from '../../lib/period.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PurchaseReturn } from '../purchaseReturn/purchaseReturn.model.js';
import { PurchaseOrder } from '../supplierPo/purchaseOrder.model.js';

import { GoodsReceipt } from './goodsReceipt.model.js';

import type { RegisterQuery } from './goodsReceipt.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { PurchaseRegisterPayload, PurchaseRegisterRow } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * The purchase register (Day 35): every supplier bill — posted goods receipt — in a period, and
 * every purchase return against them as a negative row, with what has been paid and what is still
 * owed on each bill today. Gated on `report:purchase`, which is a money report.
 *
 * Its totals tie to the supplier ledger: billed is the period's PURCHASE credits, returned its
 * DEBIT_NOTE debits.
 */
export async function purchaseRegister(
  actor: RequestActor,
  query: RegisterQuery,
): Promise<PurchaseRegisterPayload> {
  const org = await Org.findById(actor.orgId).select('timeZone').lean();
  const zone = org?.timeZone ?? 'Asia/Dhaka';
  const to = query.to ?? dayIn(new Date(), zone);
  const from = query.from ?? `${to.slice(0, 8)}01`;
  const start = startOfDayIn(from, zone);
  const end = new Date(startOfDayIn(to, zone).getTime() + 86_400_000);

  const scope = locationScopeOf(actor.user);
  const where: FilterQuery<unknown> = { orgId: actor.orgId };
  if (query.locationId) where.locationId = new Types.ObjectId(query.locationId);
  else if (scope) where.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.supplierPartyId) where.supplierPartyId = new Types.ObjectId(query.supplierPartyId);

  const [grns, returns] = await Promise.all([
    GoodsReceipt.find({ ...where, status: 'POSTED', postedAt: { $gte: start, $lt: end } })
      .sort({ postedAt: 1, _id: 1 })
      .lean(),
    PurchaseReturn.find({ ...where, status: 'POSTED', postedAt: { $gte: start, $lt: end } })
      .sort({ postedAt: 1, _id: 1 })
      .lean(),
  ]);

  const idsOf = (xs: (Types.ObjectId | null)[]) => [
    ...new Set(xs.flatMap((x) => (x ? [String(x)] : []))),
  ];
  const [suppliers, locations, pos, sourceGrns] = await Promise.all([
    Party.find({
      orgId: actor.orgId,
      _id: { $in: idsOf([...grns, ...returns].map((d) => d.supplierPartyId)) },
    })
      .select('name displayName')
      .lean(),
    Location.find({
      orgId: actor.orgId,
      _id: { $in: idsOf([...grns, ...returns].map((d) => d.locationId)) },
    })
      .select('name')
      .lean(),
    PurchaseOrder.find({ orgId: actor.orgId, _id: { $in: idsOf(grns.map((g) => g.poId)) } })
      .select('docNo')
      .lean(),
    GoodsReceipt.find({ orgId: actor.orgId, _id: { $in: idsOf(returns.map((r) => r.grnId)) } })
      .select('docNo')
      .lean(),
  ]);
  const supplierName = new Map(suppliers.map((p) => [String(p._id), p.displayName ?? p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));
  const poDocNo = new Map(pos.map((p) => [String(p._id), p.docNo]));
  const grnDocNo = new Map(sourceGrns.map((g) => [String(g._id), g.docNo]));

  const rows: PurchaseRegisterRow[] = [
    ...grns.map((g): PurchaseRegisterRow => ({
      kind: 'GRN',
      id: String(g._id),
      docNo: g.docNo ?? '',
      date: g.postedAt!.toISOString(),
      supplierPartyId: String(g.supplierPartyId),
      supplierName: supplierName.get(String(g.supplierPartyId)),
      locationName: locationName.get(String(g.locationId)),
      refDocNo: g.poId ? (poDocNo.get(String(g.poId)) ?? null) : null,
      supplierInvoiceNo: g.supplierInvoiceNo,
      goodsMinor: g.subtotalMinor - g.discountMinor,
      otherChargesMinor: g.otherChargesMinor,
      totalMinor: g.grandTotalMinor,
      paidMinor: g.paidMinor,
      balanceMinor: g.balanceMinor,
      dueDate: g.dueDate ? g.dueDate.toISOString() : null,
    })),
    ...returns.map((r): PurchaseRegisterRow => ({
      kind: 'RETURN',
      id: String(r._id),
      docNo: r.docNo,
      date: r.postedAt.toISOString(),
      supplierPartyId: String(r.supplierPartyId),
      supplierName: supplierName.get(String(r.supplierPartyId)),
      locationName: locationName.get(String(r.locationId)),
      refDocNo: r.grnId ? (grnDocNo.get(String(r.grnId)) ?? null) : null,
      supplierInvoiceNo: null,
      goodsMinor: -r.totalMinor,
      otherChargesMinor: 0,
      totalMinor: -r.totalMinor,
      paidMinor: 0,
      balanceMinor: -(r.unappliedMinor ?? 0),
      dueDate: null,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.docNo.localeCompare(b.docNo));

  const sum = (f: (r: PurchaseRegisterRow) => number, kind?: 'GRN' | 'RETURN') =>
    rows.filter((r) => !kind || r.kind === kind).reduce((t, r) => t + f(r), 0);
  const billedMinor = sum((r) => r.totalMinor, 'GRN');
  const returnedMinor = -sum((r) => r.totalMinor, 'RETURN');

  const bySupplier = new Map<string, PurchaseRegisterPayload['bySupplier'][number]>();
  for (const r of rows) {
    const s = bySupplier.get(r.supplierPartyId) ?? {
      supplierPartyId: r.supplierPartyId,
      supplierName: r.supplierName,
      billedMinor: 0,
      returnedMinor: 0,
      balanceMinor: 0,
    };
    if (r.kind === 'GRN') s.billedMinor += r.totalMinor;
    else s.returnedMinor -= r.totalMinor;
    s.balanceMinor += r.balanceMinor;
    bySupplier.set(r.supplierPartyId, s);
  }

  return {
    from,
    to,
    rows,
    totals: {
      billedMinor,
      returnedMinor,
      netMinor: billedMinor - returnedMinor,
      paidMinor: sum((r) => r.paidMinor, 'GRN'),
      balanceMinor: sum((r) => r.balanceMinor),
    },
    bySupplier: [...bySupplier.values()].sort((a, b) => b.billedMinor - a.billedMinor),
  };
}
