/**
 * Purchase order inputs (Day 32). Shared: the purchase screens validate with the same schemas.
 *
 * Unlike a sales order, a PO's prices are *ours to type*: what the supplier quoted. A line's cost
 * defaults to the product's moving-average cost (else its standard cost) in the line's unit, and
 * the server recomputes every total — the client sends quantities and unit costs, never totals.
 */

import { z } from 'zod';

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
