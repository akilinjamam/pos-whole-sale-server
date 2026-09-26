import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

/** Body schemas live in `@shared/pricing` — the grid and the importer validate with the same ones. */
export {
  bulkAdjustSchema,
  createPriceEntrySchema,
  priceImportSchema,
  updatePriceEntrySchema,
} from '../../shared/pricing.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listPriceEntriesQuerySchema = listQuerySchema.extend({
  tierId: objectId.optional(),
  partyId: objectId.optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  uomCode: z.string().trim().toUpperCase().max(10).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Only entries whose window includes this day — "what is in force on …". */
  activeOn: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ListPriceEntriesQuery = z.infer<typeof listPriceEntriesQuerySchema>;
