import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './category.controller.js';
import {
  createCategorySchema,
  idParamSchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from './category.schema.js';

/** Reads on `product:read`, writes on `category:manage` — same reasoning as brands. */
const categoryRouter = Router();

categoryRouter.get(
  '/',
  authenticate,
  requirePermission('product:read'),
  validate({ query: listCategoriesQuerySchema }),
  ctrl.list,
);

categoryRouter.post(
  '/',
  authenticate,
  requirePermission('category:manage'),
  validate({ body: createCategorySchema }),
  ctrl.create,
);

categoryRouter.get(
  '/:id',
  authenticate,
  requirePermission('product:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

categoryRouter.patch(
  '/:id',
  authenticate,
  requirePermission('category:manage'),
  validate({ params: idParamSchema, body: updateCategorySchema }),
  ctrl.update,
);

categoryRouter.delete(
  '/:id',
  authenticate,
  requirePermission('category:manage'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default categoryRouter;
