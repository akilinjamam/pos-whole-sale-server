import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { listLedgerQueryFields } from '../../shared/ledger.js';

export { openingBalanceImportSchema } from '../../shared/ledger.js';

export const listLedgerQuerySchema = listQuerySchema.extend(listLedgerQueryFields);
export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>;

/** Reconcile takes nothing — the whole org, every party. */
export const reconcileBodySchema = z.object({}).strict();
