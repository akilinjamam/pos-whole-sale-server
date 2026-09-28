import { Schema, model } from 'mongoose';

import { idToString } from '../../lib/model.js';

import type { StockBalancePayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * What is on hand at one location, for one product (or variant) — a **cache** of the ledger.
 *
 * It exists so "how many do we have?" is one indexed read rather than a sum over all history on
 * every product-list render. It is written only by `stock.service`, in the same transaction as
 * the ledger rows it summarises, and `stock:reconcile` (Day 16) re-sums the ledger to prove it.
 *
 * The guarded update in `stock.service` — `qtyOnHand: { $gte: qty }` in the filter — is what
 * makes overselling impossible: two dispatches of the last five units cannot both match.
 *
 * `qtyAvailable` is not stored: it is `qtyOnHand − qtyReserved`, and a stored copy would be one
 * more number that can disagree with the other two.
 */
export interface StockBalanceDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  qtyOnHand: number;
  /** Promised to confirmed orders (Day 22) but still on the shelf. */
  qtyReserved: number;
  /** On open purchase orders (Day 32). */
  qtyIncoming: number;
  avgCostMinor: number;
  lastMovementAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const stockBalanceSchema = new Schema<StockBalanceDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    qtyOnHand: { type: Number, default: 0 },
    qtyReserved: { type: Number, default: 0 },
    qtyIncoming: { type: Number, default: 0 },
    avgCostMinor: { type: Number, default: 0 },
    lastMovementAt: { type: Date, default: null },
  },
  { collection: 'stock_balances', versionKey: false, timestamps: true },
);

/**
 * One row per (location, product, variant). `variantId: null` is a real value here — a product
 * without variants — and takes part in the uniqueness like any other, which is what stops two
 * concurrent first receipts from creating two balance rows for the same shelf.
 */
stockBalanceSchema.index(
  { orgId: 1, locationId: 1, productId: 1, variantId: 1 },
  { unique: true, name: 'balance_unique' },
);
// Stock of one product across every location — the product screen and the order builder.
stockBalanceSchema.index({ orgId: 1, productId: 1, variantId: 1 });

export type StockBalanceDocument = HydratedDocument<StockBalanceDoc>;
export type StockBalanceModel = Model<StockBalanceDoc>;

export const StockBalance: StockBalanceModel = model<StockBalanceDoc>(
  'StockBalance',
  stockBalanceSchema,
);

export interface StockBalanceNames {
  productName?: string;
  sku?: string;
  baseUom?: string;
  variantLabel?: string | null;
  locationCode?: string;
  locationName?: string;
}

export function toStockBalancePayload(
  doc: StockBalanceDoc,
  options: { includeCost: boolean } & StockBalanceNames,
): StockBalancePayload {
  const { includeCost, ...names } = options;
  return {
    id: String(doc._id),
    locationId: String(doc.locationId),
    productId: String(doc.productId),
    variantId: idToString(doc.variantId),
    qtyOnHand: doc.qtyOnHand,
    qtyReserved: doc.qtyReserved,
    qtyAvailable: doc.qtyOnHand - doc.qtyReserved,
    qtyIncoming: doc.qtyIncoming,
    ...(includeCost ? { avgCostMinor: doc.avgCostMinor } : {}),
    lastMovementAt: doc.lastMovementAt ? doc.lastMovementAt.toISOString() : null,
    ...names,
  };
}
