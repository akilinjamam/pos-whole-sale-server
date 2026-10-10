import { Schema, model } from 'mongoose';

import { INITIAL_PO_STATUS } from '../../domain/poStateMachine.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';
import { PO_STATUSES } from '../../shared/enums.js';
import { updateTouchesStatus } from '../wholesaleOrder/wholesaleOrder.model.js';

import type { PoStatus } from '@shared/enums.js';
import type { Model, Query, Types } from 'mongoose';

/**
 * A purchase order to a supplier — §6.8.
 *
 * **Status moves only through `domain/poStateMachine.ts`.** `transitionPo` in the service is the
 * single writer of `status` and `statusHistory`; the middleware below refuses every other write
 * that touches them, exactly as on `WholesaleOrder`.
 *
 * Quantities are base units. Each line carries two counters that only documents move: received
 * (a posted goods receipt, Day 33) and cancelled (a short close). Money is per the line's unit, in
 * minor units, typed from the supplier's quotation; totals are recomputed by the server.
 */

export interface PoLineDoc {
  _id: Types.ObjectId;
  lineNo: number;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  uomQty: number;
  qtyBase: number;
  qtyReceivedBase: number;
  qtyCancelledBase: number;
  /** Per `uomCode`. */
  unitCostMinor: number;
  discountPct: number;
  discountMinor: number;
  /** VAT held at zero until open question 1 (VAT/Mushak) is answered, as on sales. */
  taxPct: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export interface PoStatusHistoryDoc {
  from: PoStatus | null;
  to: PoStatus;
  action: string;
  at: Date;
  by: Types.ObjectId | null;
  reason: string | null;
}

export interface PurchaseOrderDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  supplierPartyId: Types.ObjectId;
  locationId: Types.ObjectId;
  status: PoStatus;
  orderDate: Date;
  expectedDate: Date | null;
  lines: PoLineDoc[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  grandTotalMinor: number;
  paymentTermsDays: number;
  supplierRef: string | null;
  note: string | null;
  statusHistory: PoStatusHistoryDoc[];
  approvedBy: Types.ObjectId | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  isDeleted: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const qty = { type: Number, default: 0, min: 0 };

const lineSchema = new Schema<PoLineDoc>(
  {
    lineNo: { type: Number, required: true, min: 1 },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true },
    uomQty: { type: Number, required: true, min: 1 },
    qtyBase: { type: Number, required: true, min: 1 },
    qtyReceivedBase: qty,
    qtyCancelledBase: qty,
    unitCostMinor: { type: Number, required: true, min: 0 },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxPct: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: true },
);

const historySchema = new Schema<PoStatusHistoryDoc>(
  {
    from: { type: String, enum: [...PO_STATUSES, null], default: null },
    to: { type: String, enum: PO_STATUSES, required: true },
    action: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const purchaseOrderSchema = new Schema<PurchaseOrderDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    supplierPartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: PO_STATUSES, default: INITIAL_PO_STATUS },
    orderDate: { type: Date, required: true },
    expectedDate: { type: Date, default: null },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0 },
    shippingMinor: { type: Number, default: 0, min: 0 },
    grandTotalMinor: { type: Number, default: 0, min: 0 },
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    supplierRef: { type: String, trim: true, default: null },
    note: { type: String, trim: true, default: null },
    statusHistory: { type: [historySchema], default: [] },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { collection: 'purchase_orders' },
);

purchaseOrderSchema.plugin(baseSchemaPlugin);

// One number, one PO. Drafts (docNo null) are exempt.
purchaseOrderSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
// The PO list per state, newest first; and a supplier's open POs (the GRN screen's picker).
purchaseOrderSchema.index({ orgId: 1, status: 1, orderDate: -1 });
purchaseOrderSchema.index({ orgId: 1, supplierPartyId: 1, status: 1, orderDate: -1 });
purchaseOrderSchema.index({ orgId: 1, locationId: 1, status: 1 });

// ─── The status backstop ────────────────────────────────────────────────────────────────
//
// As on `WholesaleOrder`: the service passes `PO_TRANSITION_WRITE` in the options of the one
// update that applies a transition, and nothing else may touch `status` or `statusHistory`.

const PO_TOKEN = Symbol('purchaseOrder.transition');

/** Query options that mark an update as the state machine's. Only `transitionPo` uses this. */
export const PO_TRANSITION_WRITE = { poTransition: PO_TOKEN } as const;

export class PoStatusWriteError extends Error {
  constructor(how: string) {
    super(
      `Refused ${how}: a purchase order's status and statusHistory change only through ` +
        'transitionPo (domain/poStateMachine.ts)',
    );
    this.name = 'PoStatusWriteError';
  }
}

const isTransitionWrite = (query: Query<unknown, unknown>) =>
  (query.getOptions() as { poTransition?: unknown }).poTransition === PO_TOKEN;

purchaseOrderSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  function guardStatusUpdate() {
    if (!isTransitionWrite(this) && updateTouchesStatus(this.getUpdate())) {
      throw new PoStatusWriteError(`${(this as { op?: string }).op} of status`);
    }
  },
);

purchaseOrderSchema.pre(['replaceOne', 'findOneAndReplace'], function guardReplace() {
  if (!isTransitionWrite(this)) {
    throw new PoStatusWriteError(`${(this as { op?: string }).op} of a purchase order`);
  }
});

purchaseOrderSchema.pre('save', function guardSave() {
  if (this.isNew) {
    if (this.status !== INITIAL_PO_STATUS) {
      throw new PoStatusWriteError(`creating a purchase order as ${this.status}`);
    }
    if (this.statusHistory.length === 0) {
      this.statusHistory.push({
        from: null,
        to: INITIAL_PO_STATUS,
        action: 'create',
        at: new Date(),
        by: this.createdBy,
        reason: null,
      });
    }
    return;
  }
  if (this.isModified('status') || this.isModified('statusHistory')) {
    throw new PoStatusWriteError('save() of a changed status');
  }
});

purchaseOrderSchema.pre('insertMany', function guardInsertMany(next, docs: unknown) {
  const list = (Array.isArray(docs) ? docs : [docs]) as { status?: string }[];
  if (list.some((d) => d.status !== undefined && d.status !== INITIAL_PO_STATUS)) {
    return next(new PoStatusWriteError('insertMany of a non-draft purchase order'));
  }
  next();
});

export const PurchaseOrder: Model<PurchaseOrderDoc> = model<PurchaseOrderDoc>(
  'PurchaseOrder',
  purchaseOrderSchema,
);
