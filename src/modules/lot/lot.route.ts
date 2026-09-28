import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { expiringQuerySchema, listLotsQuerySchema } from './lot.schema.js';
import * as service from './lot.service.js';

import type { ExpiringQuery, ListLotsQuery } from './lot.schema.js';

/** Lots and the expiry report — read-only, on `stock:read`. Lots are created by inbound stock. */
const router = Router();

// Before any `/:id` route, should one ever be added.
router.get(
  '/expiring',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: expiringQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.expiringLots(requestActorOf(req), req.query as unknown as ExpiringQuery),
    );
  }),
);

router.get(
  '/',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listLotsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await service.listLots(
      requestActorOf(req),
      req.query as unknown as ListLotsQuery,
    );
    sendPage(res, items, meta);
  }),
);

export default router;
