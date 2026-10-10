import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { GRN_STATUSES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listGrnQuerySchema = listQuerySchema.extend({
  status: z.enum(GRN_STATUSES).optional(),
  supplierPartyId: objectId.optional(),
  locationId: objectId.optional(),
  poId: objectId.optional(),
});

export type ListGrnQuery = z.infer<typeof listGrnQuerySchema>;

/** The purchase register's period (default: this month to today) and filters. */
export const registerQuerySchema = z
  .object({
    from: z.string().date('Use YYYY-MM-DD').optional(),
    to: z.string().date('Use YYYY-MM-DD').optional(),
    supplierPartyId: objectId.optional(),
    locationId: objectId.optional(),
  })
  .strict();

export type RegisterQuery = z.infer<typeof registerQuerySchema>;

export { cancelGrnSchema, createGrnSchema, updateGrnSchema } from '../../shared/purchasing.js';
