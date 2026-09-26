import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { PriceTierPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A named price level — RETAIL, DEALER_A, DEALER_B, DISTRIBUTOR.
 *
 * A dealer points at one tier (`Party.dealer.priceTierId`); a tier's prices are
 * `PriceListEntry` rows scoped to it. The tier itself holds no prices and no discount
 * percentage: optical wholesale prices each frame by hand per tier, and a "tier = MRP − 20%"
 * rule would be a price nobody actually agreed. A flat trade discount, where one exists, is the
 * dealer's own `discountPct`.
 *
 * Which tier the counter sells at is `org.settings.defaultRetailTierId`, not a flag here — one
 * setting cannot disagree with itself, whereas a boolean on each tier can be true on two.
 */
export interface PriceTierDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  code: string;
  name: string;
  description: string | null;
  level: number;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const priceTierSchema = new Schema<PriceTierDoc>({
  ...auditableFields,
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: null },
  level: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
});

priceTierSchema.plugin(baseSchemaPlugin);

priceTierSchema.index({ orgId: 1, code: 1 }, { unique: true });

export type PriceTierDocument = HydratedDocument<PriceTierDoc>;
export type PriceTierModel = Model<PriceTierDoc>;

export const PriceTier: PriceTierModel = model<PriceTierDoc>('PriceTier', priceTierSchema);

export function toPriceTierPayload(
  doc: PriceTierDoc,
  options: {
    defaultRetailTierId: Types.ObjectId | null;
    dealerCount?: number;
    entryCount?: number;
  },
): PriceTierPayload {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    description: doc.description ?? null,
    level: doc.level,
    isActive: doc.isActive,
    isDefaultRetail: Boolean(options.defaultRetailTierId?.equals(doc._id)),
    ...(options.dealerCount === undefined ? {} : { dealerCount: options.dealerCount }),
    ...(options.entryCount === undefined ? {} : { entryCount: options.entryCount }),
  };
}
