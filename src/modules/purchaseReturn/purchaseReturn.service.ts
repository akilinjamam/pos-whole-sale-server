import { Types } from 'mongoose';

import { paymentStatusOf } from '../../domain/allocation.js';
import { movingAverageOut } from '../../domain/costing.js';
import { returnValueMinor } from '../../domain/returns.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dateToDay, dayIn, dayToDate } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { postMovements } from '../../services/stock.service.js';
import {
  assertStockLocation,
  lineNames,
  resolveStockLines,
  trackingFor,
} from '../../services/stockLines.js';
import { roundHalfUp } from '../../shared/money.js';
import { GoodsReceipt } from '../goodsReceipt/goodsReceipt.model.js';
import { itemCost, setAverageCost } from '../goodsReceipt/goodsReceipt.service.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';

import { PurchaseReturn } from './purchaseReturn.model.js';

import type { PurchaseReturnDoc, PurchaseReturnLineDoc } from './purchaseReturn.model.js';
import type { ListPurchaseReturnQuery } from './purchaseReturn.schema.js';
import type { CostedStock } from '../../domain/costing.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { GoodsReceiptDoc, GrnLineDoc } from '../goodsReceipt/goodsReceipt.model.js';
import type { CreatePurchaseReturnInput } from '@shared/purchasing.js';
import type { ApiFieldError, PageMeta, PurchaseReturnPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Purchase returns (Day 34): goods going back to the supplier, posted as they are entered.
 *
 * In one transaction: the stock goes OUT (`PURCHASE_RETURN`; serial units become RETURNED), each
 * item's moving average is re-blended without it (`domain/costing.movingAverageOut`), the receipt
 * line remembers how much of it has gone back, and the supplier's ledger is debited — they owe us
 * that much, or we owe them that much less. The PO is not touched: it was received; what happened
 * to the goods afterwards is this document's story, not the order's.
 */

const REF_TYPE = 'PURCHASE_RETURN';

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);
const itemKey = (productId: Types.ObjectId, variantId: Types.ObjectId | null) =>
  `${String(productId)}|${String(variantId ?? null)}`;

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

async function serialize(
  actor: RequestActor,
  docs: PurchaseReturnDoc[],
): Promise<PurchaseReturnPayload[]> {
  const ids = (pick: (d: PurchaseReturnDoc) => (Types.ObjectId | null)[]) => [
    ...new Set(docs.flatMap(pick).flatMap((id) => (id ? [String(id)] : []))),
  ];
  const [suppliers, locations, grns, names] = await Promise.all([
    Party.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.supplierPartyId]) } })
      .select('name')
      .lean(),
    Location.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.locationId]) } })
      .select('name')
      .lean(),
    GoodsReceipt.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.grnId]) } })
      .select('docNo')
      .lean(),
    lineNames(
      actor.orgId,
      docs.flatMap((d) => d.lines),
    ),
  ]);
  const supplierName = new Map(suppliers.map((p) => [String(p._id), p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));
  const grnDocNo = new Map(grns.map((g) => [String(g._id), g.docNo]));
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const money = (n: number) => (seesCost ? n : null);

  return docs.map((d) => ({
    id: String(d._id),
    docNo: d.docNo,
    grnId: d.grnId ? String(d.grnId) : null,
    grnDocNo: d.grnId ? (grnDocNo.get(String(d.grnId)) ?? null) : null,
    supplierPartyId: String(d.supplierPartyId),
    supplierName: supplierName.get(String(d.supplierPartyId)),
    locationId: String(d.locationId),
    locationName: locationName.get(String(d.locationId)),
    status: d.status,
    returnDate: dateToDay(d.returnDate)!,
    reason: d.reason,
    note: d.note,
    lines: d.lines.map((l) => {
      const n = names(l);
      return {
        lineNo: l.lineNo,
        grnLineNo: l.grnLineNo,
        productId: String(l.productId),
        variantId: l.variantId ? String(l.variantId) : null,
        productName: n.productName,
        sku: n.sku,
        variantLabel: n.variantLabel ?? null,
        uomCode: l.uomCode,
        qty: l.qty,
        qtyBase: l.qtyBase,
        unitCostMinor: money(l.unitCostMinor),
        lineTotalMinor: money(l.lineTotalMinor),
        lotNo: l.lotNo,
        serials: l.serials,
      };
    }),
    costHidden: !seesCost,
    totalMinor: money(d.totalMinor),
    appliedMinor: money(d.appliedMinor ?? 0),
    unappliedMinor: money(d.unappliedMinor ?? 0),
    postedAt: d.postedAt.toISOString(),
    postedByUserId: d.postedBy ? String(d.postedBy) : null,
    createdAt: d.createdAt.toISOString(),
  }));
}

export async function listPurchaseReturns(
  actor: RequestActor,
  query: ListPurchaseReturnQuery,
): Promise<{ items: PurchaseReturnPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PurchaseReturnDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.supplierPartyId) filter.supplierPartyId = new Types.ObjectId(query.supplierPartyId);
  if (query.grnId) filter.grnId = new Types.ObjectId(query.grnId);
  const { items, meta } = await paginate<PurchaseReturnDoc>(PurchaseReturn, {
    filter,
    query,
    sortable: ['returnDate', 'docNo', 'totalMinor', 'createdAt'],
    searchFields: ['docNo', 'note'],
    defaultSort: { returnDate: -1, _id: -1 },
  });
  return { items: await serialize(actor, items), meta };
}

export async function getPurchaseReturn(actor: RequestActor, id: Types.ObjectId) {
  const r = await PurchaseReturn.findOne({ _id: id, orgId: actor.orgId }).lean();
  const scope = locationScopeOf(actor.user);
  if (!r || (scope && !scope.includes(String(r.locationId)))) {
    throw ApiError.notFound('Purchase return');
  }
  const [payload] = await serialize(actor, [r]);
  return payload!;
}

// ─── Posting ────────────────────────────────────────────────────────────────────────────

/**
 * `POST /purchase-returns` — the goods leave, in one transaction. Against a posted receipt each
 * line names the receipt line it returns, never more than is left of it, from its own lot and
 * serials, valued at that line's net cost. A direct return is valued at the item's current cost,
 * or at what someone who may see costs types.
 */
export async function createPurchaseReturn(
  actor: RequestActor,
  input: CreatePurchaseReturnInput,
): Promise<PurchaseReturnPayload> {
  const id = await withTransaction((session) => postInSession(session, actor, input));
  return getPurchaseReturn(actor, id);
}

async function loadReturnableGrn(
  session: ClientSession,
  actor: RequestActor,
  id: string,
): Promise<GoodsReceiptDoc> {
  const g = await GoodsReceipt.findOne({ _id: id, orgId: actor.orgId }).session(session).lean();
  const scope = locationScopeOf(actor.user);
  if (!g || (scope && !scope.includes(String(g.locationId)))) {
    throw refuse('grnId', 'No such goods receipt');
  }
  if (g.status !== 'POSTED') {
    throw refuse(
      'grnId',
      `${g.docNo ?? 'That receipt'} is ${g.status.toLowerCase()} — only goods received can go back`,
    );
  }
  return g;
}

async function postInSession(
  session: ClientSession,
  actor: RequestActor,
  input: CreatePurchaseReturnInput,
): Promise<Types.ObjectId> {
  const grn = input.grnId ? await loadReturnableGrn(session, actor, input.grnId) : null;
  if (grn && input.supplierPartyId && !grn.supplierPartyId.equals(input.supplierPartyId)) {
    throw refuse('supplierPartyId', `${grn.docNo} is from another supplier`);
  }
  const supplierId = grn ? grn.supplierPartyId : new Types.ObjectId(input.supplierPartyId);
  const supplier = await Party.findOne({ _id: supplierId, orgId: actor.orgId })
    .session(session)
    .lean();
  if (!supplier || !supplier.roles.includes('SUPPLIER')) {
    throw refuse('supplierPartyId', 'No such supplier');
  }
  const locationId = input.locationId ?? String(grn!.locationId);
  await assertStockLocation(actor.orgId, locationId, 'locationId');
  assertLocationAllowed(actor.user, locationId);

  // ── The lines: which receipt line each returns, and what it brings with it ──
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const errors: ApiFieldError[] = [];
  const grnLineOf: (GrnLineDoc | null)[] = [];
  const lotNos: (string | null)[] = [];
  // As the schema would leave them — the service is also called without it.
  const inputLines = input.lines.map((l) => ({
    ...l,
    lotNo: l.lotNo?.trim().toUpperCase() || null,
    serials: l.serials?.map((s) => s.trim().toUpperCase()),
  }));
  for (const [i, line] of inputLines.entries()) {
    const at = (f: string) => `lines.${i}.${f}`;
    grnLineOf.push(null);
    lotNos.push(line.lotNo ?? null);
    if (!grn) {
      if (line.grnLineNo)
        errors.push({ path: at('grnLineNo'), message: 'A direct return has no receipt lines' });
      if (line.unitCostMinor !== undefined && !seesCost) {
        errors.push({
          path: at('unitCostMinor'),
          message: 'You need stock:viewCost to enter a cost',
        });
      }
      continue;
    }
    const gl = line.grnLineNo ? grn.lines.find((l) => l.lineNo === line.grnLineNo) : undefined;
    if (!gl) {
      errors.push({
        path: at('grnLineNo'),
        message: line.grnLineNo
          ? `${grn.docNo} has no line ${line.grnLineNo}`
          : `Which line of ${grn.docNo} is going back?`,
      });
      continue;
    }
    if (gl.qcStatus !== 'OK') {
      errors.push({
        path: at('grnLineNo'),
        message: `Line ${gl.lineNo} was refused as damaged — it never came into stock`,
      });
      continue;
    }
    if (
      !gl.productId.equals(line.productId) ||
      String(gl.variantId) !== String(line.variantId ?? null)
    ) {
      errors.push({
        path: at('productId'),
        message: `Line ${gl.lineNo} of ${grn.docNo} is another item`,
      });
      continue;
    }
    if (line.unitCostMinor !== undefined) {
      errors.push({ path: at('unitCostMinor'), message: `The cost comes from ${grn.docNo}` });
      continue;
    }
    if (line.lotNo && gl.lotNo && line.lotNo !== gl.lotNo) {
      errors.push({
        path: at('lotNo'),
        message: `Line ${gl.lineNo} came in as lot ${gl.lotNo}`,
      });
      continue;
    }
    const strangers = (line.serials ?? []).filter((s) => !gl.serials.includes(s));
    if (strangers.length > 0) {
      errors.push({
        path: at('serials'),
        message: `Not received on line ${gl.lineNo} of ${grn.docNo}: ${strangers.join(', ')}`,
      });
      continue;
    }
    grnLineOf[i] = gl;
    lotNos[i] = line.lotNo ?? gl.lotNo;
  }
  if (errors.length > 0) throw ApiError.validation('Validation failed', errors);

  const resolved = await resolveStockLines(
    actor.orgId,
    inputLines.map((l, i) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.qty,
      lotNo: lotNos[i],
      serials: l.serials,
    })),
    { requireCapture: true },
  );

  // ── Values: the receipt line's own net cost, or the item's cost today ──
  const takenFrom = new Map<number, number>();
  const lines: PurchaseReturnLineDoc[] = [];
  for (const [i, r] of resolved.entries()) {
    const gl = grnLineOf[i];
    const line = inputLines[i]!;
    let lineTotalMinor: number;
    let unitCostMinor: number;
    if (gl) {
      const before = gl.qtyReturnedBase + (takenFrom.get(gl.lineNo) ?? 0);
      if (before + r.qtyBase > gl.qtyBase) {
        errors.push({
          path: `lines.${i}.qty`,
          message: `Line ${gl.lineNo} of ${grn!.docNo} has ${gl.qtyBase - before} left to return`,
        });
        continue;
      }
      takenFrom.set(gl.lineNo, (takenFrom.get(gl.lineNo) ?? 0) + r.qtyBase);
      lineTotalMinor = returnValueMinor({ ...gl, qtyReturnedBase: before }, r.qtyBase);
      unitCostMinor = roundHalfUp(lineTotalMinor / r.qty);
    } else {
      unitCostMinor =
        line.unitCostMinor ??
        roundHalfUp(
          (await itemCost(actor.orgId, r.productId, r.variantId, session)).avgCostMinor *
            (r.qtyBase / r.qty),
        );
      lineTotalMinor = unitCostMinor * r.qty;
    }
    lines.push({
      lineNo: i + 1,
      grnLineNo: gl?.lineNo ?? null,
      productId: r.productId,
      variantId: r.variantId,
      uomCode: r.uomCode,
      qty: r.qty,
      qtyBase: r.qtyBase,
      unitCostMinor,
      lineTotalMinor,
      lotNo: r.lotNo,
      serials: r.serials,
    });
  }
  if (errors.length > 0) throw ApiError.validation('Validation failed', errors);
  const totalMinor = lines.reduce((t, l) => t + l.lineTotalMinor, 0);
  // Against a receipt, the debit note comes off that bill — as far as anything is left to pay on
  // it. The rest (a bill already paid) is credit on the supplier's account.
  const appliedMinor = grn ? Math.min(totalMinor, grn.balanceMinor) : 0;

  // ── Number, and costs before anything moves ──
  const org = await Org.findById(actor.orgId).select('timeZone').session(session).lean();
  const postedAt = new Date();
  const returnDate = dayToDate(
    input.returnDate ?? dayIn(postedAt, org?.timeZone ?? 'Asia/Dhaka'),
  )!;
  const docNo = await nextDocNo(session, actor.orgId, 'DN', returnDate);
  const before = new Map<string, CostedStock>();
  for (const l of lines) {
    const k = itemKey(l.productId, l.variantId);
    if (!before.has(k))
      before.set(k, await itemCost(actor.orgId, l.productId, l.variantId, session));
  }

  const [doc] = await PurchaseReturn.create(
    [
      {
        orgId: actor.orgId,
        docNo,
        grnId: grn?._id ?? null,
        supplierPartyId: supplierId,
        locationId: new Types.ObjectId(locationId),
        status: 'POSTED',
        returnDate,
        reason: input.reason,
        note: input.note ?? null,
        lines,
        totalMinor,
        appliedMinor,
        unappliedMinor: totalMinor - appliedMinor,
        postedAt,
        postedBy: actor.actorId,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      },
    ],
    { session },
  );

  // ── Stock out ──
  const movements = [];
  for (const [i, l] of lines.entries()) {
    movements.push({
      locationId: doc!.locationId,
      productId: l.productId,
      variantId: l.variantId,
      qtyBase: -l.qtyBase,
      movementType: 'PURCHASE_RETURN' as const,
      refType: REF_TYPE,
      refId: doc!._id,
      refDocNo: docNo,
      unitCostMinor: roundHalfUp(l.lineTotalMinor / l.qtyBase),
      narration: `To ${supplier.name}${grn ? `, from ${grn.docNo}` : ''}`,
      ...(await trackingFor(session, actor.orgId, resolved[i]!, 'OUT', actor.actorId)),
    });
  }
  await postMovements(session, {
    orgId: actor.orgId,
    postedAt,
    actorId: actor.actorId,
    movements,
  });

  // ── Moving average, without what left ──
  const leaving = new Map<
    string,
    { productId: Types.ObjectId; variantId: Types.ObjectId | null; qty: number; value: number }
  >();
  for (const l of lines) {
    const k = itemKey(l.productId, l.variantId);
    const a = leaving.get(k) ?? {
      productId: l.productId,
      variantId: l.variantId,
      qty: 0,
      value: 0,
    };
    a.qty += l.qtyBase;
    a.value += l.lineTotalMinor;
    leaving.set(k, a);
  }
  for (const [k, a] of leaving) {
    await setAverageCost(
      session,
      actor.orgId,
      a.productId,
      a.variantId,
      movingAverageOut(before.get(k)!, a.qty, a.value),
    );
  }

  // ── The receipt remembers ── guarded, so two returns racing cannot exceed what came in.
  for (const [lineNo, qty] of takenFrom) {
    const gl = grn!.lines.find((l) => l.lineNo === lineNo)!;
    const { modifiedCount } = await GoodsReceipt.updateOne(
      {
        _id: grn!._id,
        status: 'POSTED',
        lines: { $elemMatch: { lineNo, qtyReturnedBase: { $lte: gl.qtyBase - qty } } },
      },
      { $inc: { 'lines.$[l].qtyReturnedBase': qty } },
      { arrayFilters: [{ 'l.lineNo': lineNo }], session },
    );
    if (modifiedCount !== 1) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `Line ${lineNo} of ${grn!.docNo} was returned by someone else meanwhile — reload and try again`,
      );
    }
  }

  // ── The bill follows ── guarded like a payment: the bill can never go below zero.
  if (appliedMinor > 0) {
    const g = await GoodsReceipt.findOneAndUpdate(
      { _id: grn!._id, status: 'POSTED', balanceMinor: { $gte: appliedMinor } },
      { $inc: { creditedMinor: appliedMinor, balanceMinor: -appliedMinor } },
      { new: true, session },
    ).lean();
    if (!g) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `${grn!.docNo} was paid meanwhile — reload and try again`,
      );
    }
    const paymentStatus = paymentStatusOf(g.grandTotalMinor, g.paidMinor, g.creditedMinor);
    if (paymentStatus !== g.paymentStatus) {
      await GoodsReceipt.updateOne({ _id: g._id }, { $set: { paymentStatus } }, { session });
    }
  }

  // ── The supplier's ledger ──
  if (totalMinor > 0) {
    await postLedgerEntries(session, {
      orgId: actor.orgId,
      postedAt,
      actorId: actor.actorId,
      entries: [
        {
          partyId: supplierId,
          docType: 'DEBIT_NOTE',
          refType: REF_TYPE,
          refId: doc!._id,
          refDocNo: docNo,
          debitMinor: totalMinor,
          narration: grn
            ? `Goods returned from ${grn.docNo}${grn.supplierInvoiceNo ? ` (bill ${grn.supplierInvoiceNo})` : ''}`
            : 'Goods returned',
        },
      ],
    });
  }
  return doc!._id;
}
