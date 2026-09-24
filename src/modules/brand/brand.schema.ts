import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

export const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id'),
});

export const createBrandSchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(80),
    /** Derived from `name` when omitted — see the service. */
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'Lower-case letters, digits and hyphens only')
      .optional(),
    logoUrl: z.string().trim().url().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateBrandInput = z.infer<typeof createBrandSchema>;

export const updateBrandSchema = createBrandSchema.partial().strict();

export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;

export const listBrandsQuerySchema = listQuerySchema.extend({
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListBrandsQuery = z.infer<typeof listBrandsQuerySchema>;
