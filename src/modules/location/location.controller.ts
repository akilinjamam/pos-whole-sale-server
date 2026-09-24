import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, requireAuth, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendPage } from '../../lib/respond.js';

import * as locationService from './location.service.js';

import type {
  CreateLocationInput,
  ListLocationsQuery,
  UpdateLocationInput,
} from './location.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListLocationsQuery;
  const { items, meta } = await locationService.listLocations(
    requireAuth(req),
    orgIdOf(req),
    query,
  );
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id as string);
  sendData(res, await locationService.getLocation(requireAuth(req), orgIdOf(req), id));
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateLocationInput;
  sendCreated(res, await locationService.createLocation(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id as string);
  const input = req.body as UpdateLocationInput;
  sendData(res, await locationService.updateLocation(orgIdOf(req), id, input, actorIdOf(req)));
});

export const deactivate = asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id as string);
  sendData(res, await locationService.deactivateLocation(orgIdOf(req), id, actorIdOf(req)));
});
