import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './role.controller.js';
import {
  createRoleSchema,
  idParamSchema,
  listRolesQuerySchema,
  updateRoleSchema,
} from './role.schema.js';

const roleRouter = Router();

// Before '/:id', or 'permissions' would be parsed as a role id.
roleRouter.get('/permissions', authenticate, requirePermission('role:read'), ctrl.getCatalog);

roleRouter.get(
  '/',
  authenticate,
  requirePermission('role:read'),
  validate({ query: listRolesQuerySchema }),
  ctrl.list,
);

roleRouter.post(
  '/',
  authenticate,
  requirePermission('role:create'),
  validate({ body: createRoleSchema }),
  ctrl.create,
);

roleRouter.get(
  '/:id',
  authenticate,
  requirePermission('role:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

roleRouter.patch(
  '/:id',
  authenticate,
  requirePermission('role:update'),
  validate({ params: idParamSchema, body: updateRoleSchema }),
  ctrl.update,
);

roleRouter.delete(
  '/:id',
  authenticate,
  requirePermission('role:delete'),
  validate({ params: idParamSchema }),
  ctrl.remove,
);

export default roleRouter;
