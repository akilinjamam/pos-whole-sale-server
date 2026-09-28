import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './stockCount.controller.js';
import {
  createCountSchema,
  idParamSchema,
  listCountsQuerySchema,
  postCountSchema,
  recordCountSchema,
} from './stockCount.schema.js';

/**
 * Stock counts. Reads on `stock:read`; opening, recording, posting and cancelling on
 * `stock:count`. The count's own location is checked in the service on every id route.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listCountsQuerySchema }),
  ctrl.list,
);
router.post(
  '/',
  authenticate,
  requirePermission('stock:count'),
  requireLocation,
  validate({ body: createCountSchema }),
  ctrl.open,
);
router.get(
  '/:id',
  authenticate,
  requirePermission('stock:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);
router.post(
  '/:id/record',
  authenticate,
  requirePermission('stock:count'),
  validate({ params: idParamSchema, body: recordCountSchema }),
  ctrl.record,
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('stock:count'),
  validate({ params: idParamSchema, body: postCountSchema }),
  ctrl.post,
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('stock:count'),
  validate({ params: idParamSchema }),
  ctrl.cancel,
);

export default router;
