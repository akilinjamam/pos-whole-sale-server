import { Schema, model } from 'mongoose';

import type { Model, Types } from 'mongoose';

/**
 * How much of one lot is at one location — the lot-level twin of `StockBalance`.
 *
 * Written only by `stock.service`, in the same transaction and with the same guarded decrement:
 * taking five from a lot that holds three is refused even when the product as a whole has fifty,
 * because the fifty are other batches with other expiry dates. The sum over a product's lots at a
 * location equals its `StockBalance.qtyOnHand` — `stock:reconcile` (Day 16) can check it.
 */
export interface LotBalanceDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  lotId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  qtyOnHand: number;
  lastMovementAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const lotBalanceSchema = new Schema<LotBalanceDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    qtyOnHand: { type: Number, default: 0 },
    lastMovementAt: { type: Date, default: null },
  },
  { collection: 'lot_balances', versionKey: false, timestamps: true },
);

lotBalanceSchema.index(
  { orgId: 1, locationId: 1, lotId: 1 },
  { unique: true, name: 'lot_balance_unique' },
);
// The expiry report: every lot of a product with stock anywhere.
lotBalanceSchema.index({ orgId: 1, productId: 1, qtyOnHand: 1 });

export const LotBalance: Model<LotBalanceDoc> = model<LotBalanceDoc>(
  'LotBalance',
  lotBalanceSchema,
);
