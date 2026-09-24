import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { variantAxesSchema } from '../../shared/variant.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const createVariantSchema = z
  .object({
    productId: objectId,
    axes: variantAxesSchema,
    /** Derived from the product's SKU and the variant key when omitted — see the service. */
    sku: z.string().trim().toUpperCase().max(80).optional(),
    barcode: z.string().trim().min(4).max(60).nullable().optional(),
    priceDeltaMinor: z.number().int().min(-99_999_999).max(99_999_999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateVariantInput = z.infer<typeof createVariantSchema>;

/**
 * Axes are **not** updatable: they are the identity, and `variantKey` is derived from them.
 *
 * Changing them would silently re-point every stock balance and ledger row that names this
 * variant at a different lens. A variant created with the wrong power is deactivated and the
 * right one generated — which costs nothing, because generating is one click.
 */
export const updateVariantSchema = z
  .object({
    barcode: z.string().trim().min(4).max(60).nullable().optional(),
    priceDeltaMinor: z.number().int().min(-99_999_999).max(99_999_999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

/**
 * A bounded sub-range of the product's declared grid.
 *
 * Every bound is optional; an omitted one falls back to the product's own declaration, so
 * "generate everything I said was legal" is an empty body. What is *not* allowed is a bound
 * outside the declaration — that is the whole point of declaring one.
 */
export const generateVariantsSchema = z
  .object({
    productId: objectId,
    sphFrom: z.number().min(-30).max(30).optional(),
    sphTo: z.number().min(-30).max(30).optional(),
    cylFrom: z.number().min(-15).max(15).optional(),
    cylTo: z.number().min(-15).max(15).optional(),
    addFrom: z.number().min(0).max(6).optional(),
    addTo: z.number().min(0).max(6).optional(),
    /**
     * Cylinder axes to materialise. Omitted means "do not vary by axis" — most stock lenses are
     * held without one, and a full 0–180 sweep would multiply the count by 181.
     */
    axes: z.array(z.number().int().min(0).max(180)).max(181).optional(),
    /** Frames and accessories: the colours and sizes to cross. */
    colors: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    sizes: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    priceDeltaMinor: z.number().int().min(-99_999_999).max(99_999_999).optional(),
    /** Report what would be created without writing anything — drives the UI's live count. */
    dryRun: z.boolean().optional(),
  })
  .strict();

export type GenerateVariantsInput = z.infer<typeof generateVariantsSchema>;

export const listVariantsQuerySchema = listQuerySchema.extend({
  productId: objectId,
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListVariantsQuery = z.infer<typeof listVariantsQuerySchema>;
