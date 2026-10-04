import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { SALES_CHANNELS } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listInvoicesQuerySchema = listQuerySchema.extend({
  orderId: objectId.optional(),
  dispatchId: objectId.optional(),
  partyId: objectId.optional(),
  channel: z.enum(SALES_CHANNELS).optional(),
});

export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
