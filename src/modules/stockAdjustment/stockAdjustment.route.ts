import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './stockAdjustment.controller.js';
import {
  cancelDocSchema,
  createAdjustmentSchema,
  idParamSchema,
  listAdjustmentsQuerySchema,
  updateAdjustmentSchema,
} from './stockAdjustment.schema.js';

/**
 * Stock adjustments. Reads on `stock:read`; everything that changes one on `stock:adjust`.
 *
 * `requireLocation` checks a `locationId` in the body or query; routes that name only the
 * document id check the document's own location in the service.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listAdjustmentsQuerySchema }),
  ctrl.list,
);
router.post(
  '/',
  authenticate,
  requirePermission('stock:adjust'),
  requireLocation,
  validate({ body: createAdjustmentSchema }),
  ctrl.create,
);
router.get(
  '/:id',
  authenticate,
  requirePermission('stock:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);
router.patch(
  '/:id',
  authenticate,
  requirePermission('stock:adjust'),
  requireLocation,
  validate({ params: idParamSchema, body: updateAdjustmentSchema }),
  ctrl.update,
);
router.delete(
  '/:id',
  authenticate,
  requirePermission('stock:adjust'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('stock:adjust'),
  validate({ params: idParamSchema }),
  ctrl.post,
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('stock:adjust'),
  validate({ params: idParamSchema, body: cancelDocSchema }),
  ctrl.cancel,
);

export default router;
