import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './priceList.controller.js';
import {
  bulkAdjustSchema,
  createPriceEntrySchema,
  idParamSchema,
  listPriceEntriesQuerySchema,
  priceImportSchema,
  updatePriceEntrySchema,
} from './priceList.schema.js';

/**
 * Price-list entries, for tiers and for individual dealers alike.
 *
 * Reads on `price:read`; edits and the bulk % adjust on `price:update`; the CSV import on its own
 * `price:import`, because one file can re-price the whole catalogue in a single click.
 */
const priceListRouter = Router();

priceListRouter.get(
  '/',
  authenticate,
  requirePermission('price:read'),
  validate({ query: listPriceEntriesQuerySchema }),
  ctrl.list,
);

priceListRouter.post(
  '/',
  authenticate,
  requirePermission('price:update'),
  validate({ body: createPriceEntrySchema }),
  ctrl.create,
);

// Both before '/:id' so neither literal is ever read as an id.
priceListRouter.post(
  '/import',
  authenticate,
  requirePermission('price:import'),
  validate({ body: priceImportSchema }),
  ctrl.importRows,
);

priceListRouter.post(
  '/bulk-adjust',
  authenticate,
  requirePermission('price:update'),
  validate({ body: bulkAdjustSchema }),
  ctrl.bulkAdjust,
);

priceListRouter.get(
  '/:id',
  authenticate,
  requirePermission('price:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

priceListRouter.patch(
  '/:id',
  authenticate,
  requirePermission('price:update'),
  validate({ params: idParamSchema, body: updatePriceEntrySchema }),
  ctrl.update,
);

priceListRouter.delete(
  '/:id',
  authenticate,
  requirePermission('price:update'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default priceListRouter;
