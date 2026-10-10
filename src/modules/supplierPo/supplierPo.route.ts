import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import {
  cancelPoSchema,
  createPoSchema,
  idParamSchema,
  listPoQuerySchema,
  poReasonSchema,
  reorderQuerySchema,
  updatePoSchema,
} from './supplierPo.schema.js';
import { reorderSuggestions } from './reorder.service.js';
import * as service from './supplierPo.service.js';

import type { ListPoQuery, ReorderQuery } from './supplierPo.schema.js';
import type { Request } from 'express';

/**
 * Purchase orders (Day 32). Reads on `po:read`; each PO carries `availableActions` — what the
 * caller may do to it next, straight from the state machine. One endpoint per lifecycle step and
 * no generic "set status": receiving is not here at all — a posted goods receipt (Day 33) moves
 * the PO, through `recordPoReceipt`.
 *
 * Route permissions are the coarse gate; the state machine re-checks each edge's own permission.
 */
const router = Router();
const idOf = (req: Request) => toObjectId(req.params.id!);

router.get(
  '/',
  authenticate,
  requirePermission('po:read'),
  requireLocation,
  validate({ query: listPoQuerySchema }),
  asyncHandler(async (req, res) => {
    const page = await service.listPos(
      requestActorOf(req),
      req.query as unknown as ListPoQuery,
    );
    sendPage(res, page.items, page.meta);
  }),
);
// Before `/:id`, or "reorder-suggestions" would be read as an id.
router.get(
  '/reorder-suggestions',
  authenticate,
  requirePermission('po:read'),
  requireLocation,
  validate({ query: reorderQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await reorderSuggestions(requestActorOf(req), req.query as unknown as ReorderQuery),
    );
  }),
);
router.get(
  '/:id',
  authenticate,
  requirePermission('po:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getPo(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/',
  authenticate,
  requirePermission('po:create'),
  requireLocation,
  validate({ body: createPoSchema }),
  asyncHandler(async (req, res) => {
    sendCreated(res, await service.createPo(requestActorOf(req), req.body));
  }),
);
router.patch(
  '/:id',
  authenticate,
  requirePermission('po:update'),
  requireLocation,
  validate({ params: idParamSchema, body: updatePoSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.updatePo(requestActorOf(req), idOf(req), req.body));
  }),
);
router.post(
  '/:id/approve',
  authenticate,
  requirePermission('po:approve'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.approvePo(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/:id/send',
  authenticate,
  requirePermission('po:update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.sendPo(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/:id/reopen',
  authenticate,
  requirePermission('po:update'),
  validate({ params: idParamSchema, body: poReasonSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.reopenPo(requestActorOf(req), idOf(req), req.body));
  }),
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('po:cancel'),
  validate({ params: idParamSchema, body: cancelPoSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.cancelPo(requestActorOf(req), idOf(req), req.body));
  }),
);
router.post(
  '/:id/short-close',
  authenticate,
  requirePermission('po:shortClose'),
  validate({ params: idParamSchema, body: poReasonSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.shortClosePo(requestActorOf(req), idOf(req), req.body));
  }),
);

export default router;
