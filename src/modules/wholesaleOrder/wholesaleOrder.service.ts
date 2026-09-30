import { Types } from 'mongoose';

import { availableActions, can } from '../../domain/orderStateMachine.js';
import {
  billingStatusOf,
  fulfillmentStatusOf,
  orderTotals,
} from '../../domain/orderQuantities.js';
import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { Location } from '../location/location.model.js';
import { Party } from '../party/party.model.js';
import { Product } from '../product/product.model.js';

import {
  TRANSITION_WRITE,
  WholesaleOrder,
  toWholesaleOrderPayload,
  updateTouchesStatus,
} from './wholesaleOrder.model.js';

import type { ListOrdersQuery } from './wholesaleOrder.schema.js';
import type { OrderStatusHistoryDoc, WholesaleOrderDoc } from './wholesaleOrder.model.js';
import type {
  OrderTransitionContext,
  TransitionVerdict,
} from '../../domain/orderStateMachine.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { OrderStatus } from '@shared/enums.js';
import type { PageMeta, WholesaleOrderPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery, UpdateQuery } from 'mongoose';

// ─── Transitions ────────────────────────────────────────────────────────────────────────

/** The state machine's view of an order, for this actor. */
export function transitionContextOf(
  order: Pick<WholesaleOrderDoc, 'lines' | 'creditCheck'>,
  actor: RequestActor,
  reason?: string | null,
): OrderTransitionContext {
  const t = orderTotals(order.lines);
  return {
    permissions: actor.user.permissions,
    lineCount: order.lines.length,
    dispatchedBase: t.dispatchedBase,
    outstandingBase: t.outstandingBase,
    creditCheck: order.creditCheck?.status ?? null,
    reason: reason ?? null,
  };
}

function refusalToError(verdict: Extract<TransitionVerdict, { ok: false }>): ApiError {
  switch (verdict.refusal) {
    case 'FORBIDDEN':
      return ApiError.forbidden(verdict.message);
    case 'REASON_REQUIRED':
      return ApiError.validation(verdict.message, [
        { path: 'reason', message: verdict.message },
      ]);
    case 'NO_SUCH_TRANSITION':
    case 'GUARD_FAILED':
      return ApiError.conflict('ILLEGAL_TRANSITION', verdict.message);
  }
}

/** Fields a transition may set alongside the status — a docNo on confirm, the credit verdict. */
export type TransitionExtraSet = Partial<
  Pick<WholesaleOrderDoc, 'docNo' | 'creditCheck' | 'dueHint'>
>;

export interface TransitionOptions {
  reason?: string | null;
  set?: TransitionExtraSet;
  /** Every transition is part of a larger posting; it never commits on its own. */
  session: ClientSession;
}

/**
 * Move an order to `to` — **the only writer of `status` and `statusHistory`**.
 *
 * Callers do their own quantity work first, in the same session (a dispatch `$inc`s
 * `qtyDispatchedBase`, a short close sets `qtyCancelledBase`), then call this. It re-reads the
 * order with the session, so the state machine judges the order as those writes left it, then:
 *
 *   1. asks `can(from, to, ctx)` — 409 ILLEGAL_TRANSITION, 403 or 422 on refusal;
 *   2. writes the new status, the recomputed rollups and a `statusHistory` entry in one update,
 *      conditioned on the status it read — so a concurrent move of the same order cannot be
 *      silently overwritten; the loser gets a 409 (or a WriteConflict the transaction retries).
 */
export async function transitionOrder(
  actor: RequestActor,
  orderId: Types.ObjectId,
  to: OrderStatus,
  opts: TransitionOptions,
): Promise<WholesaleOrderDoc> {
  const { session } = opts;
  const order = await WholesaleOrder.findOne({
    _id: orderId,
    orgId: actor.orgId,
    isDeleted: false,
  })
    .session(session)
    .lean();
  if (!order) throw ApiError.notFound('Order');
  assertCanSee(actor, order);

  const reason = opts.reason?.trim() || null;
  const verdict = can(order.status, to, transitionContextOf(order, actor, reason));
  if (!verdict.ok) throw refusalToError(verdict);

  if (opts.set && updateTouchesStatus(opts.set)) {
    throw new Error('transitionOrder: `set` may not carry status or statusHistory');
  }

  const now = new Date();
  const entry: OrderStatusHistoryDoc = {
    from: order.status,
    to,
    action: verdict.rule.action,
    at: now,
    by: actor.actorId,
    reason,
  };

  const $set: UpdateQuery<WholesaleOrderDoc>['$set'] = {
    ...opts.set,
    status: to,
    fulfillmentStatus: fulfillmentStatusOf(order.lines),
    billingStatus: billingStatusOf(order.lines),
    updatedBy: actor.actorId,
  };
  if (to === 'CONFIRMED') Object.assign($set, { confirmedAt: now, confirmedBy: actor.actorId });
  if (to === 'CANCELLED') {
    Object.assign($set, { cancelledAt: now, cancelledBy: actor.actorId, cancelReason: reason });
  }
  if (to === 'CLOSED') Object.assign($set, { closedAt: now, closedBy: actor.actorId });

  const updated = await WholesaleOrder.findOneAndUpdate(
    { _id: order._id, orgId: actor.orgId, status: order.status },
    { $set, $push: { statusHistory: entry } },
    { new: true, session, ...TRANSITION_WRITE },
  ).lean();
  if (!updated) {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      'The order changed while you were working on it — reload and try again',
    );
  }
  return updated;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

/** Outside the caller's locations, an order does not exist for them. */
function assertCanSee(actor: RequestActor, order: Pick<WholesaleOrderDoc, 'locationId'>): void {
  const scope = locationScopeOf(actor.user);
  if (scope && !scope.includes(String(order.locationId))) throw ApiError.notFound('Order');
}

async function serialize(
  actor: RequestActor,
  docs: WholesaleOrderDoc[],
): Promise<WholesaleOrderPayload[]> {
  const ids = (pick: (d: WholesaleOrderDoc) => Types.ObjectId[]) => [
    ...new Set(docs.flatMap(pick).map(String)),
  ];
  const [dealers, locations, products] = await Promise.all([
    Party.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.dealerPartyId]) } })
      .select('name')
      .lean(),
    Location.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.locationId]) } })
      .select('name')
      .lean(),
    Product.find({
      orgId: actor.orgId,
      _id: { $in: ids((d) => d.lines.map((l) => l.productId)) },
    })
      .select('name sku')
      .lean(),
  ]);
  const dealerName = new Map(dealers.map((p) => [String(p._id), p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));
  const product = new Map(products.map((p) => [String(p._id), { name: p.name, sku: p.sku }]));

  return docs.map((d) =>
    toWholesaleOrderPayload(d, {
      availableActions: availableActions(d.status, transitionContextOf(d, actor)),
      dealerName: dealerName.get(String(d.dealerPartyId)),
      locationName: locationName.get(String(d.locationId)),
      product: (id) => product.get(String(id)),
    }),
  );
}

export async function listOrders(
  actor: RequestActor,
  query: ListOrdersQuery,
): Promise<{ items: WholesaleOrderPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<WholesaleOrderDoc> = { orgId: actor.orgId, isDeleted: false };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;
  if (query.fulfillmentStatus) filter.fulfillmentStatus = query.fulfillmentStatus;
  if (query.dealerPartyId) filter.dealerPartyId = new Types.ObjectId(query.dealerPartyId);

  const { items, meta } = await paginate<WholesaleOrderDoc>(WholesaleOrder, {
    filter,
    query,
    sortable: ['orderDate', 'requiredDate', 'docNo', 'grandTotalMinor', 'createdAt'],
    searchFields: ['docNo', 'note'],
    defaultSort: { orderDate: -1 },
  });
  return { items: await serialize(actor, items), meta };
}

export async function getOrder(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<WholesaleOrderPayload> {
  const doc = await WholesaleOrder.findOne({
    _id: id,
    orgId: actor.orgId,
    isDeleted: false,
  }).lean();
  if (!doc) throw ApiError.notFound('Order');
  assertCanSee(actor, doc);
  const [payload] = await serialize(actor, [doc]);
  return payload!;
}
