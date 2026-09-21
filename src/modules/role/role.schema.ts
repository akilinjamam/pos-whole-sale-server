import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { ALL_PERMISSIONS } from '../../shared/permissions.js';

/**
 * `permissionList` validates against the catalog at the boundary, so an unknown permission is
 * a 422 naming the offending entry rather than a string quietly stored on a role that nothing
 * will ever check. This is the runtime half of the guarantee `Permission` gives at compile
 * time — the compiler protects our code, this protects us from the client's.
 */
const permissionList = z
  .array(z.string())
  .max(ALL_PERMISSIONS.length)
  .superRefine((values, ctx) => {
    const known = new Set<string>(ALL_PERMISSIONS);
    values.forEach((value, index) => {
      if (!known.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Unknown permission "${value}"`,
        });
      }
    });
  })
  .transform((values) => [...new Set(values)]);

export const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id'),
});

export const createRoleSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscores'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    permissions: permissionList.default([]),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

// `code` is immutable: users reference roles by id, but the seed, the tests and any future
// "is this the cashier role" check reference them by code.
export const updateRoleSchema = createRoleSchema.omit({ code: true }).partial().strict();

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const listRolesQuerySchema = listQuerySchema.extend({
  isSystem: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;
