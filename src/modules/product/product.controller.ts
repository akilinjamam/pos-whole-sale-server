import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, requireAuth, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';

import * as productService from './product.service.js';

import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from './product.schema.js';
import type { Request } from 'express';

/**
 * Cost visibility is decided once, here, from the verified permission set — never from a query
 * parameter the client could set. A store keeper counting boxes has no business knowing what
 * they cost, and §6 of the plan requires the fields be *stripped*, not merely hidden.
 */
function canViewCost(req: Request): boolean {
  return requireAuth(req).permissions.includes('stock:viewCost');
}

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListProductsQuery;
  const { items, meta } = await productService.listProducts(
    orgIdOf(req),
    query,
    canViewCost(req),
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(
    res,
    await productService.getProduct(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      canViewCost(req),
    ),
  );
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateProductInput;
  sendCreated(
    res,
    await productService.createProduct(orgIdOf(req), input, actorIdOf(req), canViewCost(req)),
  );
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateProductInput;
  sendData(
    res,
    await productService.updateProduct(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
      canViewCost(req),
    ),
  );
});

export const deactivate = asyncHandler(async (req, res) => {
  sendData(
    res,
    await productService.deactivateProduct(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      actorIdOf(req),
      canViewCost(req),
    ),
  );
});
