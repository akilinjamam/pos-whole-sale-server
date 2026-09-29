import { mongo, Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { listQuerySchema, paginate } from '../../lib/paginate.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { assertLocationAllowed } from '../../middleware/requireLocation.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Location } from '../location/location.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { SalesReturn } from '../salesReturn/salesReturn.model.js';
import { User } from '../user/user.model.js';

import { PosSession } from './posSession.model.js';

import type { PosSessionDoc } from './posSession.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { CloseSessionInput, OpenSessionInput } from '@shared/pos.js';
import type { PageMeta, PosSessionPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';
import type { z } from 'zod';

/**
 * Cash sessions — open, sell, count, close (§6.10).
 *
 * Totals and expected cash are **derived** from the invoices and receipts that carry the session's
 * id, never kept as running counters on the session: a counter that one sale forgot to bump would
 * be a variance nobody could explain. At close they are computed once and frozen — the Z-report.
 */

type Totals = NonNullable<PosSessionDoc['totals']>;

/** Sales, discounts and takings by method for one session, from its documents. */
async function sessionFigures(
  orgId: Types.ObjectId,
  sessionId: Types.ObjectId,
): Promise<{ totals: Totals; cashInMinor: number; cashOutMinor: number }> {
  const [sales, methods, returns] = await Promise.all([
    Invoice.aggregate<{ n: number; gross: number; discount: number; net: number }>([
      { $match: { orgId, posSessionId: sessionId, status: 'POSTED' } },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          gross: { $sum: '$subtotalMinor' },
          discount: { $sum: '$discountMinor' },
          net: { $sum: '$grandTotalMinor' },
        },
      },
    ]),
    PaymentDoc.aggregate<{ _id: { method: string; direction: string }; amount: number }>([
      { $match: { orgId, posSessionId: sessionId, status: 'POSTED' } },
      {
        $group: {
          _id: { method: '$method', direction: '$direction' },
          amount: { $sum: '$amountMinor' },
        },
      },
    ]),
    SalesReturn.aggregate<{ n: number; total: number }>([
      { $match: { orgId, posSessionId: sessionId, status: 'POSTED' } },
      { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$grandTotalMinor' } } },
    ]),
  ]);

  const byMethod = new Map<string, number>();
  let cashInMinor = 0;
  let cashOutMinor = 0;
  for (const m of methods) {
    const signed = m._id.direction === 'IN' ? m.amount : -m.amount;
    byMethod.set(m._id.method, (byMethod.get(m._id.method) ?? 0) + signed);
    if (m._id.method === 'CASH') {
      if (m._id.direction === 'IN') cashInMinor += m.amount;
      else cashOutMinor += m.amount;
    }
  }

  const s = sales[0];
  const r = returns[0];
  return {
    totals: {
      salesCount: s?.n ?? 0,
      grossMinor: s?.gross ?? 0,
      discountMinor: s?.discount ?? 0,
      returnsMinor: r?.total ?? 0,
      returnsCount: r?.n ?? 0,
      netMinor: (s?.net ?? 0) - (r?.total ?? 0),
      byMethod: [...byMethod].map(([method, amountMinor]) => ({ method, amountMinor })),
      cashInMinor,
      cashOutMinor,
    },
    cashInMinor,
    cashOutMinor,
  };
}

async function toPayload(doc: PosSessionDoc): Promise<PosSessionPayload> {
  const [location, user, closer] = await Promise.all([
    Location.findById(doc.locationId).select('name').lean(),
    User.findById(doc.openedByUserId).select('name').lean(),
    doc.closedByUserId ? User.findById(doc.closedByUserId).select('name').lean() : null,
  ]);

  // An open session's figures are live; a closed one's were frozen at close.
  let totals = doc.totals;
  let expected = doc.expectedCashMinor;
  if (doc.status === 'OPEN') {
    const f = await sessionFigures(doc.orgId, doc._id);
    totals = f.totals;
    expected = doc.openingFloatMinor + f.cashInMinor - f.cashOutMinor;
  }

  return {
    id: String(doc._id),
    locationId: String(doc.locationId),
    locationName: location?.name,
    terminalCode: doc.terminalCode,
    status: doc.status,
    openedByUserId: String(doc.openedByUserId),
    openedByName: user?.name,
    openedAt: doc.openedAt.toISOString(),
    openingFloatMinor: doc.openingFloatMinor,
    closedAt: doc.closedAt ? doc.closedAt.toISOString() : null,
    expectedCashMinor: expected ?? doc.openingFloatMinor,
    countedCashMinor: doc.countedCashMinor,
    varianceMinor: doc.varianceMinor,
    denominations: doc.denominations,
    closedByName: closer?.name,
    closeNote: doc.closeNote ?? null,
    totals: totals ?? {
      salesCount: 0,
      grossMinor: 0,
      discountMinor: 0,
      returnsMinor: 0,
      netMinor: 0,
      byMethod: [],
    },
  };
}

/** A cashier sees their own shifts; `pos:viewAllSessions` sees everyone's. */
function assertCanSee(actor: RequestActor, doc: PosSessionDoc): void {
  if (
    !doc.openedByUserId.equals(actor.actorId) &&
    !hasPermission(actor.user, 'pos:viewAllSessions')
  ) {
    throw ApiError.notFound('Session');
  }
}

export async function openSession(
  actor: RequestActor,
  input: OpenSessionInput,
): Promise<PosSessionPayload> {
  const location = await Location.findOne({ _id: input.locationId, orgId: actor.orgId })
    .select('type allowsSales isActive code')
    .lean();
  if (!location || !location.isActive)
    throw ApiError.validation('Validation failed', [
      { path: 'locationId', message: 'No such location' },
    ]);
  if (!location.allowsSales || location.type === 'TRANSIT') {
    throw ApiError.validation('Validation failed', [
      { path: 'locationId', message: `${location.code} does not make sales` },
    ]);
  }

  try {
    const doc = await PosSession.create({
      orgId: actor.orgId,
      locationId: location._id,
      terminalCode: input.terminalCode,
      openedByUserId: actor.actorId,
      openedAt: new Date(),
      openingFloatMinor: input.openingFloatMinor,
      createdBy: actor.actorId,
      updatedBy: actor.actorId,
    });
    return toPayload(doc.toObject());
  } catch (error) {
    // The partial unique indexes: one open shift per till, one per cashier.
    if (error instanceof mongo.MongoServerError && error.code === 11000) {
      const perCashier = String(error.message).includes('one_open_per_cashier');
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        perCashier
          ? 'You already have an open shift — close it first'
          : `Till ${input.terminalCode} at ${location.code} is already open`,
      );
    }
    throw error;
  }
}

/** The caller's open shift, or null — the sale screen asks this first. */
export async function currentSession(actor: RequestActor): Promise<PosSessionPayload | null> {
  const doc = await PosSession.findOne({
    orgId: actor.orgId,
    openedByUserId: actor.actorId,
    status: 'OPEN',
  }).lean();
  return doc ? toPayload(doc) : null;
}

export async function getSession(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<PosSessionPayload> {
  const doc = await PosSession.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Session');
  assertCanSee(actor, doc);
  return toPayload(doc);
}

export const listSessionsQuerySchema = listQuerySchema;

export async function listSessions(
  actor: RequestActor,
  query: z.infer<typeof listSessionsQuerySchema> & {
    status?: 'OPEN' | 'CLOSED';
    locationId?: string;
  },
): Promise<{ items: PosSessionPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PosSessionDoc> = { orgId: actor.orgId };
  if (!hasPermission(actor.user, 'pos:viewAllSessions')) filter.openedByUserId = actor.actorId;
  if (query.status) filter.status = query.status;
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);

  const { items, meta } = await paginate<PosSessionDoc>(PosSession, {
    filter,
    query,
    sortable: ['openedAt', 'closedAt'],
    searchFields: [],
    defaultSort: { openedAt: -1 },
  });
  return { items: await Promise.all(items.map(toPayload)), meta };
}

/**
 * Close a shift: count the drawer, compare with what should be in it, freeze the Z-report.
 *
 * Counted cash is computed from the denomination count — never typed as a total — so the figure
 * can be checked note by note later. A cashier closes their own shift; closing someone else's
 * (they went home without closing) needs `pos:viewAllSessions`.
 */
export async function closeSession(
  actor: RequestActor,
  id: Types.ObjectId,
  input: CloseSessionInput,
): Promise<PosSessionPayload> {
  const doc = await PosSession.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Session');
  if (
    !doc.openedByUserId.equals(actor.actorId) &&
    !hasPermission(actor.user, 'pos:viewAllSessions')
  ) {
    throw ApiError.forbidden('Only the cashier, or a manager, can close this shift');
  }
  assertLocationAllowed(actor.user, String(doc.locationId));
  if (doc.status !== 'OPEN')
    throw ApiError.conflict('ILLEGAL_TRANSITION', 'This shift is already closed');

  const { totals, cashInMinor, cashOutMinor } = await sessionFigures(actor.orgId, id);
  const expectedCashMinor = doc.openingFloatMinor + cashInMinor - cashOutMinor;
  const countedCashMinor = input.denominations.reduce((s, d) => s + d.note * 100 * d.count, 0);

  const closed = await PosSession.findOneAndUpdate(
    { _id: id, orgId: actor.orgId, status: 'OPEN' },
    {
      $set: {
        status: 'CLOSED',
        closedByUserId: actor.actorId,
        closedAt: new Date(),
        expectedCashMinor,
        countedCashMinor,
        varianceMinor: countedCashMinor - expectedCashMinor,
        denominations: input.denominations.filter((d) => d.count > 0),
        totals,
        closeNote: input.note ?? null,
        updatedBy: actor.actorId,
      },
    },
    { new: true },
  ).lean();
  if (!closed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'This shift is already closed');
  return toPayload(closed);
}
