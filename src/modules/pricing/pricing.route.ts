import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './pricing.controller.js';
import { resolveQuerySchema } from './pricing.schema.js';

/**
 * `GET /pricing/resolve?partyId&productId&variantId&uomCode&qty&date` — what a dealer pays, and
 * which rule decided it.
 *
 * On `price:read`, which every selling role holds. The answer is a price the caller could quote
 * anyway; the trace only names the lists it came from.
 */
const pricingRouter = Router();

pricingRouter.get(
  '/resolve',
  authenticate,
  requirePermission('price:read'),
  validate({ query: resolveQuerySchema }),
  ctrl.resolve,
);

export default pricingRouter;
