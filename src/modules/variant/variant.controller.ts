import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as variantService from './variant.service.js';

import type {
  CreateVariantInput,
  GenerateVariantsInput,
  ListVariantsQuery,
  UpdateVariantInput,
} from './variant.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListVariantsQuery;
  const { items, meta } = await variantService.listVariants(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateVariantInput;
  sendCreated(res, await variantService.createVariant(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateVariantInput;
  sendData(
    res,
    await variantService.updateVariant(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await variantService.deleteVariant(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});

/** `dryRun: true` reports the count without writing — the UI's live "this will create N". */
export const generate = asyncHandler(async (req, res) => {
  const input = req.body as GenerateVariantsInput;
  sendData(res, await variantService.generateVariants(orgIdOf(req), input, actorIdOf(req)));
});
