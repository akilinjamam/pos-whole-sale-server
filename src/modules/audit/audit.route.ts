import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { creditOverridesQuerySchema, listAuditQuerySchema } from './audit.schema.js';
import { creditOverrides, listAudit } from './audit.service.js';

import type { ListAuditQuery } from './audit.schema.js';
import type { CreditOverridesQuery } from '@shared/audit.js';

/**
 * The audit log (Day 31). Read-only — entries are written only by the acts they record, through
 * `services/audit.service.ts`, and the model refuses updates and deletes.
 *
 * The raw log is on `audit:read` (owner, admin, accounts). The credit overrides dashboard is on
 * `order:approve` instead: it is for the managers who decide overrides, and they hold that, not
 * the full log.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('audit:read'),
  validate({ query: listAuditQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await listAudit(requestActorOf(req), req.query as unknown as ListAuditQuery);
    sendPage(res, page.items, page.meta);
  }),
);

router.get(
  '/credit-overrides',
  authenticate,
  requirePermission('order:approve'),
  validate({ query: creditOverridesQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await creditOverrides(requestActorOf(req), req.query as unknown as CreditOverridesQuery),
    );
  }),
);

export default router;
