import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './dispatch.controller.js';
import {
  cancelDispatchSchema,
  createDispatchSchema,
  deliverDispatchSchema,
  postDispatchSchema,
  idParamSchema,
  listDispatchesQuerySchema,
  updateDispatchSchema,
} from './dispatch.schema.js';

/**
 * Dispatches (challans). Each step has its own permission, matching the order transition it
 * drives — `dispatch:create` picks, `dispatch:pack` packs, `dispatch:post` ships — so a store
 * keeper can pick and pack while posting (stock out, invoice raised) stays with whoever is
 * allowed to send goods out of the building.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('dispatch:read'),
  requireLocation,
  validate({ query: listDispatchesQuerySchema }),
  ctrl.list,
);
router.post(
  '/',
  authenticate,
  requirePermission('dispatch:create'),
  validate({ body: createDispatchSchema }),
  ctrl.create,
);
router.get(
  '/:id',
  authenticate,
  requirePermission('dispatch:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);
router.patch(
  '/:id',
  authenticate,
  requirePermission('dispatch:create'),
  validate({ params: idParamSchema, body: updateDispatchSchema }),
  ctrl.update,
);
router.post(
  '/:id/pack',
  authenticate,
  requirePermission('dispatch:pack'),
  validate({ params: idParamSchema }),
  ctrl.pack,
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('dispatch:post'),
  validate({ params: idParamSchema, body: postDispatchSchema }),
  ctrl.post,
);
router.post(
  '/:id/deliver',
  authenticate,
  requirePermission('dispatch:deliver'),
  validate({ params: idParamSchema, body: deliverDispatchSchema }),
  ctrl.deliver,
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('dispatch:cancel'),
  validate({ params: idParamSchema, body: cancelDispatchSchema }),
  ctrl.cancel,
);

export default router;
