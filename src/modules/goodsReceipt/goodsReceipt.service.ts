import { mongo, Types } from 'mongoose';

import { currentCost, landedValues, movingAverage } from '../../domain/costing.js';
import { poLineOutstanding } from '../../domain/poStateMachine.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dateToDay, dayIn, dayToDate } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { postMovements } from '../../services/stock.service.js';
import { lineNames, resolveStockLines, trackingFor } from '../../services/stockLines.js';
import { applyPct, roundHalfUp } from '../../shared/money.js';
import { Location } from '../location/location.model.js';
import { Lot } from '../lot/lot.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { Product } from '../product/product.model.js';
import { SerialUnit } from '../serialUnit/serialUnit.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';
import { PurchaseOrder } from '../supplierPo/purchaseOrder.model.js';
import { recordPoReceipt } from '../supplierPo/supplierPo.service.js';
import { Variant } from '../variant/variant.model.js';

import { GoodsReceipt } from './goodsReceipt.model.js';

import type { GoodsReceiptDoc, GrnLineDoc } from './goodsReceipt.model.js';
import type { ListGrnQuery } from './goodsReceipt.schema.js';
import type { CostedStock } from '../../domain/costing.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { PartyDoc } from '../party/party.model.js';
import type { PurchaseOrderDoc } from '../supplierPo/purchaseOrder.model.js';
import type {
  CancelGrnInput,
  CreateGrnInput,
  GrnLineInput,
  UpdateGrnInput,
} from '@shared/purchasing.js';
import type { ApiFieldError, GoodsReceiptPayload, PageMeta } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Goods receipts (Day 33). A draft records what is at the door; posting it brings the goods into
 * stock, re-costs them, moves the PO and puts the supplier's bill on their ledger — in one
 * transaction, so all of that happens or none of it does.
 */

const REF_TYPE = 'GRN';
const RECEIVABLE: readonly PurchaseOrderDoc['status'][] = [
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
];

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);
const itemKey = (productId: Types.ObjectId, variantId: Types.ObjectId | null) =>
  `${String(productId)}|${String(variantId ?? null)}`;

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

function assertCanSee(actor: RequestActor, g: Pick<GoodsReceiptDoc, 'locationId'>): void {
  const scope = locationScopeOf(actor.user);
  if (scope && !scope.includes(String(g.locationId))) throw ApiError.notFound('Goods receipt');
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function serialize(
  actor: RequestActor,
  docs: GoodsReceiptDoc[],
): Promise<GoodsReceiptPayload[]> {
  const ids = (pick: (d: GoodsReceiptDoc) => (Types.ObjectId | null)[]) => [
    ...new Set(docs.flatMap(pick).flatMap((id) => (id ? [String(id)] : []))),
  ];
  const [suppliers, locations, pos, names] = await Promise.all([
    Party.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.supplierPartyId]) } })
      .select('name')
      .lean(),
    Location.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.locationId]) } })
      .select('name')
      .lean(),
    PurchaseOrder.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.poId]) } })
      .select('docNo')
      .lean(),
    lineNames(
      actor.orgId,
      docs.flatMap((d) => d.lines),
    ),
  ]);
  const supplierName = new Map(suppliers.map((p) => [String(p._id), p.name]));
  const locationName = new Map(locations.map((l) => [String(l._id), l.name]));
  const poDocNo = new Map(pos.map((p) => [String(p._id), p.docNo]));
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const money = <T extends number | null>(n: T) => (seesCost ? n : null);

  return docs.map((d) => ({
    id: String(d._id),
    docNo: d.docNo,
    poId: d.poId ? String(d.poId) : null,
    poDocNo: d.poId ? (poDocNo.get(String(d.poId)) ?? null) : null,
    supplierPartyId: String(d.supplierPartyId),
    supplierName: supplierName.get(String(d.supplierPartyId)),
    locationId: String(d.locationId),
    locationName: locationName.get(String(d.locationId)),
    status: d.status,
    receivedAt: d.receivedAt.toISOString(),
    supplierInvoiceNo: d.supplierInvoiceNo,
    supplierInvoiceDate: dateToDay(d.supplierInvoiceDate),
    lines: d.lines.map((l) => {
      const n = names(l);
      return {
        lineNo: l.lineNo,
        poLineId: l.poLineId ? String(l.poLineId) : null,
        productId: String(l.productId),
        variantId: l.variantId ? String(l.variantId) : null,
        productName: n.productName,
        sku: n.sku,
        variantLabel: n.variantLabel ?? null,
        uomCode: l.uomCode,
        qty: l.qty,
        qtyBase: l.qtyBase,
        unitCostMinor: money(l.unitCostMinor),
        discountPct: l.discountPct,
        lineTotalMinor: money(l.lineTotalMinor),
        landedUnitCostMinor: money(l.landedUnitCostMinor),
        lotNo: l.lotNo,
        mfgDate: dateToDay(l.mfgDate),
        expiryDate: dateToDay(l.expiryDate),
        serials: l.serials,
        qcStatus: l.qcStatus,
        qtyReturnedBase: l.qtyReturnedBase ?? 0,
      };
    }),
    costHidden: !seesCost,
    subtotalMinor: money(d.subtotalMinor),
    discountMinor: money(d.discountMinor),
    otherChargesMinor: money(d.otherChargesMinor),
    taxMinor: money(d.taxMinor),
    grandTotalMinor: money(d.grandTotalMinor),
    balanceMinor: money(d.balanceMinor),
    paidMinor: money(d.paidMinor),
    paymentStatus: d.paymentStatus,
    dueDate: iso(d.dueDate),
    note: d.note,
    postedAt: iso(d.postedAt),
    postedByUserId: d.postedBy ? String(d.postedBy) : null,
    cancelledAt: iso(d.cancelledAt),
    cancelReason: d.cancelReason,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));
}

export async function listGrns(
  actor: RequestActor,
  query: ListGrnQuery,
): Promise<{ items: GoodsReceiptPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<GoodsReceiptDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;
  if (query.supplierPartyId) filter.supplierPartyId = new Types.ObjectId(query.supplierPartyId);
  if (query.poId) filter.poId = new Types.ObjectId(query.poId);
  const { items, meta } = await paginate<GoodsReceiptDoc>(GoodsReceipt, {
    filter,
    query,
    sortable: ['receivedAt', 'docNo', 'grandTotalMinor', 'createdAt'],
    searchFields: ['docNo', 'supplierInvoiceNo', 'note'],
    defaultSort: { receivedAt: -1, _id: -1 },
  });
  return { items: await serialize(actor, items), meta };
}

async function loadGrn(actor: RequestActor, id: Types.ObjectId, session?: ClientSession) {
  const g = await GoodsReceipt.findOne({ _id: id, orgId: actor.orgId })
    .session(session ?? null)
    .lean();
  if (!g) throw ApiError.notFound('Goods receipt');
  assertCanSee(actor, g);
  return g;
}

export async function getGrn(actor: RequestActor, id: Types.ObjectId) {
  const [payload] = await serialize(actor, [await loadGrn(actor, id)]);
  return payload!;
}

// ─── Drafts ─────────────────────────────────────────────────────────────────────────────

async function loadSupplier(
  actor: RequestActor,
  id: string | Types.ObjectId,
): Promise<PartyDoc> {
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

async function loadReceivablePo(actor: RequestActor, id: string | Types.ObjectId) {
  const po = await PurchaseOrder.findOne({
    _id: id,
    orgId: actor.orgId,
    isDeleted: false,
  }).lean();
  if (!po) throw refuse('poId', 'No such purchase order');
  const scope = locationScopeOf(actor.user);
  if (scope && !scope.includes(String(po.locationId))) {
    throw refuse('poId', 'No such purchase order');
  }
  if (!RECEIVABLE.includes(po.status)) {
    throw refuse(
      'poId',
      `${po.docNo ?? 'This purchase order'} is ${po.status} — nothing can be received against it`,
    );
  }
  return po;
}

/** The item's stock across every location, as one average — inside the caller's session. */
export async function itemCost(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
  variantId: Types.ObjectId | null,
  session?: ClientSession,
): Promise<CostedStock> {
  const rows = await StockBalance.find({ orgId, productId, variantId: variantId ?? null })
    .select('qtyOnHand avgCostMinor')
    .session(session ?? null)
    .lean();
  return currentCost(rows);
}

/** An item's new moving average, mirrored everywhere it is read: every balance row, and the
 * variant (or the product, for an item without variants). */
export async function setAverageCost(
  session: ClientSession,
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
  variantId: Types.ObjectId | null,
  avgCostMinor: number,
): Promise<void> {
  await StockBalance.updateMany(
    { orgId, productId, variantId: variantId ?? null },
    { $set: { avgCostMinor } },
    { session },
  );
  if (variantId) {
    await Variant.updateOne({ _id: variantId }, { $set: { avgCostMinor } }, { session });
  } else {
    await Product.updateOne({ _id: productId }, { $set: { avgCostMinor } }, { session });
  }
}

interface BuiltLines {
  lines: GrnLineDoc[];
  subtotalMinor: number;
  discountMinor: number;
  netMinor: number;
}

/**
 * Lines as stored. Products, units, lots and serials follow every stock document's rules; on a
 * draft, serials and lots may still be missing (they are demanded at posting). Against a PO each
 * line must fill one of its lines, for that item, within what is still to come. Costs default from
 * the PO line — converted to this line's unit — or, on a direct receipt, the item's current cost.
 */
async function buildLines(
  actor: RequestActor,
  input: readonly GrnLineInput[],
  po: PurchaseOrderDoc | null,
  previous: readonly GrnLineDoc[] = [],
): Promise<BuiltLines> {
  const resolved = await resolveStockLines(
    actor.orgId,
    input.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.qty,
      lotNo: l.lotNo,
      mfgDate: l.mfgDate,
      expiryDate: l.expiryDate,
      serials: l.serials,
    })),
    // A draft demands nothing: serials, lots and their dates may come later. Posting checks them
    // all (`postInSession`), and works out an expiry from the shelf life there.
    { requireCapture: false },
  );

  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const poLineBy = new Map((po?.lines ?? []).map((l) => [String(l._id), l]));
  const errors: ApiFieldError[] = [];
  const filling = new Map<string, number>();

  const lines: GrnLineDoc[] = [];
  for (const [i, line] of input.entries()) {
    const r = resolved[i]!;
    const at = (f: string) => `lines.${i}.${f}`;
    const qcStatus = line.qcStatus ?? 'OK';

    let unitCostMinor: number;
    let discountPct = line.discountPct ?? 0;
    let poLineId: Types.ObjectId | null = null;
    if (po) {
      const pl = line.poLineId ? poLineBy.get(line.poLineId) : undefined;
      if (!pl) {
        errors.push({
          path: at('poLineId'),
          message: line.poLineId
            ? `Not a line of ${po.docNo}`
            : `Which line of ${po.docNo} does this fill?`,
        });
        continue;
      }
      if (!pl.productId.equals(r.productId) || String(pl.variantId) !== String(r.variantId)) {
        errors.push({
          path: at('productId'),
          message: `Line ${pl.lineNo} of ${po.docNo} is another item`,
        });
        continue;
      }
      poLineId = pl._id;
      if (qcStatus === 'OK') {
        filling.set(String(pl._id), (filling.get(String(pl._id)) ?? 0) + r.qtyBase);
        if (filling.get(String(pl._id))! > poLineOutstanding(pl)) {
          errors.push({
            path: at('qty'),
            message: `Line ${pl.lineNo} of ${po.docNo} has ${poLineOutstanding(pl)} still to come`,
          });
          continue;
        }
      }
      const was = previous.find((p) => p.poLineId?.equals(pl._id) && p.uomCode === r.uomCode);
      if (was) {
        // Kept as last saved — a cost set by someone who could see it survives an edit by
        // someone who cannot.
        unitCostMinor = was.unitCostMinor;
        if (line.discountPct === undefined) discountPct = was.discountPct;
      } else {
        // The PO's price per its unit, as a price per this line's unit.
        unitCostMinor = roundHalfUp(
          (pl.unitCostMinor * (r.qtyBase / r.qty)) / (pl.qtyBase / pl.uomQty),
        );
        if (line.discountPct === undefined) discountPct = pl.discountPct;
      }
    } else {
      if (line.poLineId) {
        errors.push({ path: at('poLineId'), message: 'A direct receipt has no PO lines' });
        continue;
      }
      const was = previous.find(
        (p) => itemKey(p.productId, p.variantId) === itemKey(r.productId, r.variantId),
      );
      unitCostMinor =
        was && was.uomCode === r.uomCode
          ? was.unitCostMinor
          : roundHalfUp(
              (await itemCost(actor.orgId, r.productId, r.variantId)).avgCostMinor *
                (r.qtyBase / r.qty),
            );
    }

    if (line.unitCostMinor !== undefined && line.unitCostMinor !== unitCostMinor) {
      if (!seesCost) {
        errors.push({
          path: at('unitCostMinor'),
          message: 'You need stock:viewCost to enter a cost',
        });
        continue;
      }
      unitCostMinor = line.unitCostMinor;
    }

    const gross = unitCostMinor * r.qty;
    const discountMinor = qcStatus === 'OK' ? applyPct(gross, discountPct) : 0;
    lines.push({
      lineNo: i + 1,
      poLineId,
      productId: r.productId,
      variantId: r.variantId,
      uomCode: r.uomCode,
      qty: r.qty,
      qtyBase: r.qtyBase,
      unitCostMinor,
      discountPct,
      discountMinor,
      // A damaged line is refused at the door: on record, but not owed.
      lineTotalMinor: qcStatus === 'OK' ? gross - discountMinor : 0,
      landedUnitCostMinor: null,
      lotNo: r.lotNo,
      // Kept as typed; the resolver reads a lot's dates only for stock arriving now.
      mfgDate: r.lotNo ? dayToDate(line.mfgDate ?? null) : null,
      expiryDate: r.lotNo ? dayToDate(line.expiryDate ?? null) : null,
      serials: r.serials,
      qcStatus,
      qtyReturnedBase: 0,
    });
  }
  if (errors.length > 0) throw ApiError.validation('Validation failed', errors);

  const ok = lines.filter((l) => l.qcStatus === 'OK');
  const subtotalMinor = ok.reduce((t, l) => t + l.unitCostMinor * l.qty, 0);
  const discountMinor = ok.reduce((t, l) => t + l.discountMinor, 0);
  return { lines, subtotalMinor, discountMinor, netMinor: subtotalMinor - discountMinor };
}

const totalsOf = (b: BuiltLines, otherChargesMinor: number) => ({
  lines: b.lines,
  subtotalMinor: b.subtotalMinor,
  discountMinor: b.discountMinor,
  otherChargesMinor,
  taxMinor: 0,
  grandTotalMinor: b.netMinor + otherChargesMinor,
});

export async function createGrn(
  actor: RequestActor,
  input: CreateGrnInput,
): Promise<GoodsReceiptPayload> {
  let po: PurchaseOrderDoc | null = null;
  let supplierId: Types.ObjectId;
  let locationId: Types.ObjectId;
  if (input.poId) {
    po = await loadReceivablePo(actor, input.poId);
    if (input.supplierPartyId && !po.supplierPartyId.equals(input.supplierPartyId)) {
      throw refuse('supplierPartyId', `${po.docNo} is from another supplier`);
    }
    if (input.locationId && !po.locationId.equals(input.locationId)) {
      throw refuse('locationId', `${po.docNo} is for delivery to another warehouse`);
    }
    supplierId = po.supplierPartyId;
    locationId = po.locationId;
    await loadSupplier(actor, supplierId);
  } else {
    supplierId = (await loadSupplier(actor, input.supplierPartyId!))._id;
    await assertReceivingLocation(actor, input.locationId!);
    locationId = new Types.ObjectId(input.locationId);
  }
  const built = await buildLines(actor, input.lines, po);
  const otherChargesMinor = input.otherChargesMinor ?? 0;
  if (otherChargesMinor > 0 && !hasPermission(actor.user, 'stock:viewCost')) {
    throw refuse('otherChargesMinor', 'You need stock:viewCost to enter charges');
  }

  const doc = await GoodsReceipt.create({
    orgId: actor.orgId,
    poId: po?._id ?? null,
    supplierPartyId: supplierId,
    locationId,
    receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
    supplierInvoiceNo: input.supplierInvoiceNo ?? null,
    supplierInvoiceDate: dayToDate(input.supplierInvoiceDate ?? null),
    ...totalsOf(built, otherChargesMinor),
    note: input.note ?? null,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  });
  const [payload] = await serialize(actor, [doc.toObject()]);
  return payload!;
}

const onlyDraft = (g: Pick<GoodsReceiptDoc, 'docNo' | 'status'>, verb: string) =>
  ApiError.conflict(
    'ILLEGAL_TRANSITION',
    `${g.docNo ?? 'This goods receipt'} is ${g.status} — only a draft can be ${verb}`,
  );

/** The stored lines as input again — to re-check them, or to keep them on an edit. */
const asInput = (lines: readonly GrnLineDoc[]): GrnLineInput[] =>
  lines.map((l) => ({
    poLineId: l.poLineId ? String(l.poLineId) : null,
    productId: String(l.productId),
    variantId: l.variantId ? String(l.variantId) : null,
    uomCode: l.uomCode,
    qty: l.qty,
    unitCostMinor: l.unitCostMinor,
    discountPct: l.discountPct,
    lotNo: l.lotNo,
    mfgDate: dateToDay(l.mfgDate),
    expiryDate: dateToDay(l.expiryDate),
    serials: l.serials,
    qcStatus: l.qcStatus,
  }));

export async function updateGrn(
  actor: RequestActor,
  id: Types.ObjectId,
  input: UpdateGrnInput,
): Promise<GoodsReceiptPayload> {
  const g = await loadGrn(actor, id);
  if (g.status !== 'DRAFT') throw onlyDraft(g, 'changed');
  const po = g.poId ? await loadReceivablePo(actor, g.poId) : null;

  const $set: Record<string, unknown> = { updatedBy: actor.actorId };
  if (!po && input.supplierPartyId !== undefined) {
    $set.supplierPartyId = (await loadSupplier(actor, input.supplierPartyId))._id;
  }
  if (!po && input.locationId !== undefined) {
    await assertReceivingLocation(actor, input.locationId);
    $set.locationId = new Types.ObjectId(input.locationId);
  }
  if (po && (input.supplierPartyId !== undefined || input.locationId !== undefined)) {
    throw refuse('poId', `Supplier and warehouse come from ${po.docNo}`);
  }
  if (input.lines !== undefined || input.otherChargesMinor !== undefined) {
    if (
      input.otherChargesMinor !== undefined &&
      input.otherChargesMinor !== g.otherChargesMinor &&
      !hasPermission(actor.user, 'stock:viewCost')
    ) {
      throw refuse('otherChargesMinor', 'You need stock:viewCost to enter charges');
    }
    // A cost the caller cannot see is kept as stored, not "changed" by its absence.
    const lines = input.lines ?? asInput(g.lines);
    const built = await buildLines(actor, lines, po, g.lines);
    Object.assign($set, totalsOf(built, input.otherChargesMinor ?? g.otherChargesMinor));
  }
  if (input.receivedAt !== undefined) $set.receivedAt = new Date(input.receivedAt);
  if (input.supplierInvoiceNo !== undefined) $set.supplierInvoiceNo = input.supplierInvoiceNo;
  if (input.supplierInvoiceDate !== undefined) {
    $set.supplierInvoiceDate = dayToDate(input.supplierInvoiceDate);
  }
  if (input.note !== undefined) $set.note = input.note;

  const updated = await GoodsReceipt.findOneAndUpdate(
    { _id: g._id, orgId: actor.orgId, status: 'DRAFT' },
    { $set },
    { new: true },
  ).lean();
  if (!updated) throw onlyDraft(await loadGrn(actor, id), 'changed');
  const [payload] = await serialize(actor, [updated]);
  return payload!;
}

/** `POST /goods-receipts/:id/cancel` — a draft only; it stays on record. */
export async function cancelGrn(
  actor: RequestActor,
  id: Types.ObjectId,
  input: CancelGrnInput,
): Promise<GoodsReceiptPayload> {
  const g = await loadGrn(actor, id);
  if (g.status !== 'DRAFT') {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      g.status === 'POSTED'
        ? `${g.docNo} is posted — goods that go back to the supplier are a purchase return`
        : 'Already cancelled',
    );
  }
  const updated = await GoodsReceipt.findOneAndUpdate(
    { _id: id, orgId: actor.orgId, status: 'DRAFT' },
    {
      $set: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: actor.actorId,
        cancelReason: input.reason ?? null,
        updatedBy: actor.actorId,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw onlyDraft(await loadGrn(actor, id), 'cancelled');
  const [payload] = await serialize(actor, [updated]);
  return payload!;
}

// ─── Posting ────────────────────────────────────────────────────────────────────────────

/** The validation errors of the accepted lines, pointed back at their places on the receipt. */
function remapLineErrors(error: unknown, okIndex: readonly number[]): unknown {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return error;
  const details = (error.details as ApiFieldError[]).map((d) => ({
    ...d,
    path: d.path.replace(/^lines\.(\d+)\./, (_m, i: string) => `lines.${okIndex[Number(i)]}.`),
  }));
  return ApiError.validation(error.message, details);
}

const isBillClash = (error: unknown) =>
  error instanceof mongo.MongoServerError &&
  error.code === 11000 &&
  String(error.message).includes('one_posted_receipt_per_supplier_bill');

/**
 * `POST /goods-receipts/:id/post` — the goods arrive, in one transaction:
 *
 *   1. the accepted lines are checked as anything that posts stock is: units, a lot (with its
 *      dates) for lot goods, one serial per unit for serialised ones;
 *   2. the receipt takes its number, and each line its landed cost — its net value plus its
 *      share of the other charges, spread by value;
 *   3. lots are found or created; stock comes IN at the landed cost; new serial units remember
 *      this receipt and what they cost;
 *   4. each item's moving average is re-blended across every location (`domain/costing.ts`) and
 *      mirrored onto its product or variant and every balance row;
 *   5. against a PO: its lines' received counters move and its status follows
 *      (`recordPoReceipt`) — refusing anything more than was ordered;
 *   6. the supplier's ledger is credited with the bill, due on their terms.
 *
 * Any refusal at any step rolls back every one of them. Damaged lines are recorded and nothing
 * else: not stocked, not received against the PO, not owed.
 */
export async function postGrn(actor: RequestActor, id: Types.ObjectId) {
  try {
    await withTransaction((session) => postInSession(session, actor, id));
  } catch (error) {
    if (isBillClash(error)) {
      const g = await loadGrn(actor, id);
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        `Bill ${g.supplierInvoiceNo} from this supplier is already on another posted receipt`,
        { supplierInvoiceNo: g.supplierInvoiceNo },
      );
    }
    throw error;
  }
  return getGrn(actor, id);
}

async function postInSession(session: ClientSession, actor: RequestActor, id: Types.ObjectId) {
  const g = await loadGrn(actor, id, session);
  if (g.status !== 'DRAFT') throw onlyDraft(g, 'posted');

  const supplier = await Party.findById(g.supplierPartyId).session(session).lean();
  if (!supplier?.isActive) {
    throw refuse('supplierPartyId', `${supplier?.name ?? 'The supplier'} is inactive`);
  }
  const po = g.poId ? await PurchaseOrder.findById(g.poId).session(session).lean() : null;
  if (g.poId && !po) throw refuse('poId', 'No such purchase order');

  // ── 1. The accepted lines, checked as anything that posts stock ──
  const okIndex = g.lines.flatMap((l, i) => (l.qcStatus === 'OK' ? [i] : []));
  if (okIndex.length === 0) {
    throw refuse('lines', 'Nothing was accepted — every line is marked damaged');
  }
  let checked;
  try {
    checked = await resolveStockLines(actor.orgId, asInput(okIndex.map((i) => g.lines[i]!)), {
      requireCapture: true,
      inboundCreatesLots: true,
    });
  } catch (error) {
    throw remapLineErrors(error, okIndex);
  }
  // The lines as checked: a lot's expiry may have been worked out from its manufacture date.
  const ok = okIndex.map((i, k) => ({
    ...g.lines[i]!,
    mfgDate: checked[k]!.mfgDate,
    expiryDate: checked[k]!.expiryDate,
  }));
  if (g.supplierInvoiceNo) {
    const clash = await GoodsReceipt.findOne({
      orgId: actor.orgId,
      supplierPartyId: g.supplierPartyId,
      supplierInvoiceNo: g.supplierInvoiceNo,
      status: 'POSTED',
    })
      .select('docNo')
      .session(session)
      .lean();
    if (clash) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        `Bill ${g.supplierInvoiceNo} from ${supplier.name} is already on ${clash.docNo}`,
        { supplierInvoiceNo: g.supplierInvoiceNo, docNo: clash.docNo },
      );
    }
  }

  // ── 2. Number, landed costs, the bill ──
  const postedAt = new Date();
  const docNo = await nextDocNo(session, actor.orgId, 'GRN', g.receivedAt);
  const landed = landedValues(
    ok.map((l) => l.lineTotalMinor),
    g.otherChargesMinor,
  );
  const landedUnit = ok.map((l, i) => roundHalfUp(landed[i]! / l.qtyBase));
  const lines = g.lines.map((l, i) => {
    const k = okIndex.indexOf(i);
    return k >= 0 ? { ...ok[k]!, landedUnitCostMinor: landedUnit[k]! } : l;
  });

  const org = await Org.findById(actor.orgId).select('timeZone').session(session).lean();
  const zone = org?.timeZone ?? 'Asia/Dhaka';
  const terms = po?.paymentTermsDays ?? supplier.supplier?.paymentTermsDays ?? 0;
  const billDay = dateToDay(g.supplierInvoiceDate) ?? dayIn(g.receivedAt, zone);
  const dueDate = new Date(dayToDate(billDay)!.getTime() + terms * 86_400_000);

  // Costs before anything moves — the blend is of what was on the shelf with what arrived.
  const before = new Map<string, CostedStock>();
  for (const l of ok) {
    const k = itemKey(l.productId, l.variantId);
    if (!before.has(k)) {
      before.set(k, await itemCost(actor.orgId, l.productId, l.variantId, session));
    }
  }

  const claimed = await GoodsReceipt.findOneAndUpdate(
    { _id: id, orgId: actor.orgId, status: 'DRAFT', updatedAt: g.updatedAt },
    {
      $set: {
        status: 'POSTED',
        docNo,
        lines,
        postedAt,
        postedBy: actor.actorId,
        paidMinor: 0,
        balanceMinor: g.grandTotalMinor,
        paymentStatus: g.grandTotalMinor === 0 ? 'PAID' : 'UNPAID',
        dueDate,
        updatedBy: actor.actorId,
      },
    },
    { new: true, session },
  ).lean();
  if (!claimed) {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      'The receipt changed while it was being posted — reload and try again',
    );
  }

  // ── 3. Lots, stock, serial units ──
  const movements = [];
  for (const [i, l] of ok.entries()) {
    const tracking = await trackingFor(session, actor.orgId, l, 'IN', actor.actorId);
    if (tracking.lotId) {
      await Lot.updateOne(
        { _id: tracking.lotId, grnId: null },
        { $set: { grnId: claimed._id } },
        { session },
      );
    }
    movements.push({
      locationId: claimed.locationId,
      productId: l.productId,
      variantId: l.variantId,
      qtyBase: l.qtyBase,
      movementType: 'GRN' as const,
      refType: REF_TYPE,
      refId: claimed._id,
      refDocNo: docNo,
      unitCostMinor: landedUnit[i]!,
      narration: `From ${supplier.name}${g.supplierInvoiceNo ? `, bill ${g.supplierInvoiceNo}` : ''}`,
      ...tracking,
    });
  }
  await postMovements(session, {
    orgId: actor.orgId,
    postedAt,
    actorId: actor.actorId,
    movements,
  });
  for (const [i, l] of ok.entries()) {
    if (l.serials.length === 0) continue;
    // A unit seen before (returned to a supplier, say) is this receipt's now, at this cost.
    await SerialUnit.updateMany(
      { orgId: actor.orgId, serialNo: { $in: l.serials } },
      { $set: { grnId: claimed._id, unitCostMinor: landedUnit[i]!, receivedAt: postedAt } },
      { session },
    );
  }

  // ── 4. Moving average, per item, mirrored everywhere it is read ──
  const arriving = new Map<
    string,
    { productId: Types.ObjectId; variantId: Types.ObjectId | null; qty: number; value: number }
  >();
  ok.forEach((l, i) => {
    const k = itemKey(l.productId, l.variantId);
    const a = arriving.get(k) ?? {
      productId: l.productId,
      variantId: l.variantId,
      qty: 0,
      value: 0,
    };
    a.qty += l.qtyBase;
    a.value += landed[i]!;
    arriving.set(k, a);
  });
  for (const [k, a] of arriving) {
    await setAverageCost(
      session,
      actor.orgId,
      a.productId,
      a.variantId,
      movingAverage(before.get(k)!, a.qty, a.value),
    );
  }

  // ── 5. The PO follows ──
  if (po) {
    await recordPoReceipt(
      session,
      actor,
      po._id,
      ok.map((l) => ({
        poLineId: l.poLineId!,
        qtyBase: l.qtyBase,
        productId: l.productId,
        variantId: l.variantId,
      })),
    );
  }

  // ── 6. The supplier's bill ──
  if (g.grandTotalMinor > 0) {
    await postLedgerEntries(session, {
      orgId: actor.orgId,
      postedAt,
      actorId: actor.actorId,
      entries: [
        {
          partyId: g.supplierPartyId,
          docType: 'PURCHASE',
          refType: REF_TYPE,
          refId: claimed._id,
          refDocNo: docNo,
          creditMinor: g.grandTotalMinor,
          narration: g.supplierInvoiceNo
            ? `Bill ${g.supplierInvoiceNo}${po?.docNo ? ` against ${po.docNo}` : ''}`
            : po?.docNo
              ? `Goods against ${po.docNo}`
              : 'Goods received',
          dueDate,
        },
      ],
    });
  }
}
