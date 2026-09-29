import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { Model, Types } from 'mongoose';

/**
 * One cashier's shift at one till — §6.10.
 *
 * Opened with a float; every counter invoice and receipt carries its id. At close the cashier
 * counts the drawer note by note, and `expectedCashMinor` (float + cash received − cash refunded)
 * is compared with it: the difference is the variance, and the frozen totals are the Z-report.
 */
export interface PosSessionDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  terminalCode: string;
  status: 'OPEN' | 'CLOSED';
  openedByUserId: Types.ObjectId;
  openedAt: Date;
  openingFloatMinor: number;
  closedByUserId: Types.ObjectId | null;
  closedAt: Date | null;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  denominations: { note: number; count: number }[];
  totals: {
    salesCount: number;
    grossMinor: number;
    discountMinor: number;
    returnsMinor: number;
    netMinor: number;
    byMethod: { method: string; amountMinor: number }[];
    returnsCount?: number;
    cashInMinor?: number;
    cashOutMinor?: number;
  } | null;
  closeNote: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const posSessionSchema = new Schema<PosSessionDoc>(
  {
    ...auditableFields,
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    terminalCode: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    openedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    openedAt: { type: Date, required: true },
    openingFloatMinor: { type: Number, required: true, min: 0 },
    closedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    expectedCashMinor: { type: Number, default: null },
    countedCashMinor: { type: Number, default: null },
    varianceMinor: { type: Number, default: null },
    denominations: { type: [{ note: Number, count: Number, _id: false }], default: [] },
    totals: { type: Schema.Types.Mixed, default: null },
    closeNote: { type: String, trim: true, default: null },
  },
  { collection: 'pos_sessions' },
);

posSessionSchema.plugin(baseSchemaPlugin);

/**
 * One open shift per till, and one per cashier. Partial on `status: 'OPEN'`, so closed shifts
 * pile up freely while two people can never both be "on" the same drawer — which is the only way
 * a variance means anything.
 */
posSessionSchema.index(
  { orgId: 1, locationId: 1, terminalCode: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'one_open_per_till' },
);
posSessionSchema.index(
  { orgId: 1, openedByUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'one_open_per_cashier' },
);
posSessionSchema.index({ orgId: 1, locationId: 1, openedAt: -1 });

export const PosSession: Model<PosSessionDoc> = model<PosSessionDoc>(
  'PosSession',
  posSessionSchema,
);
