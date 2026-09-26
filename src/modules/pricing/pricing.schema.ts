import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/**
 * `GET /pricing/resolve` — every parameter a string on the wire, coerced here.
 *
 * `partyId` is optional: without it the price is the counter's (retail tier, then default).
 * `uomCode` defaults to the product's base unit, and `date` to today in the org's time zone.
 */
export const resolveQuerySchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  partyId: objectId.optional(),
  uomCode: z.string().trim().toUpperCase().max(10).optional(),
  qty: z.coerce.number().int('A whole quantity').min(1, 'At least 1').max(1_000_000).default(1),
  date: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ResolveQuery = z.infer<typeof resolveQuerySchema>;
