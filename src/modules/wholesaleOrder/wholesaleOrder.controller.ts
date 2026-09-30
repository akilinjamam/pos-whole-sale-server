import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';

import * as service from './wholesaleOrder.service.js';

import type { ListOrdersQuery } from './wholesaleOrder.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

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

export const quote = asyncHandler(async (req, res) => {
  sendData(res, await service.quoteOrder(requestActorOf(req), req.body));
});

export const create = asyncHandler(async (req, res) => {
  sendCreated(res, await service.createOrder(requestActorOf(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  sendData(res, await service.updateOrder(requestActorOf(req), idOf(req), req.body));
});

export const confirm = asyncHandler(async (req, res) => {
  sendData(res, await service.confirmOrder(requestActorOf(req), idOf(req), req.body));
});

export const approve = asyncHandler(async (req, res) => {
  sendData(res, await service.approveOrder(requestActorOf(req), idOf(req), req.body));
});

export const reject = asyncHandler(async (req, res) => {
  sendData(res, await service.rejectOrder(requestActorOf(req), idOf(req), req.body));
});

export const cancel = asyncHandler(async (req, res) => {
  sendData(res, await service.cancelOrder(requestActorOf(req), idOf(req), req.body));
});
