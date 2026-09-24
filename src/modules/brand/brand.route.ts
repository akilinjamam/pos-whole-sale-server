import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './brand.controller.js';
import {
  createBrandSchema,
  idParamSchema,
  listBrandsQuerySchema,
  updateBrandSchema,
} from './brand.schema.js';

/**
 * Reads are gated on `product:read`, not a `brand:read` that does not exist.
 *
 * Anyone who can see a product needs its brand to render the row, so a separate read permission
 * would only ever be granted alongside `product:read` — a permission nobody can sensibly
 * withhold is noise in the matrix. Writing is its own grant (`brand:manage`), because renaming
 * a brand re-labels every report that groups by it.
 */
const brandRouter = Router();

brandRouter.get(
  '/',
  authenticate,
  requirePermission('product:read'),
  validate({ query: listBrandsQuerySchema }),
  ctrl.list,
);

brandRouter.post(
  '/',
  authenticate,
  requirePermission('brand:manage'),
  validate({ body: createBrandSchema }),
  ctrl.create,
);

brandRouter.get(
  '/:id',
  authenticate,
  requirePermission('product:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

brandRouter.patch(
  '/:id',
  authenticate,
  requirePermission('brand:manage'),
  validate({ params: idParamSchema, body: updateBrandSchema }),
  ctrl.update,
);

brandRouter.delete(
  '/:id',
  authenticate,
  requirePermission('brand:manage'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default brandRouter;
