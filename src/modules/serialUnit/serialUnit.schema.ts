import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { SERIAL_STATUSES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const listSerialsQuerySchema = listQuerySchema.extend({
  productId: objectId.optional(),
  status: z.enum(SERIAL_STATUSES).optional(),
  locationId: objectId.optional(),
  /** Warranties ending on or before this day, `YYYY-MM-DD` — "what runs out this month?" */
  warrantyEndingBefore: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ListSerialsQuery = z.infer<typeof listSerialsQuerySchema>;

export const serialParamSchema = z.object({ serialNo: z.string().trim().min(1).max(60) });
