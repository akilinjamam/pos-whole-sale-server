import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';

import * as service from './dispatch.service.js';

import type { ListDispatchesQuery } from './dispatch.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listDispatches(
    requestActorOf(req),
    req.query as unknown as ListDispatchesQuery,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await service.getDispatch(requestActorOf(req), idOf(req)));
});

export const create = asyncHandler(async (req, res) => {
  sendCreated(res, await service.createDispatch(requestActorOf(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  sendData(res, await service.updateDispatch(requestActorOf(req), idOf(req), req.body));
});

export const pack = asyncHandler(async (req, res) => {
  sendData(res, await service.packDispatch(requestActorOf(req), idOf(req)));
});

export const post = asyncHandler(async (req, res) => {
  sendData(res, await service.postDispatch(requestActorOf(req), idOf(req), {}, req.body));
});

export const cancel = asyncHandler(async (req, res) => {
  sendData(res, await service.cancelDispatch(requestActorOf(req), idOf(req), req.body));
});

export const deliver = asyncHandler(async (req, res) => {
  sendData(res, await service.deliverDispatch(requestActorOf(req), idOf(req), req.body));
});
