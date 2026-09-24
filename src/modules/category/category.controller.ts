import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as categoryService from './category.service.js';

import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './category.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListCategoriesQuery;
  const { items, meta } = await categoryService.listCategories(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(
    res,
    await categoryService.getCategory(orgIdOf(req), toObjectId(req.params.id as string)),
  );
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateCategoryInput;
  sendCreated(res, await categoryService.createCategory(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateCategoryInput;
  sendData(
    res,
    await categoryService.updateCategory(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await categoryService.deleteCategory(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});
