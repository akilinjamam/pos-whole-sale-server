import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { COUNT_STATUSES } from '../../shared/enums.js';

export {
  createCountSchema,
  postCountSchema,
  recordCountSchema,
} from '../../shared/stockDocs.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listCountsQuerySchema = listQuerySchema.extend({
  status: z.enum(COUNT_STATUSES).optional(),
  locationId: objectId.optional(),
});

export type ListCountsQuery = z.infer<typeof listCountsQuerySchema>;
