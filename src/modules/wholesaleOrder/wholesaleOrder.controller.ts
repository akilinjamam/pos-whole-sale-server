import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendData, sendPage } from '../../lib/respond.js';

import * as service from './wholesaleOrder.service.js';

import type { ListOrdersQuery } from './wholesaleOrder.schema.js';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listOrders(
    requestActorOf(req),
    req.query as unknown as ListOrdersQuery,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(
    res,
    await service.getOrder(requestActorOf(req), toObjectId(req.params.id as string)),
  );
});
