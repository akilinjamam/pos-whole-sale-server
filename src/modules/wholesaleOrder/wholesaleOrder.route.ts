import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './wholesaleOrder.controller.js';
import {
  cancelOrderSchema,
  confirmOrderSchema,
  createOrderSchema,
  idParamSchema,
  listOrdersQuerySchema,
  orderCountsQuerySchema,
  orderReasonSchema,
  quoteOrderSchema,
  updateOrderSchema,
} from './wholesaleOrder.schema.js';

/**
 * Wholesale orders. Reads on `order:read`; each order carries `availableActions` — what the
 * caller may do to it next, straight from the state machine.
 *
 * Each lifecycle step is its own endpoint, because each has its own stock and credit effects —
 * confirm reserves, cancel releases, approve overrides credit. There is deliberately no generic
 * "set status" endpoint: status moves only through the state machine, one named action at a time.
 * Dispatch (Day 24) and short close (Day 26) arrive the same way.
 *
 * Route permissions are the coarse gate; the state machine re-checks the edge's own permission,
 * and the service checks field-level ones (`order:priceOverride`, `order:discount`,
 * `order:creditOverride`).
 */
const router = Router();

router.get(
  '/',
  authenticate,
  requirePermission('order:read'),
  requireLocation,
  validate({ query: listOrdersQuerySchema }),
  ctrl.list,
);
// Before `/:id`, which would otherwise capture "counts" and "quote".
router.get(
  '/counts',
  authenticate,
  requirePermission('order:read'),
  requireLocation,
  validate({ query: orderCountsQuerySchema }),
  ctrl.counts,
);
router.post(
  '/quote',
  authenticate,
  requirePermission('order:create'),
  validate({ body: quoteOrderSchema }),
  ctrl.quote,
);
router.post(
  '/',
  authenticate,
  requirePermission('order:create'),
  validate({ body: createOrderSchema }),
  ctrl.create,
);
router.get(
  '/:id',
  authenticate,
  requirePermission('order:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);
router.patch(
  '/:id',
  authenticate,
  requirePermission('order:update'),
  validate({ params: idParamSchema, body: updateOrderSchema }),
  ctrl.update,
);
router.post(
  '/:id/confirm',
  authenticate,
  requirePermission('order:confirm'),
  validate({ params: idParamSchema, body: confirmOrderSchema }),
  ctrl.confirm,
);
router.post(
  '/:id/approve',
  authenticate,
  requirePermission('order:approve'),
  validate({ params: idParamSchema, body: orderReasonSchema }),
  ctrl.approve,
);
router.post(
  '/:id/reject',
  authenticate,
  requirePermission('order:approve'),
  validate({ params: idParamSchema, body: orderReasonSchema }),
  ctrl.reject,
);
router.post(
  '/:id/short-close',
  authenticate,
  requirePermission('order:shortClose'),
  validate({ params: idParamSchema, body: orderReasonSchema }),
  ctrl.shortClose,
);
router.post(
  '/:id/close',
  authenticate,
  requirePermission('order:update'),
  validate({ params: idParamSchema }),
  ctrl.close,
);
router.post(
  '/:id/cancel',
  authenticate,
  requirePermission('order:cancel'),
  validate({ params: idParamSchema, body: cancelOrderSchema }),
  ctrl.cancel,
);

export default router;
