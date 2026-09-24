import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';
import {
  PERMISSIONS,
  PERMISSION_MODULES,
  PERMISSION_MODULE_LABELS,
} from '../../shared/permissions.js';

import * as roleService from './role.service.js';

import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from './role.schema.js';

export const list = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ListRolesQuery;
  const { items, meta } = await roleService.listRoles(orgIdOf(req), query);
  sendPage(res, items, meta);
});

export const getOne = asyncHandler(async (req, res) => {
  sendData(res, await roleService.getRole(orgIdOf(req), toObjectId(req.params.id as string)));
});

export const create = asyncHandler(async (req, res) => {
  const input = req.body as CreateRoleInput;
  sendCreated(res, await roleService.createRole(orgIdOf(req), input, actorIdOf(req)));
});

export const update = asyncHandler(async (req, res) => {
  const input = req.body as UpdateRoleInput;
  sendData(
    res,
    await roleService.updateRole(
      orgIdOf(req),
      toObjectId(req.params.id as string),
      input,
      actorIdOf(req),
    ),
  );
});

export const remove = asyncHandler(async (req, res) => {
  await roleService.deleteRole(orgIdOf(req), toObjectId(req.params.id as string));
  sendNoContent(res);
});

/**
 * The catalog itself, grouped and labelled — what the permission-matrix editor renders.
 *
 * Served rather than imported by the client purely so the two cannot disagree at runtime: the
 * client compiles against the same `@shared/permissions.ts`, but this endpoint proves the
 * deployed server agrees with the deployed client about what exists.
 */
export const getCatalog = asyncHandler(async (_req, res) => {
  sendData(
    res,
    PERMISSION_MODULES.map((module) => ({
      module,
      label: PERMISSION_MODULE_LABELS[module],
      permissions: PERMISSIONS[module],
    })),
  );
});
