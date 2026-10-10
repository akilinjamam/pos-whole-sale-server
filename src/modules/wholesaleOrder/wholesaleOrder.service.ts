import { Types } from 'mongoose';

import { availableActions, can } from '../../domain/orderStateMachine.js';
import {
  billingStatusOf,
  fulfillmentStatusOf,
  lineInvariantViolation,
  lineOutstanding,
  orderTotals,
} from '../../domain/orderQuantities.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dayIn, dayToDate } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { ORDER_STATUSES } from '../../shared/enums.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { writeAudit } from '../../services/audit.service.js';
import { releaseReservation, reserveStock } from '../../services/stock.service.js';
import { Dispatch } from '../dispatch/dispatch.model.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { Product } from '../product/product.model.js';

import {
  creditPosition,
  linesAsInput,
  priceOrder,
  quote,
  specOf,
  toOrderLines,
} from './orderPricing.js';
import {
  TRANSITION_WRITE,
  WholesaleOrder,
  toWholesaleOrderPayload,
  updateTouchesStatus,
} from './wholesaleOrder.model.js';

import type { PricedOrder, PriceOrderInput } from './orderPricing.js';
import type { ListOrdersQuery } from './wholesaleOrder.schema.js';
import type {
  OrderCreditCheckDoc,
  OrderLineDoc,
  OrderStatusHistoryDoc,
  WholesaleOrderDoc,
} from './wholesaleOrder.model.js';
import type { PartyDoc } from '../party/party.model.js';
import type {
  CancelOrderInput,
  ConfirmOrderInput,
  CreateOrderInput,
  OrderReasonInput,
  QuoteOrderInput,
  UpdateOrderInput,
} from '@shared/orders.js';
import type {
  OrderTransitionContext,
  TransitionVerdict,
} from '../../domain/orderStateMachine.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { OrderStatus } from '@shared/enums.js';
import type {
  OrderCounts,
  OrderQuote,
  PageMeta,
  WholesaleOrderPayload,
} from '@shared/types.js';
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

/**
 * The context for *offering* actions — the order screen's buttons — as opposed to taking one.
 *
 * Confirm and approve settle the credit check themselves before they transition: confirm runs it,
 * approve overrides it. Judged on the stored check, a draft (never checked) would offer no Confirm
 * and a pending order (BLOCKED) no Approve. So for the offer the check is taken as the action will
 * leave it; the endpoint then decides the real outcome, and the transition itself is still guarded
 * on the stored value. `submitForApproval` is never offered — it is an outcome of confirm.
 */
function offerContextOf(
  order: Pick<WholesaleOrderDoc, 'lines' | 'creditCheck' | 'status'>,
  actor: RequestActor,
): OrderTransitionContext {
  const ctx = transitionContextOf(order, actor);
  if (order.status === 'DRAFT') return { ...ctx, creditCheck: 'OK' };
  if (order.status === 'PENDING_APPROVAL') return { ...ctx, creditCheck: 'OVERRIDDEN' };
  return ctx;
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
      availableActions: availableActions(d.status, offerContextOf(d, actor)),
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

// ─── Drafts (Day 22) ────────────────────────────────────────────────────────────────────
//
// A draft is freely editable and has no number. Every save re-prices every line through the
// pricing engine and recomputes the totals — the client sends quantities, never money.

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

function assertNotOnHold(dealer: PartyDoc): void {
  if (dealer.dealer?.creditHold) {
    throw ApiError.conflict(
      'CREDIT_LIMIT_EXCEEDED',
      `${dealer.name} is on credit hold${dealer.dealer.creditHoldReason ? `: ${dealer.dealer.creditHoldReason}` : ''} — no new orders`,
      { dealerPartyId: String(dealer._id) },
    );
  }
}

/** One of the dealer's addresses as a printable line: the one asked for, else the default. */
function addressOf(
  dealer: PartyDoc,
  id: string | null | undefined,
  kind: 'isDefaultShipping' | 'isDefaultBilling',
  path: string,
): string | null {
  const a = id
    ? dealer.addresses.find((x) => String(x._id) === id)
    : (dealer.addresses.find((x) => x[kind]) ?? dealer.addresses[0]);
  if (id && !a) throw refuse(path, `Not one of ${dealer.name}'s addresses`);
  if (!a) return null;
  return [a.line1, a.line2, a.city, a.district].filter(Boolean).join(', ');
}

/** The header and lines a priced draft stores — shared by create and update. */
function pricedFields(priced: PricedOrder, previousLines: readonly OrderLineDoc[] = []) {
  return {
    dealerPartyId: priced.dealer._id,
    priceTierId: priced.dealer.dealer?.priceTierId ?? null,
    locationId: priced.locationId,
    lines: toOrderLines(priced.lines, previousLines),
    subtotalMinor: priced.subtotalMinor,
    orderDiscount: priced.orderDiscount
      ? {
          kind: priced.orderDiscount.kind,
          amountMinor:
            priced.orderDiscount.kind === 'AMOUNT' ? priced.orderDiscount.amountMinor : 0,
          pct: priced.orderDiscount.kind === 'PCT' ? priced.orderDiscount.pct : 0,
        }
      : null,
    orderDiscountMinor: priced.orderDiscountMinor,
    taxMinor: priced.taxMinor,
    shippingMinor: priced.shippingMinor,
    roundingMinor: priced.roundingMinor,
    grandTotalMinor: priced.grandTotalMinor,
  };
}

async function loadForWrite(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<WholesaleOrderDoc> {
  const doc = await WholesaleOrder.findOne({
    _id: id,
    orgId: actor.orgId,
    isDeleted: false,
  }).lean();
  if (!doc) throw ApiError.notFound('Order');
  assertCanSee(actor, doc);
  return doc;
}

const onlyDraft = (doc: WholesaleOrderDoc, verb: string) =>
  ApiError.conflict(
    'ILLEGAL_TRANSITION',
    `${doc.docNo ?? 'This order'} is ${doc.status} — only a draft can be ${verb}`,
  );

export async function createOrder(
  actor: RequestActor,
  input: CreateOrderInput,
): Promise<WholesaleOrderPayload> {
  const priced = await priceOrder(actor, input);
  assertNotOnHold(priced.dealer);
  const org = await Org.findById(actor.orgId)
    .select('timeZone settings.defaultPaymentTermsDays')
    .lean();

  const doc = await WholesaleOrder.create({
    orgId: actor.orgId,
    ...pricedFields(priced),
    salespersonUserId: priced.dealer.dealer?.salespersonUserId ?? actor.actorId,
    orderDate: dayToDate(input.orderDate ?? dayIn(new Date(), org?.timeZone ?? 'Asia/Dhaka')),
    requiredDate: dayToDate(input.requiredDate),
    shippingAddress: addressOf(
      priced.dealer,
      input.shippingAddressId,
      'isDefaultShipping',
      'shippingAddressId',
    ),
    billingAddress: addressOf(
      priced.dealer,
      input.billingAddressId,
      'isDefaultBilling',
      'billingAddressId',
    ),
    paymentTermsDays:
      input.paymentTermsDays ??
      priced.dealer.dealer?.paymentTermsDays ??
      org?.settings?.defaultPaymentTermsDays ??
      0,
    note: input.note ?? null,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  });
  const [payload] = await serialize(actor, [doc.toObject()]);
  return payload!;
}

export async function updateOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: UpdateOrderInput,
): Promise<WholesaleOrderPayload> {
  const doc = await loadForWrite(actor, id);
  if (doc.status !== 'DRAFT') throw onlyDraft(doc, 'changed');

  // What was not sent is kept — and still re-priced: yesterday's draft saved today is today's price.
  const merged: PriceOrderInput = {
    dealerPartyId: input.dealerPartyId ?? String(doc.dealerPartyId),
    locationId: input.locationId ?? String(doc.locationId),
    lines: input.lines ?? linesAsInput(doc.lines),
    orderDiscount:
      input.orderDiscount !== undefined ? input.orderDiscount : specOf(doc.orderDiscount),
    shippingMinor: input.shippingMinor ?? doc.shippingMinor,
  };
  const priced = await priceOrder(actor, merged, {
    previous: { lines: doc.lines, orderDiscount: doc.orderDiscount },
  });
  assertNotOnHold(priced.dealer);

  const dealerChanged = !priced.dealer._id.equals(doc.dealerPartyId);
  const $set: Record<string, unknown> = {
    ...pricedFields(priced, doc.lines),
    updatedBy: actor.actorId,
  };
  if (dealerChanged || input.shippingAddressId !== undefined) {
    $set.shippingAddress = addressOf(
      priced.dealer,
      input.shippingAddressId,
      'isDefaultShipping',
      'shippingAddressId',
    );
  }
  if (dealerChanged || input.billingAddressId !== undefined) {
    $set.billingAddress = addressOf(
      priced.dealer,
      input.billingAddressId,
      'isDefaultBilling',
      'billingAddressId',
    );
  }
  if (dealerChanged) {
    $set.salespersonUserId = priced.dealer.dealer?.salespersonUserId ?? doc.salespersonUserId;
    if (input.paymentTermsDays === undefined && priced.dealer.dealer) {
      $set.paymentTermsDays = priced.dealer.dealer.paymentTermsDays;
    }
  }
  if (input.paymentTermsDays !== undefined) $set.paymentTermsDays = input.paymentTermsDays;
  if (input.orderDate !== undefined) $set.orderDate = dayToDate(input.orderDate);
  if (input.requiredDate !== undefined) $set.requiredDate = dayToDate(input.requiredDate);
  if (input.note !== undefined) $set.note = input.note;

  // Conditioned on DRAFT: a confirm that lands between our read and this write wins, and we 409.
  const updated = await WholesaleOrder.findOneAndUpdate(
    { _id: doc._id, orgId: actor.orgId, status: 'DRAFT' },
    { $set },
    { new: true },
  ).lean();
  if (!updated)
    throw onlyDraft({ ...doc, status: (await loadForWrite(actor, id)).status }, 'changed');
  const [payload] = await serialize(actor, [updated]);
  return payload!;
}

export function quoteOrder(actor: RequestActor, input: QuoteOrderInput): Promise<OrderQuote> {
  return quote(actor, input);
}

// ─── Confirm, approve, reject, cancel (Day 22) ──────────────────────────────────────────

/** The stock a set of order lines holds, as reservation lines at the order's location. */
const reservationsOf = (
  order: Pick<WholesaleOrderDoc, 'locationId'>,
  lines: readonly OrderLineDoc[],
  qty: (l: OrderLineDoc) => number,
) =>
  lines
    .filter((l) => qty(l) > 0)
    .map((l) => ({
      locationId: order.locationId,
      productId: l.productId,
      variantId: l.variantId ?? null,
      qtyBase: qty(l),
    }));

/** Reserve every line in full, number the order, and move it to CONFIRMED — one session. */
async function reserveAndConfirm(
  actor: RequestActor,
  order: WholesaleOrderDoc,
  lines: OrderLineDoc[],
  reason: string | null,
  session: ClientSession,
): Promise<WholesaleOrderDoc> {
  const reserved = lines.map((l) => ({ ...l, qtyReservedBase: l.qtyBase }));
  await reserveStock(session, {
    orgId: actor.orgId,
    lines: reservationsOf(order, reserved, (l) => l.qtyBase),
  });
  await WholesaleOrder.updateOne(
    { _id: order._id, orgId: actor.orgId },
    { $set: { lines: reserved } },
    { session },
  );
  const docNo = await nextDocNo(session, actor.orgId, 'SO', new Date());
  return transitionOrder(actor, order._id, 'CONFIRMED', { session, reason, set: { docNo } });
}

/**
 * `POST /orders/:id/confirm` — in one transaction:
 *
 *   re-price → credit check → **reserve stock** (`qtyReserved += qty`, no ledger row) → allocate
 *   the `SO` number → DRAFT → CONFIRMED
 *
 * Refused for stock or credit, it leaves the draft exactly as it was: no reservation, no number
 * used. The credit check has three outcomes:
 *   - passes → CONFIRMED;
 *   - fails, caller holds `order:creditOverride` and gave a reason → CONFIRMED as OVERRIDDEN;
 *     without a reason → 409 CREDIT_LIMIT_EXCEEDED with `canOverride`, so the UI can ask for one;
 *   - fails, caller lacks the permission → PENDING_APPROVAL, nothing reserved or numbered yet.
 * A dealer on hold is refused outright: a hold is a person's decision, not a threshold.
 */
export async function confirmOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: ConfirmOrderInput,
): Promise<WholesaleOrderPayload> {
  const draft = await loadForWrite(actor, id);
  if (draft.status !== 'DRAFT') throw onlyDraft(draft, 'confirmed');
  if (draft.lines.length === 0)
    throw refuse('lines', 'Add at least one line before confirming');

  // Price outside the transaction (reads only); the transaction checks nothing moved meanwhile.
  const priced = await priceOrder(
    actor,
    {
      dealerPartyId: String(draft.dealerPartyId),
      locationId: String(draft.locationId),
      lines: linesAsInput(draft.lines),
      orderDiscount: specOf(draft.orderDiscount),
      shippingMinor: draft.shippingMinor,
    },
    { trustInput: true },
  );
  const overrideReason = input.creditOverrideReason?.trim() || null;

  const result = await withTransaction(async (session) => {
    const fresh = await WholesaleOrder.findOne({ _id: id, orgId: actor.orgId })
      .session(session)
      .lean();
    if (!fresh || fresh.status !== 'DRAFT') throw onlyDraft(fresh ?? draft, 'confirmed');
    if (fresh.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'The order was edited while it was being confirmed — reload and try again',
      );
    }

    // The dealer's exposure as of this transaction, not as of the pricing read.
    const dealer = (await Party.findById(fresh.dealerPartyId).session(session).lean())!;
    const credit = await creditPosition(actor, dealer, priced.grandTotalMinor, {
      session,
      excludeOrderId: id,
    });
    if (credit.verdict === 'ON_HOLD') assertNotOnHold(dealer);

    const overriding = credit.verdict !== 'OK' && credit.canOverride;
    if (overriding && !overrideReason) {
      throw ApiError.conflict(
        'CREDIT_LIMIT_EXCEEDED',
        credit.message ?? 'Over the credit limit',
        {
          canOverride: true,
          exposureMinor: credit.exposureMinor,
          exposureAfterMinor: credit.exposureAfterMinor,
          limitMinor: credit.limitMinor,
          shortfallMinor: credit.shortfallMinor,
          balanceMinor: credit.balanceMinor,
        },
      );
    }
    const creditCheck: OrderCreditCheckDoc = {
      status: credit.verdict === 'OK' ? 'OK' : overriding ? 'OVERRIDDEN' : 'BLOCKED',
      checkedAt: new Date(),
      // Exposure before and with this order — what the decision was made on.
      outstandingMinor: credit.exposureMinor,
      exposureMinor: credit.exposureAfterMinor,
      limitMinor: credit.limitMinor,
      overriddenByUserId: overriding ? actor.actorId : null,
      overrideReason: overriding ? overrideReason : null,
    };

    const lines = toOrderLines(priced.lines, fresh.lines);
    await WholesaleOrder.updateOne(
      { _id: id, orgId: actor.orgId },
      {
        $set: {
          ...pricedFields(priced, fresh.lines),
          lines,
          creditCheck,
          updatedBy: actor.actorId,
        },
      },
      { session },
    );

    if (creditCheck.status === 'BLOCKED') {
      return transitionOrder(actor, id, 'PENDING_APPROVAL', {
        session,
        reason: overrideReason,
      });
    }
    const confirmed = await reserveAndConfirm(actor, fresh, lines, overrideReason, session);
    if (overriding) {
      await auditCreditOverride(session, actor, confirmed, 'CONFIRM', overrideReason!, credit);
    }
    return confirmed;
  });
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

/**
 * `POST /orders/:id/approve` — a manager lends past the limit: the credit check is recorded as
 * OVERRIDDEN with their reason, then the order reserves and confirms exactly as a passing confirm
 * would. Prices stand as they were when the order was submitted.
 */
export async function approveOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: OrderReasonInput,
): Promise<WholesaleOrderPayload> {
  const result = await withTransaction(async (session) => {
    const order = await WholesaleOrder.findOne({
      _id: id,
      orgId: actor.orgId,
      isDeleted: false,
    })
      .session(session)
      .lean();
    if (!order) throw ApiError.notFound('Order');
    assertCanSee(actor, order);
    if (order.status !== 'PENDING_APPROVAL') {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `This order is ${order.status} — there is nothing to approve`,
      );
    }
    const dealer = (await Party.findById(order.dealerPartyId).session(session).lean())!;
    assertNotOnHold(dealer);
    // The position *now* — the dealer may have paid, or ordered more, since the rep submitted it.
    const credit = await creditPosition(actor, dealer, order.grandTotalMinor, {
      session,
      excludeOrderId: id,
    });

    await WholesaleOrder.updateOne(
      { _id: id, orgId: actor.orgId },
      {
        $set: {
          creditCheck: {
            status: 'OVERRIDDEN',
            checkedAt: new Date(),
            outstandingMinor: credit.exposureMinor,
            exposureMinor: credit.exposureAfterMinor,
            limitMinor: credit.limitMinor,
            overriddenByUserId: actor.actorId,
            overrideReason: input.reason,
          },
          updatedBy: actor.actorId,
        },
      },
      { session },
    );
    const confirmed = await reserveAndConfirm(actor, order, order.lines, input.reason, session);
    await auditCreditOverride(session, actor, confirmed, 'APPROVE', input.reason, credit);
    return confirmed;
  });
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

/**
 * Mirror a credit override to the audit log (§8): who lent past the limit, on which order, by how
 * much, and in their own words why. Written in the caller's transaction, so the override and its
 * record land together.
 */
export async function auditCreditOverride(
  session: ClientSession,
  actor: RequestActor,
  order: Pick<WholesaleOrderDoc, '_id' | 'docNo' | 'dealerPartyId' | 'grandTotalMinor'>,
  stage: 'CONFIRM' | 'APPROVE' | 'DISPATCH',
  reason: string,
  credit: {
    verdict: string;
    limitMinor: number;
    exposureMinor: number;
    exposureAfterMinor: number;
    shortfallMinor: number;
  },
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeAudit(session, actor, {
    action: 'CREDIT_OVERRIDE',
    entity: 'WholesaleOrder',
    entityId: order._id,
    docNo: order.docNo,
    reason,
    before: {
      stage,
      verdict: credit.verdict,
      limitMinor: credit.limitMinor,
      exposureMinor: credit.exposureMinor,
      exposureAfterMinor: credit.exposureAfterMinor,
      shortfallMinor: credit.shortfallMinor,
    },
    after: {
      dealerPartyId: String(order.dealerPartyId),
      orderTotalMinor: order.grandTotalMinor,
      ...extra,
    },
  });
}

/** `POST /orders/:id/reject` — back to DRAFT for the rep to amend. Nothing was reserved. */
export async function rejectOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: OrderReasonInput,
): Promise<WholesaleOrderPayload> {
  const result = await withTransaction((session) =>
    transitionOrder(actor, id, 'DRAFT', { session, reason: input.reason }),
  );
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

/**
 * `POST /orders/:id/cancel` — releases every unit the order still holds, exactly, and cancels it
 * — one transaction. Refused (by the state machine) once anything has been dispatched: that is a
 * short close (Day 26).
 */
export async function cancelOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: CancelOrderInput,
): Promise<WholesaleOrderPayload> {
  const result = await withTransaction(async (session) => {
    const order = await WholesaleOrder.findOne({
      _id: id,
      orgId: actor.orgId,
      isDeleted: false,
    })
      .session(session)
      .lean();
    if (!order) throw ApiError.notFound('Order');
    assertCanSee(actor, order);

    const held = reservationsOf(order, order.lines, (l) => l.qtyReservedBase);
    if (held.length > 0) {
      await releaseReservation(session, { orgId: actor.orgId, lines: held });
      await WholesaleOrder.updateOne(
        { _id: id, orgId: actor.orgId },
        { $set: { 'lines.$[].qtyReservedBase': 0, updatedBy: actor.actorId } },
        { session },
      );
    }
    // Its open challans go with it — a packed challan for a cancelled order must not be postable.
    // (The state machine refuses the cancel once any challan has been *posted*.)
    await Dispatch.updateMany(
      { orgId: actor.orgId, orderId: id, status: { $in: ['DRAFT', 'PACKED'] } },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: actor.actorId,
          cancelReason: `Order cancelled${input.reason ? `: ${input.reason}` : ''}`,
          updatedBy: actor.actorId,
        },
      },
      { session },
    );
    // Last, so a refusal (illegal from this status, no reason) rolls the release back with it.
    return transitionOrder(actor, id, 'CANCELLED', { session, reason: input.reason ?? null });
  });
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

// ─── Short close and close (Day 26) ─────────────────────────────────────────────────────

/**
 * `POST /orders/:id/short-close` — "ship what we have, forget the rest" (§7). In one transaction:
 *
 *   cancel the order's open challans (drafts and packed — nothing in them has left) → release every
 *   unit still reserved → `qtyCancelledBase += outstanding` on each line → PICKING / PACKED /
 *   PARTIALLY_DISPATCHED → CLOSED.
 *
 * The state machine refuses it when nothing has been dispatched — that is a cancel — and requires a
 * reason. Challans already on the road (DISPATCHED) are untouched: they shipped, and are billed.
 * Once closed, the order is complete: fulfilment COMPLETE, and billed for exactly what shipped.
 */
export async function shortCloseOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  input: OrderReasonInput,
): Promise<WholesaleOrderPayload> {
  const result = await withTransaction(async (session) => {
    const order = await WholesaleOrder.findOne({
      _id: id,
      orgId: actor.orgId,
      isDeleted: false,
    })
      .session(session)
      .lean();
    if (!order) throw ApiError.notFound('Order');
    assertCanSee(actor, order);

    await Dispatch.updateMany(
      { orgId: actor.orgId, orderId: id, status: { $in: ['DRAFT', 'PACKED'] } },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: actor.actorId,
          cancelReason: `Order short-closed: ${input.reason}`,
          updatedBy: actor.actorId,
        },
      },
      { session },
    );

    const held = reservationsOf(order, order.lines, (l) => l.qtyReservedBase);
    if (held.length > 0) await releaseReservation(session, { orgId: actor.orgId, lines: held });

    const lines = order.lines.map((l) => ({
      ...l,
      qtyCancelledBase: l.qtyCancelledBase + lineOutstanding(l),
      qtyReservedBase: 0,
    }));
    for (const l of lines) {
      const bad = lineInvariantViolation(l);
      if (bad) throw ApiError.internal(`Order line ${l.lineNo} after short close: ${bad}`);
    }
    await WholesaleOrder.updateOne(
      { _id: id, orgId: actor.orgId },
      { $set: { lines, updatedBy: actor.actorId } },
      { session },
    );
    // Last: a refusal (nothing dispatched yet, wrong status, no reason) rolls all of it back.
    return transitionOrder(actor, id, 'CLOSED', { session, reason: input.reason });
  });
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

/** `POST /orders/:id/close` — a delivered order is done. Nothing moves; the record is final. */
export async function closeOrder(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<WholesaleOrderPayload> {
  const result = await withTransaction((session) =>
    transitionOrder(actor, id, 'CLOSED', { session }),
  );
  const [payload] = await serialize(actor, [result]);
  return payload!;
}

/**
 * Orders per status, for the board's tabs — one `$group`, scoped like the list. Statuses with no
 * orders are reported as 0, so the board can draw every tab without guessing.
 */
export async function orderCounts(
  actor: RequestActor,
  query: { locationId?: string },
): Promise<OrderCounts> {
  const match: FilterQuery<WholesaleOrderDoc> = { orgId: actor.orgId, isDeleted: false };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) match.locationId = new Types.ObjectId(query.locationId);
  else if (scope) match.locationId = { $in: scope.map((x) => new Types.ObjectId(x)) };

  const rows = await WholesaleOrder.aggregate<{ _id: OrderStatus; n: number }>([
    { $match: match },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((st) => [st, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const r of rows) byStatus[r._id] = r.n;
  return { byStatus, total: rows.reduce((t, r) => t + r.n, 0) };
}
