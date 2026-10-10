import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { CHEQUE_STATUSES, PAYMENT_METHODS } from '../../shared/enums.js';

export {
  allocateReceiptSchema,
  allocationPreviewQuerySchema,
  ageingQuerySchema,
  bounceChequeSchema,
  chequeSchema,
  clearChequeSchema,
  collectionSheetQuerySchema,
  depositChequeSchema,
  receiptSchema,
  allocateSupplierPaymentSchema,
  payablesPreviewQuerySchema,
  supplierPaymentSchema,
} from '../../shared/payments.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listReceiptsQuerySchema = listQuerySchema.extend({
  partyId: objectId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  /** Only receipts with an advance left on them — the "unapplied receipts" screen. */
  unallocated: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;

/** Supplier payments (Day 35) list the same way; `unallocated` finds advances to suppliers. */
export const listSupplierPaymentsQuerySchema = listReceiptsQuerySchema;
export type ListSupplierPaymentsQuery = ListReceiptsQuery;

/** The cheque register: by status, by party, and — `dueBy` — cheques dated on or before a day. */
export const listChequesQuerySchema = listQuerySchema.extend({
  status: z.enum(CHEQUE_STATUSES).optional(),
  partyId: objectId.optional(),
  dueBy: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ListChequesQuery = z.infer<typeof listChequesQuerySchema>;
