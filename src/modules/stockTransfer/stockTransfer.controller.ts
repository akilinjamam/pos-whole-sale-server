import { asyncHandler } from '../../lib/asyncHandler.js';
import { requestActorOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as service from './stockTransfer.service.js';

import type { ListTransfersQuery } from './stockTransfer.schema.js';
import type { Request } from 'express';

const idOf = (req: Request) => toObjectId(req.params.id as string);

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listTransfers(
    requestActorOf(req),
    req.query as unknown as ListTransfersQuery,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await service.getTransfer(requestActorOf(req), idOf(req)));
});

export const create = asyncHandler(async (req, res) => {
  sendCreated(res, await service.createTransfer(requestActorOf(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  sendData(res, await service.updateTransfer(requestActorOf(req), idOf(req), req.body));
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteTransfer(requestActorOf(req), idOf(req));
  sendNoContent(res);
});

export const post = asyncHandler(async (req, res) => {
  sendData(res, await service.postTransfer(requestActorOf(req), idOf(req)));
});

export const receive = asyncHandler(async (req, res) => {
  sendData(res, await service.receiveTransfer(requestActorOf(req), idOf(req)));
});
