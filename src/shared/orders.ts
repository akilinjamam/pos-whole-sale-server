/**
 * Wholesale order inputs (Day 22). Shared: the Day-23 order builder validates with the same
 * schemas the server applies.
 *
 * Like a counter sale, an order sends **quantities, never totals**. Every save re-resolves each
 * line's price through the pricing engine and recomputes the totals server-side. A client price
 * is honoured only as an override by someone holding `order:priceOverride`; a discount — per line
 * or on the whole order — only for someone holding `order:discount`.
 */

import { z } from 'zod';

import { orderDiscountSchema } from './pos.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const day = z.string().date('Use YYYY-MM-DD');
const reasonText = z.string().trim().min(3, 'Say why, in a few words').max(300);

export const MAX_ORDER_LINES = 500;

export const orderLineInputSchema = z
  .object({
    productId: objectId,
    variantId: objectId.nullable().optional(),
    /** Defaults to the product's base unit. */
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(1_000_000),
    /** A price other than the resolved one, per `uomCode`. Needs `order:priceOverride`. */
    unitPriceMinor: minor.optional(),
    /** An extra discount on this line, on top of the dealer's trade terms. Needs `order:discount`. */
    discountPct: z.number().min(0).max(100).optional(),
  })
  .strict();

const orderFields = {
  dealerPartyId: objectId,
  /** The warehouse the order reserves against and ships from. */
  locationId: objectId,
  /** Defaults to today. */
  orderDate: day.optional(),
  requiredDate: day.nullable().optional(),
  /** A draft may be saved with no lines; confirming needs at least one. */
  lines: z.array(orderLineInputSchema).max(MAX_ORDER_LINES),
  /** Order-level discount, prorated to the lines by largest remainder. Needs `order:discount`. */
  orderDiscount: orderDiscountSchema.nullable().optional(),
  shippingMinor: minor.optional(),
  /** One of the dealer's addresses. Default: the dealer's default shipping / billing address. */
  shippingAddressId: objectId.nullable().optional(),
  billingAddressId: objectId.nullable().optional(),
  /** Default: the dealer's terms, else the org's. */
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  note: z.string().trim().max(500).nullable().optional(),
};

export const createOrderSchema = z.object(orderFields).strict();

/** A draft is freely editable: send any subset. `lines`, when sent, replaces them all. */
export const updateOrderSchema = z.object(orderFields).partial().strict();

/** Price an order without saving it — the builder's live panel. */
export const quoteOrderSchema = createOrderSchema;

export const confirmOrderSchema = z
  .object({
    /**
     * For a holder of `order:creditOverride` confirming an order the credit check refuses: why the
     * company is lending past the limit. Without the permission the order goes to approval instead.
     */
    creditOverrideReason: reasonText.optional(),
  })
  .strict();

/** Approve, reject, and cancel past draft: each needs a reason on record. */
export const orderReasonSchema = z.object({ reason: reasonText }).strict();

/** Cancelling a draft needs no reason; anything further along does (the service enforces which). */
export const cancelOrderSchema = z.object({ reason: reasonText.optional() }).strict();

export type OrderLineInput = z.infer<typeof orderLineInputSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type QuoteOrderInput = z.infer<typeof quoteOrderSchema>;
export type ConfirmOrderInput = z.infer<typeof confirmOrderSchema>;
export type OrderReasonInput = z.infer<typeof orderReasonSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
