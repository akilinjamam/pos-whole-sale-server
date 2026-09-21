import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as userService from './user.service.js';

import type {
  CreateUserInput,
  ListUsersQuery,
  ResetPasswordInput,
  UpdateUserInput,
} from './user.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListUsersQuery;
  const { items, meta } = await userService.listUsers(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await userService.getUser(orgIdOf(req), toObjectId(req.params.id as string)));
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateUserInput;
  sendCreated(res, await userService.createUser(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateUserInput;
  sendData(
    res,
    await userService.updateUser(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const resetPassword = asyncHandler(async (req, res) => {
  const input = req.body as ResetPasswordInput;
  await userService.resetPassword(
    orgIdOf(req),
    toObjectId(req.params.id as string),
    input,
    actorIdOf(req),
  );
  sendNoContent(res);
});

export const deactivate = asyncHandler(async (req, res) => {
  sendData(
    res,
    await userService.deactivateUser(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      actorIdOf(req),
    ),
  );
});
