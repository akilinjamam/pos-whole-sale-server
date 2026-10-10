import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import {
  cancelGrnSchema,
  createGrnSchema,
  idParamSchema,
  listGrnQuerySchema,
  registerQuerySchema,
  updateGrnSchema,
} from './goodsReceipt.schema.js';
import * as service from './goodsReceipt.service.js';
import { purchaseRegister } from './purchaseRegister.service.js';

import type { ListGrnQuery, RegisterQuery } from './goodsReceipt.schema.js';
import type { Request } from 'express';

/**
 * Goods receipts (Day 33). Reads on `grn:read`; drafting and posting on `grn:create`; abandoning
 * a draft on `grn:cancel`. Costs are visible — and typeable — only with `stock:viewCost`; a store
 * keeper receives at the PO's prices without seeing them.
 *
 * Posting is the whole of receiving: stock, cost, the PO and the supplier's ledger move in one
 * transaction (`goodsReceipt.service.postGrn`).
 */
const router = Router();
const idOf = (req: Request) => toObjectId(req.params.id!);

router.get(
  '/',
  authenticate,
  requirePermission('grn:read'),
  requireLocation,
  validate({ query: listGrnQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await service.listGrns(
      requestActorOf(req),
      req.query as unknown as ListGrnQuery,
    );
    sendPage(res, page.items, page.meta);
  }),
);
// Before `/:id`. A money report: `report:purchase`, not `grn:read`.
router.get(
  '/register',
  authenticate,
  requirePermission('report:purchase'),
  requireLocation,
  validate({ query: registerQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await purchaseRegister(requestActorOf(req), req.query as unknown as RegisterQuery),
    );
  }),
);
router.get(
  '/:id',
  authenticate,
  requirePermission('grn:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getGrn(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/',
  authenticate,
  requirePermission('grn:create'),
  requireLocation,
  validate({ body: createGrnSchema }),
  asyncHandler(async (req, res) => {
    sendCreated(res, await service.createGrn(requestActorOf(req), req.body));
  }),
);
router.patch(
  '/:id',
  authenticate,
  requirePermission('grn:create'),
  requireLocation,
  validate({ params: idParamSchema, body: updateGrnSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.updateGrn(requestActorOf(req), idOf(req), req.body));
  }),
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('grn:create'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.postGrn(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('grn:cancel'),
  validate({ params: idParamSchema, body: cancelGrnSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.cancelGrn(requestActorOf(req), idOf(req), req.body));
  }),
);

export default router;
