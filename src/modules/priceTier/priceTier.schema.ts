import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

/** Body schemas live in `@shared/pricing`; the tier editor validates against the same objects. */
export { createPriceTierSchema, updatePriceTierSchema } from '../../shared/pricing.js';

export const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id'),
});

export const listPriceTiersQuerySchema = listQuerySchema.extend({
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListPriceTiersQuery = z.infer<typeof listPriceTiersQuerySchema>;
