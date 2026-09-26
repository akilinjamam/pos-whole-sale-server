import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as tierService from './priceTier.service.js';

import type { ListPriceTiersQuery } from './priceTier.schema.js';
import type { CreatePriceTierInput, UpdatePriceTierInput } from '@shared/pricing.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListPriceTiersQuery;
  const { items, meta } = await tierService.listPriceTiers(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(
    res,
    await tierService.getPriceTier(orgIdOf(req), toObjectId(req.params.id as string)),
  );
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreatePriceTierInput;
  sendCreated(res, await tierService.createPriceTier(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdatePriceTierInput;
  sendData(
    res,
    await tierService.updatePriceTier(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await tierService.deletePriceTier(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});
