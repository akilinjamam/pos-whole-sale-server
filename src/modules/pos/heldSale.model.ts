import { Schema, model } from 'mongoose';

import type { Model, Types } from 'mongoose';

/**
 * A parked cart — "hold on, let me find my wallet" (§6.10). Nothing is reserved, priced or posted:
 * it is the cart as typed, to be resumed and sold (or abandoned). It expires after 24 hours via a
 * TTL index, so yesterday's forgotten carts do not accumulate.
 */
export interface HeldSaleDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  posSessionId: Types.ObjectId;
  userId: Types.ObjectId;
  label: string;
  partyId: Types.ObjectId | null;
  walkInName: string | null;
  lines: Record<string, unknown>[];
  orderDiscount: Record<string, unknown> | null;
  note: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export const HELD_SALE_TTL_HOURS = 24;

const heldSaleSchema = new Schema<HeldSaleDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    posSessionId: { type: Schema.Types.ObjectId, ref: 'PosSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    label: { type: String, required: true, trim: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    walkInName: { type: String, trim: true, default: null },
    // The cart as validated by holdSaleSchema — stored whole; it is re-validated on resume.
    lines: { type: Schema.Types.Mixed, default: [] },
    orderDiscount: { type: Schema.Types.Mixed, default: null },
    note: { type: String, trim: true, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'held_sales',
    versionKey: false,
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// The TTL index: MongoDB deletes each held sale once `expiresAt` passes (checked about once a minute).
heldSaleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
heldSaleSchema.index({ orgId: 1, locationId: 1, createdAt: -1 });

export const HeldSale: Model<HeldSaleDoc> = model<HeldSaleDoc>('HeldSale', heldSaleSchema);
