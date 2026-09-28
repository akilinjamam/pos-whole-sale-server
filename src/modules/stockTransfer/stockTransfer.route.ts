import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './stockTransfer.controller.js';
import {
  createTransferSchema,
  idParamSchema,
  listTransfersQuerySchema,
  updateTransferSchema,
} from './stockTransfer.schema.js';

/**
 * Stock transfers. Reads on `stock:read`; writes on `stock:transfer`.
 *
 * Location access is checked in the service, end by end: the **source** to create, edit and
 * dispatch; the **destination** to receive. `requireLocation` is used only on the list, where a
 * `locationId` filter must be one of the caller's own.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listTransfersQuerySchema }),
  ctrl.list,
);
router.post(
  '/',
  authenticate,
  requirePermission('stock:transfer'),
  validate({ body: createTransferSchema }),
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
  requirePermission('stock:transfer'),
  validate({ params: idParamSchema, body: updateTransferSchema }),
  ctrl.update,
);
router.delete(
  '/:id',
  authenticate,
  requirePermission('stock:transfer'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('stock:transfer'),
  validate({ params: idParamSchema }),
  ctrl.post,
);
router.post(
  '/:id/receive',
  authenticate,
  requirePermission('stock:transfer'),
  validate({ params: idParamSchema }),
  ctrl.receive,
);

export default router;
