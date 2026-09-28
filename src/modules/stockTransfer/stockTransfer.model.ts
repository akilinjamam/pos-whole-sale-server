import { Schema, model } from 'mongoose';

import { TRANSFER_STATUSES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';
import { stockDocLineSchema, toStockDocLinePayload } from '../stock/stockDocLine.js';

import type { LineNames, StockDocLineDoc } from '../stock/stockDocLine.js';
import type { TransferStatus } from '@shared/enums.js';
import type { StockTransferPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * Stock moved from one location to another — warehouse to counter, godown to shop.
 *
 * Two legs, always: a `TRANSFER_OUT` from the source and a `TRANSFER_IN` at the destination, so
 * each location's ledger explains its own balance. Direct: both legs post in one transaction
 * (DRAFT → RECEIVED). Via a `TRANSIT` location the goods are first moved there on dispatch
 * (DRAFT → IN_TRANSIT) and on to the destination on receipt (→ RECEIVED) — while on the bus they
 * are on neither shop's shelf, and the transit location's balance says exactly what is out there.
 */
export interface StockTransferDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  status: TransferStatus;
  fromLocationId: Types.ObjectId;
  toLocationId: Types.ObjectId;
  transitLocationId: Types.ObjectId | null;
  note: string | null;
  lines: StockDocLineDoc[];
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  receivedAt: Date | null;
  receivedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const stockTransferSchema = new Schema<StockTransferDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    status: { type: String, enum: TRANSFER_STATUSES, default: 'DRAFT' },
    fromLocationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    toLocationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    transitLocationId: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    note: { type: String, trim: true, default: null },
    lines: { type: [stockDocLineSchema], default: [] },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: null },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'stock_transfers' },
);

stockTransferSchema.plugin(baseSchemaPlugin);

stockTransferSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
stockTransferSchema.index({ orgId: 1, status: 1, createdAt: -1 });
// "What is on its way to me?" — the receiving screen.
stockTransferSchema.index({ orgId: 1, toLocationId: 1, status: 1 });
stockTransferSchema.index({ orgId: 1, fromLocationId: 1, createdAt: -1 });

export type StockTransferDocument = HydratedDocument<StockTransferDoc>;
export const StockTransfer: Model<StockTransferDoc> = model<StockTransferDoc>(
  'StockTransfer',
  stockTransferSchema,
);

export function toStockTransferPayload(
  doc: StockTransferDoc,
  names?: { lines?: LineNames; location?: (id: Types.ObjectId | null) => string | null },
): StockTransferPayload {
  const loc = names?.location ?? (() => null);
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    status: doc.status,
    fromLocationId: String(doc.fromLocationId),
    toLocationId: String(doc.toLocationId),
    transitLocationId: idToString(doc.transitLocationId),
    fromLocationName: loc(doc.fromLocationId) ?? undefined,
    toLocationName: loc(doc.toLocationId) ?? undefined,
    transitLocationName: doc.transitLocationId ? loc(doc.transitLocationId) : null,
    note: doc.note ?? null,
    lines: doc.lines.map((l) => toStockDocLinePayload(l, names?.lines)),
    postedAt: doc.postedAt ? doc.postedAt.toISOString() : null,
    postedBy: idToString(doc.postedBy),
    dispatchedAt: doc.postedAt ? doc.postedAt.toISOString() : null,
    receivedAt: doc.receivedAt ? doc.receivedAt.toISOString() : null,
    receivedBy: idToString(doc.receivedBy),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
