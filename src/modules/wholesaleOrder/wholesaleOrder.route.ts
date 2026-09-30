import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './wholesaleOrder.controller.js';
import { idParamSchema, listOrdersQuerySchema } from './wholesaleOrder.schema.js';

/**
 * Wholesale orders. Reads on `order:read`; each order carries `availableActions` — what the
 * caller may do to it next, straight from the state machine.
 *
 * Day 21 exposes reads only. The writes (draft CRUD, confirm, cancel — Day 22; dispatch — Day 24;
 * short close — Day 26) each arrive as their own endpoint, because each has its own stock and
 * ledger effects. There is deliberately no generic "set status" endpoint.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('order:read'),
  requireLocation,
  validate({ query: listOrdersQuerySchema }),
  ctrl.list,
);
router.get(
  '/:id',
  authenticate,
  requirePermission('order:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

export default router;
