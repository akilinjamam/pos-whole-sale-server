import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { STOCK_MOVEMENT_TYPES } from '../../shared/enums.js';

/** The opening-import body lives in `@shared/stock`, alongside the movement sign table. */
export { openingImportSchema } from '../../shared/stock.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const listBalancesQuerySchema = listQuerySchema.extend({
  locationId: objectId.optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  /** Hide rows at zero on hand and zero reserved — the usual stock-on-hand view. */
  nonZero: flag,
});

export type ListBalancesQuery = z.infer<typeof listBalancesQuerySchema>;

export const listLedgerQuerySchema = listQuerySchema.extend({
  /** A document number — `ADJ-2627-00012` — to see exactly what that document moved. */
  refDocNo: z.string().trim().toUpperCase().max(40).optional(),
  serialNo: z.string().trim().toUpperCase().max(60).optional(),
  locationId: objectId.optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  movementType: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  refType: z.string().trim().max(40).optional(),
  refId: objectId.optional(),
  /** Inclusive `YYYY-MM-DD` bounds on `postedAt`, in the org's time zone. */
  from: z.string().date('Use YYYY-MM-DD').optional(),
  to: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>;

export const reconcileBodySchema = z.object({ locationId: objectId.optional() }).strict();

export type ReconcileBody = z.infer<typeof reconcileBodySchema>;
