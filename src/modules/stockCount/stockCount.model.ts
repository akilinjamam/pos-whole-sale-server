import { Schema, model } from 'mongoose';

import { COUNT_STATUSES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';

import type { LineNames } from '../stock/stockDocLine.js';
import type { CountStatus } from '@shared/enums.js';
import type { StockCountPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A stock-take at one location — freeze, count, post the variance (§6.7).
 *
 * Opening a count **freezes** the items it covers (`StockBalance.frozenByCountId`) and snapshots
 * what the system holds as each line's `expectedBase`. While COUNTING, no movement can touch those
 * items, so the shelf the counters see is the shelf the snapshot describes. Posting writes a
 * `COUNT` movement for each non-zero variance and lifts the freeze; cancelling just lifts it.
 */
export interface StockCountLineDoc {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  expectedBase: number;
  countedBase: number | null;
  /** Found during the count but not on the frozen sheet — expected 0, and never frozen. */
  found: boolean;
}

export interface StockCountDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  status: CountStatus;
  locationId: Types.ObjectId;
  scope: 'ALL' | 'PRODUCTS';
  productIds: Types.ObjectId[];
  note: string | null;
  lines: StockCountLineDoc[];
  frozenAt: Date;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<StockCountLineDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    expectedBase: { type: Number, required: true },
    countedBase: { type: Number, default: null },
    found: { type: Boolean, default: false },
  },
  { _id: false },
);

const stockCountSchema = new Schema<StockCountDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    status: { type: String, enum: COUNT_STATUSES, default: 'COUNTING' },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    scope: { type: String, enum: ['ALL', 'PRODUCTS'], required: true },
    productIds: { type: [Schema.Types.ObjectId], default: [] },
    note: { type: String, trim: true, default: null },
    lines: { type: [lineSchema], default: [] },
    frozenAt: { type: Date, required: true },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'stock_counts' },
);

stockCountSchema.plugin(baseSchemaPlugin);

stockCountSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
// "Is anything being counted here?" — asked before every new count.
stockCountSchema.index({ orgId: 1, locationId: 1, status: 1 });

export type StockCountDocument = HydratedDocument<StockCountDoc>;
export const StockCount: Model<StockCountDoc> = model<StockCountDoc>(
  'StockCount',
  stockCountSchema,
);

export function toStockCountPayload(
  doc: StockCountDoc,
  names?: { lines?: LineNames; locationName?: string },
): StockCountPayload {
  const lines = doc.lines.map((l) => {
    const n = names?.lines?.(l) ?? {};
    return {
      productId: String(l.productId),
      variantId: idToString(l.variantId),
      expectedBase: l.expectedBase,
      countedBase: l.countedBase,
      varianceBase: l.countedBase === null ? null : l.countedBase - l.expectedBase,
      productName: n.productName,
      sku: n.sku,
      baseUom: n.baseUom,
      variantLabel: n.variantLabel,
    };
  });
  const counted = lines.filter((l) => l.varianceBase !== null);
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    status: doc.status,
    locationId: String(doc.locationId),
    locationName: names?.locationName,
    scope: doc.scope,
    note: doc.note ?? null,
    frozenAt: doc.frozenAt.toISOString(),
    lines,
    summary: {
      lines: lines.length,
      counted: counted.length,
      withVariance: counted.filter((l) => l.varianceBase !== 0).length,
      netVarianceBase: counted.reduce((s, l) => s + (l.varianceBase ?? 0), 0),
    },
    postedAt: doc.postedAt ? doc.postedAt.toISOString() : null,
    postedBy: idToString(doc.postedBy),
    cancelledAt: doc.cancelledAt ? doc.cancelledAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
