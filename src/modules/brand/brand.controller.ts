import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as brandService from './brand.service.js';

import type { CreateBrandInput, ListBrandsQuery, UpdateBrandInput } from './brand.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListBrandsQuery;
  const { items, meta } = await brandService.listBrands(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await brandService.getBrand(orgIdOf(req), toObjectId(req.params.id as string)));
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateBrandInput;
  sendCreated(res, await brandService.createBrand(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateBrandInput;
  sendData(
    res,
    await brandService.updateBrand(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await brandService.deleteBrand(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});
