import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { AUDIT_ACTIONS } from '../../shared/enums.js';

export { creditOverridesQuerySchema } from '../../shared/audit.js';

export const listAuditQuerySchema = listQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id')
    .optional(),
});

export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
