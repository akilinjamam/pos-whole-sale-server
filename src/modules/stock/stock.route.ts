import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './stock.controller.js';
import {
  listBalancesQuerySchema,
  listLedgerQuerySchema,
  openingImportSchema,
} from './stock.schema.js';

/**
 * Stock reads and the opening-stock import.
 *
 * There is deliberately **no** route that writes a balance or a ledger row directly, and none
 * that updates or deletes a ledger row at all. Stock changes only as a side effect of posting a
 * document — an opening import here; adjustments, transfers and counts from Day 14 — each of
 * which goes through `services/stock.service.ts`.
 *
 * `requireLocation` on every route: a `locationId` in the query or body must be one of the
 * caller's own, and the reads are scoped to those locations when none is named.
 */
const stockRouter = Router();

stockRouter.get(
  '/balances',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listBalancesQuerySchema }),
  ctrl.balances,
);

stockRouter.get(
  '/ledger',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listLedgerQuerySchema }),
  ctrl.ledger,
);

stockRouter.post(
  '/opening',
  authenticate,
  requirePermission('stock:opening'),
  requireLocation,
  validate({ body: openingImportSchema }),
  ctrl.importOpening,
);

export default stockRouter;
