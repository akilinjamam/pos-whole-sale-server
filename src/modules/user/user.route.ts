import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireLocation } from '../../middleware/requireLocation.js';
import { validate } from '../../middleware/validate.js';

import * as ctrl from './user.controller.js';
import {
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
} from './user.schema.js';

const userRouter = Router();

userRouter.get(
  '/',
  authenticate,
  requirePermission('user:read'),
  validate({ query: listUsersQuerySchema }),
  ctrl.list,
);

// `requireLocation` here stops a restricted administrator from granting access to a warehouse
// they themselves cannot see — privilege escalation by way of the user editor.
userRouter.post(
  '/',
  authenticate,
  requirePermission('user:create'),
  validate({ body: createUserSchema }),
  requireLocation,
  ctrl.create,
);

userRouter.get(
  '/:id',
  authenticate,
  requirePermission('user:read'),
  validate({ params: idParamSchema }),
  ctrl.getOne,
);

userRouter.patch(
  '/:id',
  authenticate,
  requirePermission('user:update'),
  validate({ params: idParamSchema, body: updateUserSchema }),
  requireLocation,
  ctrl.update,
);

// Its own permission, not folded into `user:update`: this endpoint hands over an account.
userRouter.post(
  '/:id/password',
  authenticate,
  requirePermission('user:resetPassword'),
  validate({ params: idParamSchema, body: resetPasswordSchema }),
  ctrl.resetPassword,
);

userRouter.delete(
  '/:id',
  authenticate,
  requirePermission('user:delete'),
  validate({ params: idParamSchema }),
  ctrl.deactivate,
);

export default userRouter;
