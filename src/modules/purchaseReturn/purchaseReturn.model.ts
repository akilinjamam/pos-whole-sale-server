import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';
import { DOCUMENT_STATUSES, RETURN_REASONS } from '../../shared/enums.js';

import type { DocumentStatus, ReturnReason } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * A purchase return — goods going back to the supplier (Day 34). Numbered in the `DN` series: the
 * return is our debit note to them.
 *
 * Posted as it is created, in one transaction (`purchaseReturn.service`): stock OUT as
 * `PURCHASE_RETURN` (serial units become RETURNED) → the moving average re-blended without them →
 * the receipt line's `qtyReturnedBase` → a DEBIT on the supplier's ledger. There is no draft: the
 * goods are on the van when it is entered. A mistake is put right by receiving them again.
 */

export interface PurchaseReturnLineDoc {
  lineNo: number;
  grnLineNo: number | null;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  qty: number;
  qtyBase: number;
  /** Per `uomCode`. */
  unitCostMinor: number;
  lineTotalMinor: number;
  lotNo: string | null;
  serials: string[];
}

export interface PurchaseReturnDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string;
  grnId: Types.ObjectId | null;
  supplierPartyId: Types.ObjectId;
  locationId: Types.ObjectId;
  status: DocumentStatus;
  returnDate: Date;
  reason: ReturnReason;
  note: string | null;
  lines: PurchaseReturnLineDoc[];
  totalMinor: number;
  /** Of the total, taken off the receipt's bill; the rest is credit on the supplier's account. */
  appliedMinor: number;
  unappliedMinor: number;
  postedAt: Date;
  postedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<PurchaseReturnLineDoc>(
  {
    lineNo: { type: Number, required: true, min: 1 },
    grnLineNo: { type: Number, default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    qtyBase: { type: Number, required: true, min: 1 },
    unitCostMinor: { type: Number, required: true, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    lotNo: { type: String, trim: true, uppercase: true, default: null },
    serials: { type: [String], default: [] },
  },
  { _id: false },
);

const purchaseReturnSchema = new Schema<PurchaseReturnDoc>(
  {
    ...auditableFields,
    docNo: { type: String, required: true },
    grnId: { type: Schema.Types.ObjectId, ref: 'GoodsReceipt', default: null },
    supplierPartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'POSTED' },
    returnDate: { type: Date, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    note: { type: String, trim: true, default: null },
    lines: { type: [lineSchema], default: [] },
    totalMinor: { type: Number, required: true, min: 0 },
    appliedMinor: { type: Number, default: 0, min: 0 },
    unappliedMinor: { type: Number, default: 0, min: 0 },
    postedAt: { type: Date, required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'purchase_returns' },
);

purchaseReturnSchema.plugin(baseSchemaPlugin);

purchaseReturnSchema.index({ orgId: 1, docNo: 1 }, { unique: true });
purchaseReturnSchema.index({ orgId: 1, returnDate: -1 });
purchaseReturnSchema.index({ orgId: 1, grnId: 1 });
purchaseReturnSchema.index({ orgId: 1, supplierPartyId: 1, returnDate: -1 });

export const PurchaseReturn: Model<PurchaseReturnDoc> = model<PurchaseReturnDoc>(
  'PurchaseReturn',
  purchaseReturnSchema,
);
