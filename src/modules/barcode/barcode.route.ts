import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './barcode.controller.js';

/**
 * One route: what does this code mean?
 *
 * Gated on `product:read`, which every selling role holds — a cashier who could not resolve a
 * barcode could not ring up a sale, so a narrower permission would be a permission nobody could
 * sensibly withhold.
 */
const barcodeRouter = Router();

const codeParamSchema = z.object({
  // Scanners emit digits for EAN/UPC, but internal codes are often alphanumeric with dashes.
  code: z.string().trim().min(1).max(60),
});

barcodeRouter.get(
  '/:code',
  authenticate,
  requirePermission('product:read'),
  validate({ params: codeParamSchema }),
  ctrl.lookup,
);

export default barcodeRouter;
