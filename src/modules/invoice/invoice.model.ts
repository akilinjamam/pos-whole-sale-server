import { Schema, model } from 'mongoose';

import { DOCUMENT_STATUSES, PAYMENT_STATUSES, SALES_CHANNELS } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { DocumentStatus, PaymentStatus, SalesChannel } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * An invoice — wholesale (`WS`, raised on dispatch, Day 24) or counter (`POS`, Day 18). §6.9.
 *
 * Money on the lines and the header is minor units, and the header totals are **stored**, not
 * derived on read: an invoice is a legal document, and what it said when it was posted must be
 * what it says forever — even after a price list, a tax rate or the product itself changes. For
 * the same reason the party's name and address are **snapshotted** at post time.
 *
 * `balanceMinor` = grand total − paid − credited, maintained by receipts (Day 28) and credit notes
 * (Day 36) with `$inc` in their own transactions. `paymentStatus` follows it.
 */
export interface InvoiceLineDoc {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  /** What the line printed as — frozen, like everything else on a posted invoice. */
  description: string;
  lotId: Types.ObjectId | null;
  serials: string[];
  uomCode: string;
  uomQty: number;
  qtyBase: number;
  unitPriceMinor: number;
  /** The line's own discount plus its prorated share of the order discount (`computeTotals`). */
  discountMinor: number;
  /** VAT fields are held at zero until open question 1 (VAT/Mushak) is answered. */
  taxPct: number;
  taxMinor: number;
  lineTotalMinor: number;
  /** Moving-average cost at the moment of sale — what gross margin (Day 37) is measured against. */
  costAtSaleMinor: number | null;
  /** Set when the price was overridden by someone with `order:priceOverride`. */
  priceOverridden: boolean;
  originalPriceMinor: number | null;
}

export interface InvoiceDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  /** Null while a draft. Allocated from `series` at post time. */
  docNo: string | null;
  series: 'WS' | 'POS';
  channel: SalesChannel;
  partyId: Types.ObjectId | null;
  walkInName: string | null;
  walkInPhone: string | null;
  partySnapshot: {
    name: string;
    phone: string | null;
    address: string | null;
    tin: string | null;
    bin: string | null;
  } | null;
  locationId: Types.ObjectId;
  orderId: Types.ObjectId | null;
  dispatchId: Types.ObjectId | null;
  posSessionId: Types.ObjectId | null;
  invoiceDate: Date;
  dueDate: Date | null;
  paymentTermsDays: number;
  status: DocumentStatus;
  lines: InvoiceLineDoc[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  roundingMinor: number;
  grandTotalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
  paymentStatus: PaymentStatus;
  salespersonUserId: Types.ObjectId | null;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<InvoiceLineDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    description: { type: String, required: true, trim: true },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', default: null },
    serials: { type: [String], default: [] },
    uomCode: { type: String, required: true },
    uomQty: { type: Number, required: true },
    qtyBase: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxPct: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    lineTotalMinor: { type: Number, required: true },
    costAtSaleMinor: { type: Number, default: null },
    priceOverridden: { type: Boolean, default: false },
    originalPriceMinor: { type: Number, default: null },
  },
  { _id: true },
);

const snapshotSchema = new Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, default: null },
    address: { type: String, default: null },
    tin: { type: String, default: null },
    bin: { type: String, default: null },
  },
  { _id: false },
);

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    series: { type: String, enum: ['WS', 'POS'], required: true },
    channel: { type: String, enum: SALES_CHANNELS, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    walkInName: { type: String, trim: true, default: null },
    walkInPhone: { type: String, trim: true, default: null },
    partySnapshot: { type: snapshotSchema, default: null },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    orderId: { type: Schema.Types.ObjectId, default: null },
    dispatchId: { type: Schema.Types.ObjectId, default: null },
    posSessionId: { type: Schema.Types.ObjectId, default: null },
    invoiceDate: { type: Date, required: true },
    dueDate: { type: Date, default: null },
    paymentTermsDays: { type: Number, default: 0 },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'DRAFT' },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    discountMinor: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    shippingMinor: { type: Number, default: 0 },
    roundingMinor: { type: Number, default: 0 },
    grandTotalMinor: { type: Number, default: 0 },
    paidMinor: { type: Number, default: 0 },
    creditedMinor: { type: Number, default: 0 },
    balanceMinor: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'UNPAID' },
    salespersonUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
  },
  { collection: 'invoices' },
);

invoiceSchema.plugin(baseSchemaPlugin);

// §10's hard backstop: one number, one invoice, per series. Drafts (docNo null) are exempt.
invoiceSchema.index(
  { orgId: 1, series: 1, docNo: 1 },
  {
    unique: true,
    partialFilterExpression: { docNo: { $type: 'string' } },
    name: 'invoice_number_unique',
  },
);
// A dealer's invoices by date — the statement and the dealer profile's Invoices tab.
invoiceSchema.index({ orgId: 1, partyId: 1, invoiceDate: -1 });
// Ageing (Day 30): open invoices by how overdue they are.
invoiceSchema.index({ orgId: 1, paymentStatus: 1, dueDate: 1 });
// Sales by channel and period (Day 37).
invoiceSchema.index({ orgId: 1, channel: 1, invoiceDate: -1 });
invoiceSchema.index(
  { orgId: 1, posSessionId: 1 },
  { partialFilterExpression: { posSessionId: { $type: 'objectId' } } },
);

export const Invoice: Model<InvoiceDoc> = model<InvoiceDoc>('Invoice', invoiceSchema);
