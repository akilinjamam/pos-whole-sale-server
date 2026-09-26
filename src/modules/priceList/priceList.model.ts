import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';

import type { PriceEntryPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * One price — `PriceListEntry` in §6.6 of the project plan.
 *
 * Scoped to exactly one of a tier (`tierId`) or a single dealer (`partyId`); the other is null.
 * Qty breaks are sibling entries differing only in `minQty`. A price change over time is the
 * old entry end-dated (`validTo`) and a new one starting the next day, so the price an old order
 * was quoted from is still on file.
 *
 * Dates are stored as UTC midnight and exchanged as `YYYY-MM-DD`, and both ends are
 * **inclusive** — see `windowsOverlap` in @shared/pricing.
 */
export interface PriceEntryDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  tierId: Types.ObjectId | null;
  partyId: Types.ObjectId | null;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  priceMinor: number;
  minQty: number;
  validFrom: Date | null;
  validTo: Date | null;
  isActive: boolean;
  note: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const priceEntrySchema = new Schema<PriceEntryDoc>(
  {
    ...auditableFields,
    tierId: { type: Schema.Types.ObjectId, ref: 'PriceTier', default: null },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true, trim: true, uppercase: true },
    priceMinor: { type: Number, required: true, min: 0 },
    minQty: { type: Number, default: 1, min: 1 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    note: { type: String, trim: true, default: null },
  },
  // Explicit, so the collection is `price_list_entries` rather than Mongoose's `priceentries`.
  { collection: 'price_list_entries' },
);

priceEntrySchema.plugin(baseSchemaPlugin);

/**
 * THE compound unique index — the Day-11 backstop against duplicate prices.
 *
 * Every field that makes two entries "the same price rule" is in it. `null` is a value to a
 * (non-partial) unique index, which is exactly right here: a tier entry's `partyId: null`, an
 * all-variants `variantId: null` and an open-ended `validFrom: null` all take part, so two tier
 * prices for the same product, unit and break collide instead of slipping past as "different
 * nulls".
 *
 * What an index **cannot** see is two *different* start dates whose windows overlap — 1 Jan–
 * 31 Mar and 1 Mar–30 Jun. The service rejects those before inserting (`assertNoOverlap`); the
 * index is what still holds when two identical requests race past that check together.
 */
priceEntrySchema.index(
  {
    orgId: 1,
    tierId: 1,
    partyId: 1,
    productId: 1,
    variantId: 1,
    uomCode: 1,
    minQty: 1,
    validFrom: 1,
  },
  { unique: true, name: 'price_rule_unique' },
);

// The resolver's lookup (Day 12): everything for one product in one scope.
priceEntrySchema.index({ orgId: 1, productId: 1, tierId: 1, partyId: 1 });
// The grid: one tier's list, and one dealer's list.
priceEntrySchema.index({ orgId: 1, tierId: 1, isActive: 1 });
priceEntrySchema.index({ orgId: 1, partyId: 1, isActive: 1 });

export type PriceEntryDocument = HydratedDocument<PriceEntryDoc>;
export type PriceEntryModel = Model<PriceEntryDoc>;

export const PriceListEntry: PriceEntryModel = model<PriceEntryDoc>(
  'PriceListEntry',
  priceEntrySchema,
);

/** `YYYY-MM-DD` ↔ UTC midnight. Never local time — see the note on the model. */
export function dayToDate(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export function dateToDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export interface PriceEntryNames {
  productName?: string;
  sku?: string;
  variantLabel?: string | null;
  uomOptions?: { code: string; factor: number }[];
  tierName?: string | null;
  partyName?: string | null;
}

export function toPriceEntryPayload(
  doc: PriceEntryDoc,
  names: PriceEntryNames = {},
): PriceEntryPayload {
  return {
    id: String(doc._id),
    tierId: idToString(doc.tierId),
    partyId: idToString(doc.partyId),
    productId: String(doc.productId),
    variantId: idToString(doc.variantId),
    uomCode: doc.uomCode,
    priceMinor: doc.priceMinor,
    minQty: doc.minQty,
    validFrom: dateToDay(doc.validFrom),
    validTo: dateToDay(doc.validTo),
    isActive: doc.isActive,
    note: doc.note ?? null,
    ...names,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
