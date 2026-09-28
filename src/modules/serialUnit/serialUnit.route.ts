import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { listSerialsQuerySchema, serialParamSchema } from './serialUnit.schema.js';
import * as service from './serialUnit.service.js';

import type { ListSerialsQuery } from './serialUnit.schema.js';

/**
 * The serial and warranty register — read-only, on `stock:read`. Units move only through stock
 * documents; there is deliberately no route that edits one.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('stock:read'),
  requireLocation,
  validate({ query: listSerialsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await service.listSerials(
      requestActorOf(req),
      req.query as unknown as ListSerialsQuery,
    );
    sendPage(res, items, meta);
  }),
);

router.get(
  '/:serialNo',
  authenticate,
  requirePermission('stock:read'),
  validate({ params: serialParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.serialHistory(requestActorOf(req), req.params.serialNo as string),
    );
  }),
);

export default router;
