import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './priceTier.controller.js';
import {
  createPriceTierSchema,
  idParamSchema,
  listPriceTiersQuerySchema,
  updatePriceTierSchema,
} from './priceTier.schema.js';

/**
 * Reads on `price:read`, writes on `priceTier:manage`.
 *
 * Managing tiers is its own grant, separate from `price:update`: adding or retiring a tier
 * changes which prices every dealer on it is quoted, while `price:update` edits the numbers
 * inside a tier that already exists.
 */
const priceTierRouter = Router();

priceTierRouter.get(
  '/',
  authenticate,
  requirePermission('price:read'),
  validate({ query: listPriceTiersQuerySchema }),
  ctrl.list,
);

priceTierRouter.post(
  '/',
  authenticate,
  requirePermission('priceTier:manage'),
  validate({ body: createPriceTierSchema }),
  ctrl.create,
);

priceTierRouter.get(
  '/:id',
  authenticate,
  requirePermission('price:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

priceTierRouter.patch(
  '/:id',
  authenticate,
  requirePermission('priceTier:manage'),
  validate({ params: idParamSchema, body: updatePriceTierSchema }),
  ctrl.update,
);

priceTierRouter.delete(
  '/:id',
  authenticate,
  requirePermission('priceTier:manage'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default priceTierRouter;
