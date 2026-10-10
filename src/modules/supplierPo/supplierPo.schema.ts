import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { PO_STATUSES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listPoQuerySchema = listQuerySchema.extend({
  status: z.enum(PO_STATUSES).optional(),
  supplierPartyId: objectId.optional(),
  locationId: objectId.optional(),
  /** Only POs that can still be received against — the goods receipt screen's picker. */
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListPoQuery = z.infer<typeof listPoQuerySchema>;

export const reorderQuerySchema = z
  .object({
    /** Judge stock at one location; default: every sellable location the caller can see. */
    locationId: objectId.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export type ReorderQuery = z.infer<typeof reorderQuerySchema>;

export {
  cancelPoSchema,
  createPoSchema,
  poReasonSchema,
  updatePoSchema,
} from '../../shared/purchasing.js';
