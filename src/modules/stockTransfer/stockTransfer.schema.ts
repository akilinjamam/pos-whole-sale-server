import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { TRANSFER_STATUSES } from '../../shared/enums.js';

export { createTransferSchema, updateTransferSchema } from '../../shared/stockDocs.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listTransfersQuerySchema = listQuerySchema.extend({
  status: z.enum(TRANSFER_STATUSES).optional(),
  /** Either end — "every transfer touching the counter". */
  locationId: objectId.optional(),
});

export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;
