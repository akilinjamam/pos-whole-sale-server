import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as service from './stockAdjustment.service.js';

import type { ListAdjustmentsQuery } from './stockAdjustment.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listAdjustments(
    requestActorOf(req),
    req.query as unknown as ListAdjustmentsQuery,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await service.getAdjustment(requestActorOf(req), idOf(req)));
});

export const create = asyncHandler(async (req, res) => {
  sendCreated(res, await service.createAdjustment(requestActorOf(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  sendData(res, await service.updateAdjustment(requestActorOf(req), idOf(req), req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteAdjustment(requestActorOf(req), idOf(req));
  sendNoContent(res);
});

export const post = asyncHandler(async (req, res) => {
  sendData(res, await service.postAdjustment(requestActorOf(req), idOf(req)));
});

export const cancel = asyncHandler(async (req, res) => {
  sendData(res, await service.cancelAdjustment(requestActorOf(req), idOf(req), req.body));
});
