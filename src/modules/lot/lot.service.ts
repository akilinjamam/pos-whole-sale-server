import { Types } from 'mongoose';

import { daysToExpiry } from '../../domain/warranty.js';
import { paginate } from '../../lib/paginate.js';
import { addDays, dateToDay, dayIn, dayToDate } from '../../lib/period.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { lineNames } from '../../services/stockLines.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';

import { Lot } from './lot.model.js';
import { LotBalance } from './lotBalance.model.js';

import type { ExpiringQuery, ListLotsQuery } from './lot.schema.js';
import type { LotDoc } from './lot.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { LotPayload, PageMeta } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

async function todayFor(orgId: Types.ObjectId): Promise<string> {
  const org = await Org.findById(orgId).select('timeZone').lean();
  return dayIn(new Date(), org?.timeZone ?? 'Asia/Dhaka');
}

/** The caller's locations as ObjectIds, or null when unrestricted. */
function scopeIds(actor: RequestActor, requested?: string): Types.ObjectId[] | null {
  if (requested) return [new Types.ObjectId(requested)];
  const scope = locationScopeOf(actor.user);
  return scope ? scope.map((id) => new Types.ObjectId(id)) : null;
}

async function serialize(
  actor: RequestActor,
  lots: LotDoc[],
  locations: Types.ObjectId[] | null,
): Promise<LotPayload[]> {
  const [names, balances, today] = await Promise.all([
    lineNames(actor.orgId, lots),
    LotBalance.find({
      orgId: actor.orgId,
      lotId: { $in: lots.map((l) => l._id) },
      qtyOnHand: { $ne: 0 },
      ...(locations ? { locationId: { $in: locations } } : {}),
    }).lean(),
    todayFor(actor.orgId),
  ]);
  const codes = new Map(
    (
      await Location.find({
        orgId: actor.orgId,
        _id: { $in: balances.map((b) => b.locationId) },
      })
        .select('code')
        .lean()
    ).map((l) => [String(l._id), l.code]),
  );

  return lots.map((lot) => {
    const n = names(lot);
    const here = balances.filter((b) => b.lotId.equals(lot._id));
    const expiry = dateToDay(lot.expiryDate);
    return {
      id: String(lot._id),
      lotNo: lot.lotNo,
      productId: String(lot.productId),
      variantId: lot.variantId ? String(lot.variantId) : null,
      mfgDate: dateToDay(lot.mfgDate),
      expiryDate: expiry,
      daysToExpiry: expiry ? daysToExpiry(expiry, today) : null,
      onHand: here.map((b) => ({
        locationId: String(b.locationId),
        locationCode: codes.get(String(b.locationId)) ?? '',
        qtyOnHand: b.qtyOnHand,
      })),
      totalOnHand: here.reduce((s, b) => s + b.qtyOnHand, 0),
      productName: n.productName,
      sku: n.sku,
      baseUom: n.baseUom,
      variantLabel: n.variantLabel,
    };
  });
}

export async function listLots(
  actor: RequestActor,
  query: ListLotsQuery,
): Promise<{ items: LotPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<LotDoc> = { orgId: actor.orgId };
  if (query.productId) filter.productId = new Types.ObjectId(query.productId);
  const locations = scopeIds(actor);

  if (query.inStock) {
    const stocked = await LotBalance.distinct('lotId', {
      orgId: actor.orgId,
      qtyOnHand: { $gt: 0 },
      ...(locations ? { locationId: { $in: locations } } : {}),
    });
    filter._id = { $in: stocked };
  }

  const { items, meta } = await paginate<LotDoc>(Lot, {
    filter,
    query,
    sortable: ['expiryDate', 'lotNo', 'createdAt'],
    searchFields: ['lotNo'],
    defaultSort: { expiryDate: 1, lotNo: 1 },
  });
  return { items: await serialize(actor, items, locations), meta };
}

/**
 * The expiry report: every lot **with stock** that expires within `withinDays` — and every one
 * already expired, which is the more urgent half. Soonest first. Lots with no stock left are not
 * a problem and are not listed.
 */
export async function expiringLots(
  actor: RequestActor,
  query: ExpiringQuery,
): Promise<LotPayload[]> {
  const locations = scopeIds(actor, query.locationId);
  const cutoff = dayToDate(addDays(await todayFor(actor.orgId), query.withinDays))!;

  const stocked = await LotBalance.distinct('lotId', {
    orgId: actor.orgId,
    qtyOnHand: { $gt: 0 },
    ...(locations ? { locationId: { $in: locations } } : {}),
  });
  const lots = await Lot.find({
    orgId: actor.orgId,
    _id: { $in: stocked },
    expiryDate: { $ne: null, $lte: cutoff },
  })
    .sort({ expiryDate: 1 })
    .limit(1000)
    .lean();
  return serialize(actor, lots, locations);
}
