import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listPurchaseReturnQuerySchema = listQuerySchema.extend({
  supplierPartyId: objectId.optional(),
  locationId: objectId.optional(),
  grnId: objectId.optional(),
});

export type ListPurchaseReturnQuery = z.infer<typeof listPurchaseReturnQuerySchema>;

export { createPurchaseReturnSchema } from '../../shared/purchasing.js';
