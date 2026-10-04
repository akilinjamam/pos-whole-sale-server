import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { DISPATCH_STATUSES } from '../../shared/enums.js';

export {
  cancelDispatchSchema,
  createDispatchSchema,
  updateDispatchSchema,
} from '../../shared/dispatch.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listDispatchesQuerySchema = listQuerySchema.extend({
  status: z.enum(DISPATCH_STATUSES).optional(),
  orderId: objectId.optional(),
  dealerPartyId: objectId.optional(),
  locationId: objectId.optional(),
});

export type ListDispatchesQuery = z.infer<typeof listDispatchesQuerySchema>;
