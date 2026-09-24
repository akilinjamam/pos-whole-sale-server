import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { PRODUCT_TYPES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(80),
    /** Null or absent creates a root. */
    parentId: objectId.nullable().optional(),
    productType: z.enum(PRODUCT_TYPES).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial().strict();

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listCategoriesQuerySchema = listQuerySchema.extend({
  /** Direct children of this node. Pass `root` for the top level. */
  parentId: z.union([objectId, z.literal('root')]).optional(),
  /** The whole subtree beneath this node, at any depth. */
  under: objectId.optional(),
  productType: z.enum(PRODUCT_TYPES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
