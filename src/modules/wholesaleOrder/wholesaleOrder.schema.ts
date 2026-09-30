import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { FULFILLMENT_STATUSES, ORDER_STATUSES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listOrdersQuerySchema = listQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  fulfillmentStatus: z.enum(FULFILLMENT_STATUSES).optional(),
  dealerPartyId: objectId.optional(),
  locationId: objectId.optional(),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
