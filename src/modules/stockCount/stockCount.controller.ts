import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';

import * as service from './stockCount.service.js';

import type { ListCountsQuery } from './stockCount.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listCounts(
    requestActorOf(req),
    req.query as unknown as ListCountsQuery,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await service.getCount(requestActorOf(req), idOf(req)));
});

export const open = asyncHandler(async (req, res) => {
  sendCreated(res, await service.openCount(requestActorOf(req), req.body));
});

export const record = asyncHandler(async (req, res) => {
  sendData(res, await service.recordCount(requestActorOf(req), idOf(req), req.body));
});

export const post = asyncHandler(async (req, res) => {
  sendData(res, await service.postCount(requestActorOf(req), idOf(req), req.body));
});

export const cancel = asyncHandler(async (req, res) => {
  sendData(res, await service.cancelCount(requestActorOf(req), idOf(req)));
});
