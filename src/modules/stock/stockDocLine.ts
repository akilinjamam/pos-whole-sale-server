import { Schema } from 'mongoose';

import { idToString } from '../../lib/model.js';

import type { StockDocLinePayload } from '@shared/types.js';
import type { Types } from 'mongoose';

/**
 * A line on an adjustment or transfer: what was entered, and the base quantity it means.
 *
 * Both are stored. `qtyBase` is what the stock engine posts; `uomCode` + `qty` is what the person
 * typed and what the printed document shows — "5 DOZ", not "60".
 */
export interface StockDocLineDoc {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  qty: number;
  qtyBase: number;
}

export const stockDocLineSchema = new Schema<StockDocLineDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true, trim: true, uppercase: true },
    qty: { type: Number, required: true },
    qtyBase: { type: Number, required: true },
  },
  { _id: false },
);

export type LineNames = (l: {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
}) => {
  productName?: string;
  sku?: string;
  baseUom?: string;
  variantLabel?: string | null;
};

export function toStockDocLinePayload(
  line: StockDocLineDoc,
  names?: LineNames,
): StockDocLinePayload {
  const n = names?.(line) ?? {};
  return {
    productId: String(line.productId),
    variantId: idToString(line.variantId),
    uomCode: line.uomCode,
    qty: line.qty,
    qtyBase: line.qtyBase,
    productName: n.productName,
    sku: n.sku,
    variantLabel: n.variantLabel,
  };
}
