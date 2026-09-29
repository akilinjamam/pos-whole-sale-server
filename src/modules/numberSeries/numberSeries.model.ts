import { Schema, model } from 'mongoose';

import { DOC_SERIES } from '../../shared/enums.js';
import { RESET_POLICIES } from '../../shared/numbering.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { DocSeries } from '@shared/enums.js';
import type { ResetPolicy } from '@shared/numbering.js';
import type { Model, Types } from 'mongoose';

/**
 * How one org numbers one kind of document — prefix, padding, reset policy (§6.1, Day 17).
 *
 * Optional: a series with no row uses `defaultSeriesConfig`, which is exactly what Day 14 was
 * already issuing, so introducing this collection renumbers nothing.
 *
 * Editing a series is safe for numbers already issued. The counter is keyed by series and period,
 * not by prefix, so a new prefix continues the same sequence; and a new reset policy changes the
 * period *inside* the number (`WS-2627-…` → `WS-202609-…`), so old and new numbers cannot collide.
 */
export interface NumberSeriesDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  series: DocSeries;
  prefix: string;
  padding: number;
  resetPolicy: ResetPolicy;
  separator: string;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const numberSeriesSchema = new Schema<NumberSeriesDoc>(
  {
    ...auditableFields,
    series: { type: String, enum: DOC_SERIES, required: true },
    prefix: { type: String, required: true, trim: true, uppercase: true },
    padding: { type: Number, required: true, min: 3, max: 10 },
    resetPolicy: { type: String, enum: RESET_POLICIES, required: true },
    separator: { type: String, default: '-' },
  },
  { collection: 'number_series' },
);

numberSeriesSchema.plugin(baseSchemaPlugin);
numberSeriesSchema.index({ orgId: 1, series: 1 }, { unique: true });

export const NumberSeries: Model<NumberSeriesDoc> = model<NumberSeriesDoc>(
  'NumberSeries',
  numberSeriesSchema,
);
