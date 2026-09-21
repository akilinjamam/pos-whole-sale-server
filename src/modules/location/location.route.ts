import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './location.controller.js';
import {
  createLocationSchema,
  idParamSchema,
  listLocationsQuerySchema,
  updateLocationSchema,
} from './location.schema.js';

const locationRouter = Router();

locationRouter.get(
  '/',
  authenticate,
  requirePermission('location:read'),
  validate({ query: listLocationsQuerySchema }),
  ctrl.list,
);

locationRouter.post(
  '/',
  authenticate,
  requirePermission('location:create'),
  validate({ body: createLocationSchema }),
  ctrl.create,
);

locationRouter.get(
  '/:id',
  authenticate,
  requirePermission('location:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

locationRouter.patch(
  '/:id',
  authenticate,
  requirePermission('location:update'),
  validate({ params: idParamSchema, body: updateLocationSchema }),
  ctrl.update,
);

// DELETE deactivates — see the service. The route keeps the verb the client expects while the
// document survives for the ledger rows that point at it.
locationRouter.delete(
  '/:id',
  authenticate,
  requirePermission('location:delete'),
  validate({ params: idParamSchema }),
  ctrl.deactivate,
);

export default locationRouter;
