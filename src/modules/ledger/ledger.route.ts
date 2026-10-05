import { Router } from 'express';

import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import {
  listLedgerQuerySchema,
  openingBalanceImportSchema,
  reconcileBodySchema,
  statementQuerySchema,
} from './ledger.schema.js';
import * as service from './ledger.service.js';

import type { ListLedgerQuery } from './ledger.schema.js';
import type { StatementQuery } from '@shared/ledger.js';

/**
 * The party ledger (Day 27). Entries are only ever *written* by the documents that post them —
 * invoices, receipts, credit notes — through `partyLedger.service`; these routes read the ledger,
 * load the opening position at cutover, and reconcile the balance cache against it.
 */
const router = Router();

router.get(
  '/entries',
  authenticate,
  requirePermission('ledger:read'),
  validate({ query: listLedgerQuerySchema }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await service.listLedgerEntries(
      requestActorOf(req),
      req.query as unknown as ListLedgerQuery,
    );
    sendPage(res, items, meta);
  }),
);

/** A party's statement for a period, with the running balance computed at read time. */
router.get(
  '/statement',
  authenticate,
  requirePermission('ledger:read'),
  validate({ query: statementQuerySchema }),
  asyncHandler(async (req, res) => {
    sendData(
      res,
      await service.partyStatement(requestActorOf(req), req.query as unknown as StatementQuery),
    );
  }),
);

/** Dry run, then commit: the same file twice, `dryRun: true` then `false`. All or nothing. */
router.post(
  '/opening',
  authenticate,
  requirePermission('ledger:opening'),
  validate({ body: openingBalanceImportSchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.importOpeningBalances(requestActorOf(req), req.body));
  }),
);

/** A POST, though it writes nothing: it is an action someone takes, and it can be slow. */
router.post(
  '/reconcile',
  authenticate,
  requirePermission('ledger:reconcile'),
  validate({ body: reconcileBodySchema }),
  asyncHandler(async (req, res) => {
    sendData(res, await service.reconcileLedger(requestActorOf(req).orgId));
  }),
);

export default router;
