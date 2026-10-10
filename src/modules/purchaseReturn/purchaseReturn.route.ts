import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import {
  createPurchaseReturnSchema,
  idParamSchema,
  listPurchaseReturnQuerySchema,
} from './purchaseReturn.schema.js';
import * as service from './purchaseReturn.service.js';

import type { ListPurchaseReturnQuery } from './purchaseReturn.schema.js';

/**
 * Purchase returns (Day 34) — the purchase side's own permissions: reading on `grn:read`, sending
 * goods back on `grn:create` (whoever may bring goods in may send them back out). Posted as
 * created; there is no draft and no cancel.
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('grn:read'),
  requireLocation,
  validate({ query: listPurchaseReturnQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await service.listPurchaseReturns(
      requestActorOf(req),
      req.query as unknown as ListPurchaseReturnQuery,
    );
    sendPage(res, page.items, page.meta);
  }),
);
router.get(
  '/:id',
  authenticate,
  requirePermission('grn:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.getPurchaseReturn(requestActorOf(req), toObjectId(req.params.id!)),
    );
  }),
);
router.post(
  '/',
  authenticate,
  requirePermission('grn:create'),
  requireLocation,
  validate({ body: createPurchaseReturnSchema }),
  asyncHandler(async (req, res) => {
    sendCreated(res, await service.createPurchaseReturn(requestActorOf(req), req.body));
  }),
);

export default router;
