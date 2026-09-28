import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { ADJUSTMENT_REASONS, DOCUMENT_STATUSES } from '../../shared/enums.js';

/** Bodies live in `@shared/stockDocs` — the Day-16 editor validates with the same schemas. */
export {
  cancelDocSchema,
  createAdjustmentSchema,
  updateAdjustmentSchema,
} from '../../shared/stockDocs.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listAdjustmentsQuerySchema = listQuerySchema.extend({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  locationId: objectId.optional(),
  reason: z.enum(ADJUSTMENT_REASONS).optional(),
});

export type ListAdjustmentsQuery = z.infer<typeof listAdjustmentsQuerySchema>;
