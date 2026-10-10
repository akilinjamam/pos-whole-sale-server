/**
 * Purchase order inputs (Day 32). Shared: the purchase screens validate with the same schemas.
 *
 * Unlike a sales order, a PO's prices are *ours to type*: what the supplier quoted. A line's cost
 * defaults to the product's moving-average cost (else its standard cost) in the line's unit, and
 * the server recomputes every total — the client sends quantities and unit costs, never totals.
 */

import { z } from 'zod';

import { QC_STATUSES, RETURN_REASONS } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const day = z.string().date('Use YYYY-MM-DD');
const reasonText = z.string().trim().min(3, 'Say why, in a few words').max(300);

export const MAX_PO_LINES = 500;

export const poLineInputSchema = z
  .object({
    productId: objectId,
    variantId: objectId.nullable().optional(),
    /** Defaults to the product's base unit. */
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(10_000_000),
    /** Per `uomCode`. Default: the product's current cost in that unit. */
    unitCostMinor: minor.optional(),
    /** The supplier's discount on this line. */
    discountPct: z.number().min(0).max(100).optional(),
  })
  .strict();

const poFields = {
  supplierPartyId: objectId,
  /** The warehouse the goods are delivered to. */
  locationId: objectId,
  /** Defaults to today. */
  orderDate: day.optional(),
  /** Default: order date + the supplier's lead time, when they have one. */
  expectedDate: day.nullable().optional(),
  /** A draft may be saved with no lines; approving needs at least one. */
  lines: z.array(poLineInputSchema).max(MAX_PO_LINES),
  /** Freight the supplier charges on top. */
  shippingMinor: minor.optional(),
  /** Default: the supplier's terms. */
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  /** The supplier's own reference — their quotation or proforma number. */
  supplierRef: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
};

export const createPoSchema = z.object(poFields).strict();

/** Only a draft is editable: send any subset. `lines`, when sent, replaces them all. */
export const updatePoSchema = z.object(poFields).partial().strict();

/** Reopen and short close need a reason on record. */
export const poReasonSchema = z.object({ reason: reasonText }).strict();

/** Cancelling a draft needs no reason; an approved or sent PO does (the machine enforces which). */
export const cancelPoSchema = z.object({ reason: reasonText.optional() }).strict();

export type PoLineInput = z.infer<typeof poLineInputSchema>;
export type CreatePoInput = z.infer<typeof createPoSchema>;
export type UpdatePoInput = z.infer<typeof updatePoSchema>;
export type PoReasonInput = z.infer<typeof poReasonSchema>;
export type CancelPoInput = z.infer<typeof cancelPoSchema>;

// ─── Goods receipts (Day 33) ────────────────────────────────────────────────────────────

/**
 * What arrived, line by line. Against a PO, each line names the PO line it fills (`poLineId`);
 * a direct receipt (no PO) names none. Lot-tracked goods carry their lot and dates; serialised
 * ones exactly one serial per unit. Costs default from the PO line (or the item's current cost on
 * a direct receipt), and only someone who may see costs (`stock:viewCost`) may type one.
 */
export const grnLineInputSchema = z
  .object({
    poLineId: objectId.nullable().optional(),
    productId: objectId,
    variantId: objectId.nullable().optional(),
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(10_000_000),
    /** Per `uomCode`. Needs `stock:viewCost`. */
    unitCostMinor: minor.optional(),
    discountPct: z.number().min(0).max(100).optional(),
    lotNo: z.string().trim().toUpperCase().max(40).nullable().optional(),
    mfgDate: day.nullable().optional(),
    expiryDate: day.nullable().optional(),
    serials: z.array(z.string().trim().toUpperCase().min(1).max(60)).max(10_000).optional(),
    qcStatus: z.enum(QC_STATUSES).optional(),
  })
  .strict();

const grnFields = {
  /** Null (or absent) for a direct receipt. */
  poId: objectId.nullable().optional(),
  /** Taken from the PO when there is one. */
  supplierPartyId: objectId.optional(),
  locationId: objectId.optional(),
  /** When the goods arrived. Default: now. */
  receivedAt: z.string().datetime({ offset: true }).optional(),
  /** The supplier's bill: its number is unique per supplier once posted. */
  supplierInvoiceNo: z.string().trim().toUpperCase().max(40).nullable().optional(),
  supplierInvoiceDate: day.nullable().optional(),
  lines: z.array(grnLineInputSchema).max(MAX_PO_LINES),
  /** Freight, clearing, loading — spread over the lines by value, into their landed cost. */
  otherChargesMinor: minor.optional(),
  note: z.string().trim().max(500).nullable().optional(),
};

export const createGrnSchema = z
  .object(grnFields)
  .strict()
  .refine((g) => g.poId || (g.supplierPartyId && g.locationId), {
    message: 'A direct receipt names its supplier and warehouse',
    path: ['supplierPartyId'],
  });

/** Only a draft is editable. `lines`, when sent, replaces them all. The PO cannot change. */
export const updateGrnSchema = z.object(grnFields).omit({ poId: true }).partial().strict();

export const cancelGrnSchema = z.object({ reason: reasonText.optional() }).strict();

export type GrnLineInput = z.infer<typeof grnLineInputSchema>;
export type CreateGrnInput = z.infer<typeof createGrnSchema>;
export type UpdateGrnInput = z.infer<typeof updateGrnSchema>;
export type CancelGrnInput = z.infer<typeof cancelGrnSchema>;

// ─── Purchase returns (Day 34) ──────────────────────────────────────────────────────────

/**
 * Goods going back to the supplier. Against a posted receipt, each line names the receipt line it
 * returns (`grnLineNo`) and its value is that line's own net cost — what the supplier billed for
 * those units — so no cost is typed. A direct return (no receipt) is valued at the item's current
 * cost unless someone who may see costs types the supplier's credit.
 */
export const purchaseReturnLineInputSchema = z
  .object({
    grnLineNo: z.number().int().min(1).nullable().optional(),
    productId: objectId,
    variantId: objectId.nullable().optional(),
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(10_000_000),
    /** Per `uomCode`, direct returns only. Needs `stock:viewCost`. */
    unitCostMinor: minor.optional(),
    lotNo: z.string().trim().toUpperCase().max(40).nullable().optional(),
    serials: z.array(z.string().trim().toUpperCase().min(1).max(60)).max(10_000).optional(),
  })
  .strict();

export const createPurchaseReturnSchema = z
  .object({
    /** The posted receipt the goods came in on; null (or absent) for a direct return. */
    grnId: objectId.nullable().optional(),
    /** Taken from the receipt when there is one. */
    supplierPartyId: objectId.optional(),
    /** Where the goods leave from. Default: the receipt's warehouse. */
    locationId: objectId.optional(),
    /** Defaults to today. */
    returnDate: day.optional(),
    reason: z.enum(RETURN_REASONS),
    note: z.string().trim().max(500).nullable().optional(),
    lines: z
      .array(purchaseReturnLineInputSchema)
      .min(1, 'Return at least one line')
      .max(MAX_PO_LINES),
  })
  .strict()
  .refine((r) => r.grnId || (r.supplierPartyId && r.locationId), {
    message: 'A direct return names its supplier and warehouse',
    path: ['supplierPartyId'],
  });

export type PurchaseReturnLineInput = z.infer<typeof purchaseReturnLineInputSchema>;
export type CreatePurchaseReturnInput = z.infer<typeof createPurchaseReturnSchema>;
