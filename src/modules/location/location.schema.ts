import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { LOCATION_TYPES } from '../../shared/enums.js';

export const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id'),
});

export const createLocationSchema = z
  .object({
    code: z.string().trim().min(1).max(20).toUpperCase(),
    name: z.string().trim().min(1).max(120),
    type: z.enum(LOCATION_TYPES),
    address: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    allowsSales: z.boolean().optional(),
    allowsPurchase: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export type CreateLocationInput = z.infer<typeof createLocationSchema>;

// `code` is absent: it is the natural key that ledger rows and balances were written against,
// and renaming it would orphan them. A mistyped code is fixed by deactivating and recreating.
export const updateLocationSchema = createLocationSchema.omit({ code: true }).partial().strict();

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const listLocationsQuerySchema = listQuerySchema.extend({
  type: z.enum(LOCATION_TYPES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
