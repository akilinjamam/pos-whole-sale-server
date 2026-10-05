import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import {
  allocateReceiptSchema,
  allocationPreviewQuerySchema,
  collectionSheetQuerySchema,
  idParamSchema,
  listReceiptsQuerySchema,
  receiptSchema,
} from './payment.schema.js';
import { collectionSheet } from './collection.service.js';
import * as service from './receipt.service.js';

import type { ListReceiptsQuery } from './payment.schema.js';
import type { AllocationPreviewQuery, CollectionSheetQuery } from '@shared/payments.js';
import type { Request } from 'express';

/**
 * Payments (Day 28): receipts from dealers and account customers, and their allocation to
 * invoices. Reading on `payment:read`; taking money and allocating it on `payment:receipt`.
 * Supplier payments (`payment:supplierPay`, series `PAY`) arrive with purchasing, Day 35.
 */
const router = Router();
const idOf = (req: Request) => toObjectId(req.params.id as string);

router.get(
  '/allocation-preview',
  authenticate,
  requirePermission('payment:read'),
  validate({ query: allocationPreviewQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.allocationPreview(
        requestActorOf(req),
        req.query as unknown as AllocationPreviewQuery,
      ),
    );
  }),
);
/** The collector's round: dealers who owe, most overdue first, with their open invoices. */
router.get(
  '/collection-sheet',
  authenticate,
  requirePermission('payment:read'),
  validate({ query: collectionSheetQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await collectionSheet(requestActorOf(req), req.query as unknown as CollectionSheetQuery),
    );
  }),
);
router.get(
  '/receipts',
  authenticate,
  requirePermission('payment:read'),
  validate({ query: listReceiptsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await service.listReceipts(
      requestActorOf(req),
      req.query as unknown as ListReceiptsQuery,
    );
    sendPage(res, items, meta);
  }),
);
router.post(
  '/receipts',
  authenticate,
  requirePermission('payment:receipt'),
  validate({ body: receiptSchema }),
  asyncHandler(async (req, res) => {
    sendCreated(res, await service.postReceipt(requestActorOf(req), req.body));
  }),
);
router.get(
  '/receipts/:id',
  authenticate,
  requirePermission('payment:read'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.getReceipt(requestActorOf(req), idOf(req)));
  }),
);
router.post(
  '/receipts/:id/allocate',
  authenticate,
  requirePermission('payment:receipt'),
  validate({ params: idParamSchema, body: allocateReceiptSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.allocateReceipt(requestActorOf(req), idOf(req), req.body));
  }),
);

export default router;
