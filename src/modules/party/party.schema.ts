import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';

/**
 * Body schemas live in `@shared/party` — the dealer editor validates against the same objects.
 * What stays here is the server-only half: path params and list query strings.
 */
export {
  createCustomerSchema,
  createDealerSchema,
  createSupplierSchema,
  dealerCreditHoldSchema,
  dealerCreditLimitSchema,
  enrolCustomerSchema,
  enrolDealerSchema,
  enrolSupplierSchema,
  updateCustomerSchema,
  updateDealerSchema,
  updateSupplierSchema,
} from '../../shared/party.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/**
 * One query schema for all three role lists. The dealer-only filters are simply ignored on the
 * customer and supplier lists by the service, rather than each role getting its own schema: a
 * filter that matches nothing is harmless, and three near-identical schemas would drift.
 */
export const listPartiesQuerySchema = listQuerySchema.extend({
  isActive: booleanFlag,
  tag: z.string().trim().min(1).max(30).optional(),
  /** Parties that also hold this other role — "dealers who are also suppliers". */
  alsoRole: z.enum(['DEALER', 'CUSTOMER', 'SUPPLIER']).optional(),

  // Dealer list only.
  creditHold: booleanFlag,
  salespersonUserId: objectId.optional(),
  priceTierId: objectId.optional(),
  territory: z.string().trim().min(1).max(60).optional(),
});

export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;

/** The "already on file?" search before creating a new party. */
export const candidatesQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(120),
});

export type CandidatesQuery = z.infer<typeof candidatesQuerySchema>;
