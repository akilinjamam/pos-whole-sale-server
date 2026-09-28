import { Types } from 'mongoose';

import { warrantyStatus } from '../../domain/warranty.js';
import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { dateToDay, dayIn } from '../../lib/period.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { lineNames } from '../../services/stockLines.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { StockLedger, toStockLedgerPayload } from '../stock/stockLedger.model.js';

import { SerialUnit } from './serialUnit.model.js';

import type { ListSerialsQuery } from './serialUnit.schema.js';
import type { SerialUnitDoc } from './serialUnit.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { PageMeta, SerialHistoryPayload, SerialUnitPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * The serial and warranty register (§6.4, Day 15). Read-only: a unit's status and location are
 * set by `stock.service` from the movements that move it, never edited here.
 */

const includeCost = (actor: RequestActor) => actor.user.permissions.includes('stock:viewCost');

async function todayFor(orgId: Types.ObjectId): Promise<string> {
  const org = await Org.findById(orgId).select('timeZone').lean();
  return dayIn(new Date(), org?.timeZone ?? 'Asia/Dhaka');
}

async function serialize(
  actor: RequestActor,
  docs: SerialUnitDoc[],
): Promise<SerialUnitPayload[]> {
  const [names, locations, parties, today] = await Promise.all([
    lineNames(actor.orgId, docs),
    Location.find({
      orgId: actor.orgId,
      _id: { $in: docs.flatMap((d) => (d.locationId ? [d.locationId] : [])) },
    })
      .select('code')
      .lean(),
    Party.find({
      orgId: actor.orgId,
      _id: { $in: docs.flatMap((d) => (d.soldPartyId ? [d.soldPartyId] : [])) },
    })
      .select('name displayName')
      .lean(),
    todayFor(actor.orgId),
  ]);
  const codeBy = new Map(locations.map((l) => [String(l._id), l.code]));
  const partyBy = new Map(parties.map((p) => [String(p._id), p.displayName ?? p.name]));
  const cost = includeCost(actor);

  return docs.map((d) => {
    const n = names(d);
    const startsOn = dateToDay(d.warrantyStartAt);
    const w = warrantyStatus(
      { warrantyMonths: d.warrantyMonths, warrantyStartDay: startsOn },
      today,
    );
    return {
      id: String(d._id),
      serialNo: d.serialNo,
      productId: String(d.productId),
      variantId: d.variantId ? String(d.variantId) : null,
      status: d.status,
      locationId: d.locationId ? String(d.locationId) : null,
      lotId: d.lotId ? String(d.lotId) : null,
      receivedAt: d.receivedAt.toISOString(),
      lastMovementAt: d.lastMovementAt.toISOString(),
      soldAt: d.soldAt ? d.soldAt.toISOString() : null,
      soldPartyId: d.soldPartyId ? String(d.soldPartyId) : null,
      soldInvoiceId: d.soldInvoiceId ? String(d.soldInvoiceId) : null,
      ...(cost ? { unitCostMinor: d.unitCostMinor } : {}),
      warranty: { ...w, months: d.warrantyMonths, startsOn },
      productName: n.productName,
      sku: n.sku,
      variantLabel: n.variantLabel,
      locationCode: d.locationId ? (codeBy.get(String(d.locationId)) ?? null) : null,
      soldPartyName: d.soldPartyId ? (partyBy.get(String(d.soldPartyId)) ?? null) : null,
    };
  });
}

export async function listSerials(
  actor: RequestActor,
  query: ListSerialsQuery,
): Promise<{ items: SerialUnitPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<SerialUnitDoc> = { orgId: actor.orgId };
  if (query.productId) filter.productId = new Types.ObjectId(query.productId);
  if (query.status) filter.status = query.status;
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  // A location-restricted user sees units on their own shelves — and every unit already sold,
  // since a warranty question can arrive at any counter.
  const scope = locationScopeOf(actor.user);
  if (scope && !query.locationId) {
    filter.$or = [
      { locationId: { $in: scope.map((id) => new Types.ObjectId(id)) } },
      { locationId: null },
    ];
  }
  if (query.warrantyEndingBefore) {
    filter.warrantyEndAt = {
      $ne: null,
      $lte: new Date(`${query.warrantyEndingBefore}T00:00:00.000Z`),
    };
  }

  const { items, meta } = await paginate<SerialUnitDoc>(SerialUnit, {
    filter,
    query,
    sortable: ['serialNo', 'receivedAt', 'soldAt', 'warrantyEndAt', 'lastMovementAt'],
    searchFields: ['serialNo'],
    defaultSort: { lastMovementAt: -1 },
    exclude: includeCost(actor) ? [] : ['unitCostMinor'],
  });
  return { items: await serialize(actor, items), meta };
}

/** One unit, with its whole history from the ledger — "where has this machine been?" */
export async function serialHistory(
  actor: RequestActor,
  serialNo: string,
): Promise<SerialHistoryPayload> {
  const unit = await SerialUnit.findOne({
    orgId: actor.orgId,
    serialNo: serialNo.trim().toUpperCase(),
  }).lean();
  if (!unit) throw ApiError.notFound('Serial');

  const rows = await StockLedger.find({ orgId: actor.orgId, serialNo: unit.serialNo })
    .sort({ postedAt: 1, _id: 1 })
    .lean();
  const [payload] = await serialize(actor, [unit]);
  const codeBy = new Map(
    (
      await Location.find({ orgId: actor.orgId, _id: { $in: rows.map((r) => r.locationId) } })
        .select('code')
        .lean()
    ).map((l) => [String(l._id), l.code]),
  );
  return {
    unit: payload!,
    history: rows.map((r) =>
      toStockLedgerPayload(r, {
        includeCost: includeCost(actor),
        locationCode: codeBy.get(String(r.locationId)),
      }),
    ),
  };
}
