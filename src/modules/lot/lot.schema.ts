import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const listLotsQuerySchema = listQuerySchema.extend({
  productId: objectId.optional(),
  /** Only lots with stock somewhere — the default for a working list. */
  inStock: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListLotsQuery = z.infer<typeof listLotsQuerySchema>;

export const expiringQuerySchema = z.object({
  /** Lots expiring within this many days — and every lot already expired. */
  withinDays: z.coerce.number().int().min(0).max(3650).default(90),
  locationId: objectId.optional(),
});

export type ExpiringQuery = z.infer<typeof expiringQuerySchema>;
