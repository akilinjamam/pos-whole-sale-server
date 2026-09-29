import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import {
  closeSessionSchema,
  holdSaleSchema,
  openSessionSchema,
  posSaleSchema,
} from '../../shared/pos.js';

import * as held from './heldSale.service.js';
import * as sales from './posSale.service.js';
import * as sessions from './posSession.service.js';

import type {
  CloseSessionInput,
  HoldSaleInput,
  OpenSessionInput,
  PosSaleInput,
} from '@shared/pos.js';
import type { Request } from 'express';

/**
 * The counter (§6.10). Sessions on `pos:openSession` / `pos:closeSession`; selling on `pos:sell`;
 * parking carts on `pos:holdSale`. Reading another cashier's shift needs `pos:viewAllSessions`,
 * checked in the service.
 */
const router = Router();
const id = z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id') });
const idOf = (req: Request) => toObjectId(req.params.id as string);
const listSessions = sessions.listSessionsQuerySchema.extend({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  locationId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
});

// ── Sessions ──
router.post(
  '/sessions',
  authenticate,
  requirePermission('pos:openSession'),
  requireLocation,
  validate({ body: openSessionSchema }),
  asyncHandler(async (req, res) =>
    sendCreated(
      res,
      await sessions.openSession(requestActorOf(req), req.body as OpenSessionInput),
    ),
  ),
);
router.get(
  '/sessions/current',
  authenticate,
  requirePermission('pos:sell'),
  asyncHandler(async (req, res) =>
    sendData(res, await sessions.currentSession(requestActorOf(req))),
  ),
);
router.get(
  '/sessions',
  authenticate,
  requirePermission('pos:sell'),
  requireLocation,
  validate({ query: listSessions }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await sessions.listSessions(
      requestActorOf(req),
      req.query as never,
    );
    sendPage(res, items, meta);
  }),
);
router.get(
  '/sessions/:id',
  authenticate,
  requirePermission('pos:sell'),
  validate({ params: id }),
  asyncHandler(async (req, res) =>
    sendData(res, await sessions.getSession(requestActorOf(req), idOf(req))),
  ),
);
router.post(
  '/sessions/:id/close',
  authenticate,
  requirePermission('pos:closeSession'),
  validate({ params: id, body: closeSessionSchema }),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await sessions.closeSession(
        requestActorOf(req),
        idOf(req),
        req.body as CloseSessionInput,
      ),
    ),
  ),
);

// ── Sales ──
router.post(
  '/sales',
  authenticate,
  requirePermission('pos:sell'),
  validate({ body: posSaleSchema }),
  asyncHandler(async (req, res) => {
    const result = await sales.postPosSale(requestActorOf(req), req.body as PosSaleInput);
    // 201 for a new sale; 200 when the till's retry replays one already made.
    if (result.replayed) sendData(res, result);
    else sendCreated(res, result);
  }),
);
router.get(
  '/sales/:id',
  authenticate,
  requirePermission('pos:sell'),
  validate({ params: id }),
  asyncHandler(async (req, res) =>
    sendData(res, await sales.getPosSale(requestActorOf(req), idOf(req))),
  ),
);

// ── Held sales ──
router.post(
  '/held',
  authenticate,
  requirePermission('pos:holdSale'),
  validate({ body: holdSaleSchema }),
  asyncHandler(async (req, res) =>
    sendCreated(res, await held.holdSale(requestActorOf(req), req.body as HoldSaleInput)),
  ),
);
router.get(
  '/held',
  authenticate,
  requirePermission('pos:holdSale'),
  asyncHandler(async (req, res) => sendData(res, await held.listHeld(requestActorOf(req)))),
);
router.get(
  '/held/:id',
  authenticate,
  requirePermission('pos:holdSale'),
  validate({ params: id }),
  asyncHandler(async (req, res) =>
    sendData(res, await held.getHeld(requestActorOf(req), idOf(req))),
  ),
);
router.delete(
  '/held/:id',
  authenticate,
  requirePermission('pos:holdSale'),
  validate({ params: id }),
  asyncHandler(async (req, res) => {
    await held.discardHeld(requestActorOf(req), idOf(req));
    sendNoContent(res);
  }),
);

export default router;
