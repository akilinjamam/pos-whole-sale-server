import { Types } from 'mongoose';

import { ApiError } from './ApiError.js';

import type { AuthUser } from '@shared/types.js';
import type { Request } from 'express';

/**
 * Narrow `req.user` from `AuthUser | undefined` to `AuthUser`.
 *
 * Every controller behind the guard calls this instead of `req.user!`. The non-null assertion
 * would compile just as well right up until someone mounts a handler without `authenticate`,
 * at which point it reads properties off `undefined` and returns a 500. This throws a 401,
 * which is both honest and the same answer the guard would have given.
 */
export function requireAuth(req: Request): AuthUser {
  if (!req.user) throw ApiError.unauthenticated();
  return req.user;
}

/** The caller's tenant, as an ObjectId ready for a query filter. Never read from the body. */
export function orgIdOf(req: Request): Types.ObjectId {
  return new Types.ObjectId(requireAuth(req).orgId);
}

/** The caller's own id, for `createdBy` / `updatedBy`. */
export function actorIdOf(req: Request): Types.ObjectId {
  return new Types.ObjectId(requireAuth(req).id);
}

/**
 * Parse a path or body id, rejecting garbage with a 400 that names the field rather than
 * letting Mongoose raise a CastError three layers down.
 */
export function toObjectId(value: string, field = 'id'): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw ApiError.badRequest(`Invalid ${field}`, { [field]: value });
  }
  return new Types.ObjectId(value);
}
