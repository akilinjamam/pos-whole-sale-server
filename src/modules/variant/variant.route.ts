import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './variant.controller.js';
import {
  createVariantSchema,
  generateVariantsSchema,
  idParamSchema,
  listVariantsQuerySchema,
  updateVariantSchema,
} from './variant.schema.js';

/**
 * Flat rather than nested under `/products/:id/variants`.
 *
 * Every route here needs the product anyway — to validate axes against its declared grid — so
 * the id travels in the query or the body, and the route table stays one line per module. A
 * second router mounted on the products path would also make the Day-3 coverage report read as
 * if `products` had nine endpoints.
 *
 * Reads on `product:read` (anyone who can see a lens needs its powers); writes on
 * `variant:manage`, because generating a range creates hundreds of stockable items.
 */
const variantRouter = Router();

variantRouter.get(
  '/',
  authenticate,
  requirePermission('product:read'),
  validate({ query: listVariantsQuerySchema }),
  ctrl.list,
);

// Before '/:id' would matter if this were a GET; kept above the id routes regardless, so the
// ordering survives someone adding `GET /:id` later.
variantRouter.post(
  '/generate',
  authenticate,
  requirePermission('variant:manage'),
  validate({ body: generateVariantsSchema }),
  ctrl.generate,
);

variantRouter.post(
  '/',
  authenticate,
  requirePermission('variant:manage'),
  validate({ body: createVariantSchema }),
  ctrl.create,
);

variantRouter.patch(
  '/:id',
  authenticate,
  requirePermission('variant:manage'),
  validate({ params: idParamSchema, body: updateVariantSchema }),
  ctrl.update,
);

variantRouter.delete(
  '/:id',
  authenticate,
  requirePermission('variant:manage'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default variantRouter;
