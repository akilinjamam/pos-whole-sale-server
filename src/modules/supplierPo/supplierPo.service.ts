import { Types } from 'mongoose';

import {
  availablePoActions,
  canMovePo,
  poLineInvariantViolation,
  poLineOutstanding,
  poTotals,
  statusAfterReceipt,
} from '../../domain/poStateMachine.js';
import { computeTotals, PricingError } from '../../domain/pricing.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dayIn, dayToDate } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { resolveStockLines } from '../../services/stockLines.js';
import { applyPct } from '../../shared/money.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { Product } from '../product/product.model.js';
import { updateTouchesStatus } from '../wholesaleOrder/wholesaleOrder.model.js';

import { PO_TRANSITION_WRITE, PurchaseOrder } from './purchaseOrder.model.js';

import type { PoLineDoc, PoStatusHistoryDoc, PurchaseOrderDoc } from './purchaseOrder.model.js';
import type { ListPoQuery } from './supplierPo.schema.js';
import type { PoTransitionContext, PoTransitionVerdict } from '../../domain/poStateMachine.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { PartyDoc } from '../party/party.model.js';
import type { PoStatus } from '@shared/enums.js';
import type {
  CancelPoInput,
  CreatePoInput,
  PoLineInput,
  PoReasonInput,
  UpdatePoInput,
} from '@shared/purchasing.js';
import type { PageMeta, PurchaseOrderPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery, UpdateQuery } from 'mongoose';

/**
 * Purchase orders (Day 32): raised as a draft, approved (and numbered), sent to the supplier, then
 * received against by goods receipts (Day 33) until everything has come or the rest is written
 * off. Status moves only through `domain/poStateMachine.ts`, via `transitionPo` below.
 */

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

// ─── Transitions ────────────────────────────────────────────────────────────────────────

function contextOf(
  po: Pick<PurchaseOrderDoc, 'lines'>,
  actor: RequestActor,
  reason?: string | null,
): PoTransitionContext {
  const t = poTotals(po.lines);
  return {
    permissions: actor.user.permissions,
    lineCount: po.lines.length,
    receivedBase: t.receivedBase,
    outstandingBase: t.outstandingBase,
    reason: reason ?? null,
  };
}

function refusalToError(verdict: Extract<PoTransitionVerdict, { ok: false }>): ApiError {
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

type PoExtraSet = Partial<
  Pick<PurchaseOrderDoc, 'docNo' | 'approvedBy' | 'approvedAt' | 'sentAt'>
>;

/**
 * Move a PO to `to` — **the only writer of `status` and `statusHistory`**. Callers do their own
 * quantity work first, in the same session (a receipt `$inc`s `qtyReceivedBase`, a short close
 * sets `qtyCancelledBase`); this re-reads the PO so the machine judges what those writes left,
 * then writes the status and a history entry conditioned on the status it read.
 */
export async function transitionPo(
  actor: RequestActor,
  id: Types.ObjectId,
  to: PoStatus,
  opts: { session: ClientSession; reason?: string | null; set?: PoExtraSet },
): Promise<PurchaseOrderDoc> {
  const { session } = opts;
  const po = await PurchaseOrder.findOne({ _id: id, orgId: actor.orgId, isDeleted: false })
    .session(session)
    .lean();
  if (!po) throw ApiError.notFound('Purchase order');
  assertCanSee(actor, po);

  const reason = opts.reason?.trim() || null;
  const verdict = canMovePo(po.status, to, contextOf(po, actor, reason));
  if (!verdict.ok) throw refusalToError(verdict);
  if (opts.set && updateTouchesStatus(opts.set)) {
    throw new Error('transitionPo: `set` may not carry status or statusHistory');
  }

  const now = new Date();
  const entry: PoStatusHistoryDoc = {
    from: po.status,
    to,
    action: verdict.rule.action,
    at: now,
    by: actor.actorId,
    reason,
  };
  const $set: UpdateQuery<PurchaseOrderDoc>['$set'] = {
    ...opts.set,
    status: to,
    updatedBy: actor.actorId,
  };
  if (to === 'CANCELLED') {
    Object.assign($set, { cancelledAt: now, cancelledBy: actor.actorId, cancelReason: reason });
  }
  if (to === 'RECEIVED' || to === 'SHORT_CLOSED') {
    Object.assign($set, { closedAt: now, closedBy: actor.actorId });
  }
  // Reopened for changes: the approval was of what it said then.
  if (to === 'DRAFT') Object.assign($set, { approvedBy: null, approvedAt: null });

  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, orgId: actor.orgId, status: po.status },
    { $set, $push: { statusHistory: entry } },
    { new: true, session, ...PO_TRANSITION_WRITE },
  ).lean();
  if (!updated) {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      'The purchase order changed while you were working on it — reload and try again',
    );
  }
  return updated;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

/** Outside the caller's locations, a PO does not exist for them. */
function assertCanSee(actor: RequestActor, po: Pick<PurchaseOrderDoc, 'locationId'>): void {
  const scope = locationScopeOf(actor.user);
  if (scope && !scope.includes(String(po.locationId)))
    throw ApiError.notFound('Purchase order');
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function serialize(
  actor: RequestActor,
  docs: PurchaseOrderDoc[],
): Promise<PurchaseOrderPayload[]> {
  const ids = (pick: (d: PurchaseOrderDoc) => Types.ObjectId[]) => [
    ...new Set(docs.flatMap(pick).map(String)),
  ];
  const [suppliers, locations, products] = await Promise.all([
    Party.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.supplierPartyId]) } })
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
  const supplierName = new Map(suppliers.map((p) => [String(p._id), p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));
  const product = new Map(products.map((p) => [String(p._id), p]));
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const money = (n: number) => (seesCost ? n : null);

  return docs.map((d) => {
    const t = poTotals(d.lines);
    return {
      id: String(d._id),
      docNo: d.docNo,
      supplierPartyId: String(d.supplierPartyId),
      supplierName: supplierName.get(String(d.supplierPartyId)),
      locationId: String(d.locationId),
      locationName: locationName.get(String(d.locationId)),
      status: d.status,
      orderDate: d.orderDate.toISOString(),
      expectedDate: iso(d.expectedDate),
      lines: d.lines.map((l) => {
        const p = product.get(String(l.productId));
        return {
          id: String(l._id),
          lineNo: l.lineNo,
          productId: String(l.productId),
          variantId: l.variantId ? String(l.variantId) : null,
          productName: p?.name,
          sku: p?.sku,
          uomCode: l.uomCode,
          uomQty: l.uomQty,
          qtyBase: l.qtyBase,
          qtyReceivedBase: l.qtyReceivedBase,
          qtyCancelledBase: l.qtyCancelledBase,
          qtyOutstandingBase: poLineOutstanding(l),
          unitCostMinor: money(l.unitCostMinor),
          discountPct: l.discountPct,
          discountMinor: money(l.discountMinor),
          taxPct: l.taxPct,
          taxMinor: money(l.taxMinor),
          lineTotalMinor: money(l.lineTotalMinor),
        };
      }),
      costHidden: !seesCost,
      subtotalMinor: money(d.subtotalMinor),
      discountMinor: money(d.discountMinor),
      taxMinor: money(d.taxMinor),
      shippingMinor: money(d.shippingMinor),
      grandTotalMinor: money(d.grandTotalMinor),
      paymentTermsDays: d.paymentTermsDays,
      supplierRef: d.supplierRef,
      note: d.note,
      receivedRatio: t.orderedBase ? t.receivedBase / t.orderedBase : 0,
      approvedByUserId: d.approvedBy ? String(d.approvedBy) : null,
      approvedAt: iso(d.approvedAt),
      sentAt: iso(d.sentAt),
      cancelledAt: iso(d.cancelledAt),
      cancelReason: d.cancelReason,
      closedAt: iso(d.closedAt),
      statusHistory: d.statusHistory.map((h) => ({
        from: h.from,
        to: h.to,
        action: h.action,
        at: h.at.toISOString(),
        byUserId: h.by ? String(h.by) : null,
        reason: h.reason,
      })),
      availableActions: availablePoActions(d.status, contextOf(d, actor)),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  });
}

export async function listPos(
  actor: RequestActor,
  query: ListPoQuery,
): Promise<{ items: PurchaseOrderPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PurchaseOrderDoc> = { orgId: actor.orgId, isDeleted: false };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;
  if (query.supplierPartyId) filter.supplierPartyId = new Types.ObjectId(query.supplierPartyId);
  // The GRN screen's picker: POs that can still be received against.
  if (query.open) filter.status = { $in: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] };

  const { items, meta } = await paginate<PurchaseOrderDoc>(PurchaseOrder, {
    filter,
    query,
    sortable: ['orderDate', 'expectedDate', 'docNo', 'grandTotalMinor', 'createdAt'],
    searchFields: ['docNo', 'supplierRef', 'note'],
    defaultSort: { orderDate: -1, _id: -1 },
  });
  return { items: await serialize(actor, items), meta };
}

async function loadPo(
  actor: RequestActor,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<PurchaseOrderDoc> {
  const doc = await PurchaseOrder.findOne({ _id: id, orgId: actor.orgId, isDeleted: false })
    .session(session ?? null)
    .lean();
  if (!doc) throw ApiError.notFound('Purchase order');
  assertCanSee(actor, doc);
  return doc;
}

export async function getPo(actor: RequestActor, id: Types.ObjectId) {
  const [payload] = await serialize(actor, [await loadPo(actor, id)]);
  return payload!;
}

// ─── Drafts ─────────────────────────────────────────────────────────────────────────────

async function loadSupplier(actor: RequestActor, id: string): Promise<PartyDoc> {
  const party = await Party.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!party || !party.roles.includes('SUPPLIER')) {
    throw refuse('supplierPartyId', 'No such supplier');
  }
  if (!party.isActive) throw refuse('supplierPartyId', `${party.name} is inactive`);
  return party;
}

async function assertReceivingLocation(actor: RequestActor, id: string): Promise<void> {
  const loc = await Location.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!loc) throw refuse('locationId', 'No such location');
  if (!loc.isActive || !loc.allowsPurchase) {
    throw refuse('locationId', `${loc.name} does not receive purchases`);
  }
  assertLocationAllowed(actor.user, id);
}

/**
 * Lines as stored, with every total recomputed. Products, variants and units follow the same
 * rules as every stock document; tracked products are welcome — which lot or serials is a
 * receiving question (Day 33). A cost not given is the product's current one, in the line's unit.
 */
async function buildLines(
  actor: RequestActor,
  input: readonly PoLineInput[],
  previous: readonly PoLineDoc[] = [],
) {
  const resolved = await resolveStockLines(
    actor.orgId,
    input.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.qty,
    })),
    { requireCapture: false },
  );
  const products = await Product.find({
    orgId: actor.orgId,
    _id: { $in: resolved.map((l) => l.productId) },
  })
    .select('sku isActive avgCostMinor standardCostMinor')
    .lean();
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const before = new Map(
    previous.map((l) => [`${String(l.productId)}|${String(l.variantId)}`, l]),
  );

  const draft = input.map((line, i) => {
    const r = resolved[i]!;
    const p = productBy.get(String(r.productId))!;
    if (!p.isActive) throw refuse(`lines.${i}.productId`, `${p.sku} is inactive`);
    const perUnit = (p.avgCostMinor || p.standardCostMinor) * (r.qtyBase / r.qty);
    const unitCostMinor = line.unitCostMinor ?? Math.round(perUnit);
    const discountPct = line.discountPct ?? 0;
    return { r, unitCostMinor, discountPct };
  });

  let totals;
  try {
    totals = computeTotals(
      draft.map((d) => ({
        unitPriceMinor: d.unitCostMinor,
        qty: d.r.qty,
        lineDiscountMinor: applyPct(d.unitCostMinor * d.r.qty, d.discountPct),
      })),
      { kind: 'NONE' },
    );
  } catch (error) {
    if (error instanceof PricingError) {
      throw refuse(error.field.replace('unitPriceMinor', 'unitCostMinor'), error.message);
    }
    throw error;
  }

  const lines = draft.map((d, i): Omit<PoLineDoc, '_id'> & { _id?: Types.ObjectId } => {
    const t = totals.lines[i]!;
    const was = before.get(`${String(d.r.productId)}|${String(d.r.variantId ?? null)}`);
    return {
      // Keep a line's id across edits, so anything pointing at it keeps pointing at it.
      ...(was ? { _id: was._id } : {}),
      lineNo: i + 1,
      productId: d.r.productId,
      variantId: d.r.variantId ?? null,
      uomCode: d.r.uomCode,
      uomQty: d.r.qty,
      qtyBase: d.r.qtyBase,
      qtyReceivedBase: 0,
      qtyCancelledBase: 0,
      unitCostMinor: d.unitCostMinor,
      discountPct: d.discountPct,
      discountMinor: t.lineDiscountMinor,
      taxPct: 0,
      taxMinor: 0,
      lineTotalMinor: t.netMinor,
    };
  });
  return {
    lines,
    subtotalMinor: totals.grossMinor,
    discountMinor: totals.lineDiscountMinor,
    taxMinor: 0,
    netMinor: totals.totalMinor,
  };
}

async function orgZone(actor: RequestActor): Promise<string> {
  return (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
}

const addDays = (day: string, n: number) =>
  new Date(dayToDate(day)!.getTime() + n * 86_400_000);

export async function createPo(
  actor: RequestActor,
  input: CreatePoInput,
): Promise<PurchaseOrderPayload> {
  const [supplier] = await Promise.all([
    loadSupplier(actor, input.supplierPartyId),
    assertReceivingLocation(actor, input.locationId),
  ]);
  const built = await buildLines(actor, input.lines);
  const orderDay = input.orderDate ?? dayIn(new Date(), await orgZone(actor));
  const lead = supplier.supplier?.leadTimeDays ?? 0;
  const shippingMinor = input.shippingMinor ?? 0;

  const doc = await PurchaseOrder.create({
    orgId: actor.orgId,
    supplierPartyId: supplier._id,
    locationId: new Types.ObjectId(input.locationId),
    orderDate: dayToDate(orderDay),
    expectedDate:
      input.expectedDate !== undefined
        ? dayToDate(input.expectedDate)
        : lead > 0
          ? addDays(orderDay, lead)
          : null,
    lines: built.lines,
    subtotalMinor: built.subtotalMinor,
    discountMinor: built.discountMinor,
    taxMinor: built.taxMinor,
    shippingMinor,
    grandTotalMinor: built.netMinor + shippingMinor,
    paymentTermsDays: input.paymentTermsDays ?? supplier.supplier?.paymentTermsDays ?? 0,
    supplierRef: input.supplierRef ?? null,
    note: input.note ?? null,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  });
  const [payload] = await serialize(actor, [doc.toObject()]);
  return payload!;
}

const onlyDraft = (po: Pick<PurchaseOrderDoc, 'docNo' | 'status'>, verb: string) =>
  ApiError.conflict(
    'ILLEGAL_TRANSITION',
    `${po.docNo ?? 'This purchase order'} is ${po.status} — only a draft can be ${verb}`,
  );

export async function updatePo(
  actor: RequestActor,
  id: Types.ObjectId,
  input: UpdatePoInput,
): Promise<PurchaseOrderPayload> {
  const po = await loadPo(actor, id);
  if (po.status !== 'DRAFT') throw onlyDraft(po, 'changed');

  const $set: Record<string, unknown> = { updatedBy: actor.actorId };
  let supplier: PartyDoc | null = null;
  if (input.supplierPartyId !== undefined) {
    supplier = await loadSupplier(actor, input.supplierPartyId);
    $set.supplierPartyId = supplier._id;
    if (input.paymentTermsDays === undefined) {
      $set.paymentTermsDays = supplier.supplier?.paymentTermsDays ?? 0;
    }
  }
  if (input.locationId !== undefined) {
    await assertReceivingLocation(actor, input.locationId);
    $set.locationId = new Types.ObjectId(input.locationId);
  }
  if (input.lines !== undefined || input.shippingMinor !== undefined) {
    const built = input.lines
      ? await buildLines(actor, input.lines, po.lines)
      : {
          lines: po.lines,
          subtotalMinor: po.subtotalMinor,
          discountMinor: po.discountMinor,
          taxMinor: po.taxMinor,
          netMinor: po.subtotalMinor - po.discountMinor + po.taxMinor,
        };
    const shippingMinor = input.shippingMinor ?? po.shippingMinor;
    Object.assign($set, {
      lines: built.lines,
      subtotalMinor: built.subtotalMinor,
      discountMinor: built.discountMinor,
      taxMinor: built.taxMinor,
      shippingMinor,
      grandTotalMinor: built.netMinor + shippingMinor,
    });
  }
  if (input.orderDate !== undefined) $set.orderDate = dayToDate(input.orderDate);
  if (input.expectedDate !== undefined) $set.expectedDate = dayToDate(input.expectedDate);
  if (input.paymentTermsDays !== undefined) $set.paymentTermsDays = input.paymentTermsDays;
  if (input.supplierRef !== undefined) $set.supplierRef = input.supplierRef;
  if (input.note !== undefined) $set.note = input.note;

  // Conditioned on DRAFT: an approval that lands between our read and this write wins; we 409.
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, orgId: actor.orgId, status: 'DRAFT' },
    { $set },
    { new: true },
  ).lean();
  if (!updated) throw onlyDraft(await loadPo(actor, id), 'changed');
  const [payload] = await serialize(actor, [updated]);
  return payload!;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────────────

async function serializeOne(actor: RequestActor, doc: PurchaseOrderDoc) {
  const [payload] = await serialize(actor, [doc]);
  return payload!;
}

/**
 * `POST /purchase-orders/:id/approve` — the PO becomes a commitment: it takes its number (dated by
 * the order date, so the series' period is the PO's own) and records who approved it. A PO reopened
 * and approved again keeps the number it already had.
 */
export async function approvePo(actor: RequestActor, id: Types.ObjectId) {
  const doc = await withTransaction(async (session) => {
    const po = await loadPo(actor, id, session);
    const supplier = await Party.findById(po.supplierPartyId).session(session).lean();
    if (!supplier?.isActive) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `${supplier?.name ?? 'The supplier'} is inactive — reactivate them or change the supplier`,
      );
    }
    const docNo = po.docNo ?? (await nextDocNo(session, actor.orgId, 'PO', po.orderDate));
    return transitionPo(actor, id, 'APPROVED', {
      session,
      set: { docNo, approvedBy: actor.actorId, approvedAt: new Date() },
    });
  });
  return serializeOne(actor, doc);
}

/** `POST /purchase-orders/:id/send` — it has gone to the supplier (email, WhatsApp, by hand). */
export async function sendPo(actor: RequestActor, id: Types.ObjectId) {
  const doc = await withTransaction((session) =>
    transitionPo(actor, id, 'SENT', { session, set: { sentAt: new Date() } }),
  );
  return serializeOne(actor, doc);
}

/** `POST /purchase-orders/:id/reopen` — back to a draft to change; it needs approving again. */
export async function reopenPo(actor: RequestActor, id: Types.ObjectId, input: PoReasonInput) {
  const doc = await withTransaction((session) =>
    transitionPo(actor, id, 'DRAFT', { session, reason: input.reason }),
  );
  return serializeOne(actor, doc);
}

/** `POST /purchase-orders/:id/cancel` — only while nothing has been received against it. */
export async function cancelPo(actor: RequestActor, id: Types.ObjectId, input: CancelPoInput) {
  const doc = await withTransaction((session) =>
    transitionPo(actor, id, 'CANCELLED', { session, reason: input.reason ?? null }),
  );
  return serializeOne(actor, doc);
}

/**
 * `POST /purchase-orders/:id/short-close` — "the rest is not coming": what is outstanding on each
 * line moves to `qtyCancelledBase`, then the PO closes. Received stays received.
 */
export async function shortClosePo(
  actor: RequestActor,
  id: Types.ObjectId,
  input: PoReasonInput,
) {
  const doc = await withTransaction(async (session) => {
    const po = await loadPo(actor, id, session);
    const lines = po.lines.map((l) => ({
      ...l,
      qtyCancelledBase: l.qtyCancelledBase + poLineOutstanding(l),
    }));
    // Conditioned on the status we read: a receipt posting meanwhile makes this a WriteConflict
    // (retried) or a 409 from the transition, never a cancel of goods that just arrived.
    await PurchaseOrder.updateOne(
      { _id: po._id, orgId: actor.orgId, status: po.status },
      { $set: { lines, updatedBy: actor.actorId } },
      { session },
    );
    return transitionPo(actor, id, 'SHORT_CLOSED', { session, reason: input.reason });
  });
  return serializeOne(actor, doc);
}

// ─── Receipts (Day 33's hook) ───────────────────────────────────────────────────────────

export interface PoReceiptLine {
  poLineId: Types.ObjectId;
  qtyBase: number;
  /** When given, must match the PO line — the GRN line is for the item the PO ordered. */
  productId?: Types.ObjectId;
  variantId?: Types.ObjectId | null;
}

/**
 * Record goods received against a PO — called by a posted goods receipt (Day 33), inside its
 * transaction, never on its own. In order:
 *
 *   1. the PO must be receivable (approved, sent or part-received) and in the caller's locations;
 *   2. every receipt line must name one of its lines, for that item, and not take the line past
 *      what is outstanding — over-receipt is refused, not silently absorbed;
 *   3. `$inc` each line's `qtyReceivedBase`, conditioned on the value read — so two receipts racing
 *      for the last units cannot both land;
 *   4. move the status where the receipt leaves it: PARTIALLY_RECEIVED or RECEIVED.
 *
 * Any refusal throws, and the caller's transaction — stock, cost, ledger — rolls back with it.
 */
export async function recordPoReceipt(
  session: ClientSession,
  actor: RequestActor,
  poId: Types.ObjectId,
  receipt: readonly PoReceiptLine[],
): Promise<PurchaseOrderDoc> {
  const po = await loadPo(actor, poId, session);
  if (!['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      `${po.docNo ?? 'This purchase order'} is ${po.status} — nothing can be received against it`,
    );
  }

  const byLine = new Map(po.lines.map((l) => [String(l._id), l]));
  const adding = new Map<string, number>();
  receipt.forEach((r, i) => {
    const line = byLine.get(String(r.poLineId));
    if (!line) throw refuse(`lines.${i}.poLineId`, `Not a line of ${po.docNo}`);
    if (r.productId && !r.productId.equals(line.productId)) {
      throw refuse(
        `lines.${i}.productId`,
        `Line ${line.lineNo} of ${po.docNo} is another item`,
      );
    }
    if (
      r.variantId !== undefined &&
      String(r.variantId ?? null) !== String(line.variantId ?? null)
    ) {
      throw refuse(
        `lines.${i}.variantId`,
        `Line ${line.lineNo} of ${po.docNo} is another variant`,
      );
    }
    if (!Number.isInteger(r.qtyBase) || r.qtyBase < 1) {
      throw refuse(`lines.${i}.qtyBase`, 'A whole quantity of 1 or more');
    }
    adding.set(String(line._id), (adding.get(String(line._id)) ?? 0) + r.qtyBase);
  });
  for (const [lineId, qty] of adding) {
    const line = byLine.get(lineId)!;
    const left = poLineOutstanding(line);
    if (qty > left) {
      const i = receipt.findIndex((r) => String(r.poLineId) === lineId);
      throw refuse(
        `lines.${i}.qtyBase`,
        `Line ${line.lineNo} of ${po.docNo} has ${left} still to come — ${qty} is more than was ordered`,
      );
    }
  }

  for (const [lineId, qty] of adding) {
    const line = byLine.get(lineId)!;
    const res = await PurchaseOrder.updateOne(
      {
        _id: po._id,
        orgId: actor.orgId,
        status: po.status,
        lines: { $elemMatch: { _id: line._id, qtyReceivedBase: line.qtyReceivedBase } },
      },
      {
        $inc: { 'lines.$[l].qtyReceivedBase': qty },
        $set: { updatedBy: actor.actorId },
      },
      { session, arrayFilters: [{ 'l._id': line._id }] },
    );
    if (res.modifiedCount !== 1) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `${po.docNo} was received against at the same moment — reload and try again`,
      );
    }
    const after = { ...line, qtyReceivedBase: line.qtyReceivedBase + qty };
    const bad = poLineInvariantViolation(after);
    if (bad) throw ApiError.internal(`PO line ${line.lineNo} after receipt: ${bad}`);
    byLine.set(lineId, after);
  }

  return transitionPo(actor, poId, statusAfterReceipt([...byLine.values()]), { session });
}
