import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, requireAuth, toObjectId } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';

import * as reconcileService from './reconcile.service.js';
import * as stockService from './stock.service.js';

import type { ListBalancesQuery, ListLedgerQuery, ReconcileBody } from './stock.schema.js';
import type { StockActor } from './stock.service.js';
import type { OpeningImportInput } from '@shared/stock.js';
import type { Request } from 'express';

/**
 * Cost visibility and location scope are decided once, here, from the verified token — never
 * from anything the client sends.
 */
function actorOf(req: Request): StockActor {
  const user = requireAuth(req);
  return {
    orgId: orgIdOf(req),
    actorId: actorIdOf(req),
    includeCost: user.permissions.includes('stock:viewCost'),
    locationScope: locationScopeOf(user),
  };
}

export const balances = asyncHandler(async (req, res) => {
  const { items, meta } = await stockService.listBalances(
    actorOf(req),
    req.query as unknown as ListBalancesQuery,
  );
  sendPage(res, items, meta);
});

export const ledger = asyncHandler(async (req, res) => {
  const { items, meta } = await stockService.listLedger(
    actorOf(req),
    req.query as unknown as ListLedgerQuery,
  );
  sendPage(res, items, meta);
});

export const importOpening = asyncHandler(async (req, res) => {
  sendData(
    res,
    await stockService.importOpeningStock(actorOf(req), req.body as OpeningImportInput),
  );
});

export const reconcile = asyncHandler(async (req, res) => {
  const { locationId } = req.body as ReconcileBody;
  sendData(
    res,
    await reconcileService.reconcileStock(
      orgIdOf(req),
      locationId ? toObjectId(locationId, 'locationId') : undefined,
    ),
  );
});
