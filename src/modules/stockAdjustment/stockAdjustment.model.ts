import { Schema, model } from 'mongoose';

import { ADJUSTMENT_REASONS, DOCUMENT_STATUSES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';
import { stockDocLineSchema, toStockDocLinePayload } from '../stock/stockDocLine.js';

import type { LineNames, StockDocLineDoc } from '../stock/stockDocLine.js';
import type { AdjustmentReason, DocumentStatus } from '@shared/enums.js';
import type { StockAdjustmentPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A reason-coded change to stock that is not a sale, a purchase or a transfer: breakage, expiry,
 * a lost box, a box found behind the rack.
 *
 * DRAFT → POSTED → (CANCELLED). Posting writes one `ADJUSTMENT` movement per line. Cancelling a
 * posted adjustment writes the exact opposite movements, each pointing at the one it reverses —
 * the original rows stay, so the ledger shows both the mistake and its correction.
 */
export interface StockAdjustmentDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  status: DocumentStatus;
  locationId: Types.ObjectId;
  reason: AdjustmentReason;
  note: string | null;
  lines: StockDocLineDoc[];
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const stockAdjustmentSchema = new Schema<StockAdjustmentDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'DRAFT' },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    reason: { type: String, enum: ADJUSTMENT_REASONS, required: true },
    note: { type: String, trim: true, default: null },
    lines: { type: [stockDocLineSchema], default: [] },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
  },
  { collection: 'stock_adjustments' },
);

stockAdjustmentSchema.plugin(baseSchemaPlugin);

// The numbering backstop (§10): drafts have no number, so the uniqueness is over real numbers only.
stockAdjustmentSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
stockAdjustmentSchema.index({ orgId: 1, status: 1, createdAt: -1 });
stockAdjustmentSchema.index({ orgId: 1, locationId: 1, createdAt: -1 });

export type StockAdjustmentDocument = HydratedDocument<StockAdjustmentDoc>;
export const StockAdjustment: Model<StockAdjustmentDoc> = model<StockAdjustmentDoc>(
  'StockAdjustment',
  stockAdjustmentSchema,
);

export function toStockAdjustmentPayload(
  doc: StockAdjustmentDoc,
  names?: { lines?: LineNames; locationName?: string },
): StockAdjustmentPayload {
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    status: doc.status,
    locationId: String(doc.locationId),
    locationName: names?.locationName,
    reason: doc.reason,
    note: doc.note ?? null,
    lines: doc.lines.map((l) => toStockDocLinePayload(l, names?.lines)),
    netQtyBase: doc.lines.reduce((sum, l) => sum + l.qtyBase, 0),
    postedAt: doc.postedAt ? doc.postedAt.toISOString() : null,
    postedBy: idToString(doc.postedBy),
    cancelledAt: doc.cancelledAt ? doc.cancelledAt.toISOString() : null,
    cancelReason: doc.cancelReason ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
