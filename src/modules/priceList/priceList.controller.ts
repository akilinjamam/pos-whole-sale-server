import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as priceService from './priceList.service.js';

import type { ListPriceEntriesQuery } from './priceList.schema.js';
import type {
  BulkAdjustInput,
  CreatePriceEntryInput,
  PriceImportInput,
  UpdatePriceEntryInput,
} from '@shared/pricing.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListPriceEntriesQuery;
  const { items, meta } = await priceService.listPriceEntries(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(
    res,
    await priceService.getPriceEntry(orgIdOf(req), toObjectId(req.params.id as string)),
  );
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreatePriceEntryInput;
  sendCreated(res, await priceService.createPriceEntry(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdatePriceEntryInput;
  sendData(
    res,
    await priceService.updatePriceEntry(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await priceService.deletePriceEntry(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});

export const importRows = asyncHandler(async (req, res) => {
  const input = req.body as PriceImportInput;
  sendData(res, await priceService.importPriceEntries(orgIdOf(req), input, actorIdOf(req)));
});

export const bulkAdjust = asyncHandler(async (req, res) => {
  const input = req.body as BulkAdjustInput;
  sendData(res, await priceService.bulkAdjustPrices(orgIdOf(req), input, actorIdOf(req)));
});
