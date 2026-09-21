import { ApiError } from '../lib/ApiError.js';

import { markPermissions } from './guardMeta.js';

import type { Permission } from '@shared/permissions.js';
import type { RequestHandler } from 'express';

/**
 * The route gate.
 *
 * Typed `(p: Permission) => RequestHandler`, so `requirePermission('oder:read')` does not
 * compile. That single line of typing is the whole reason the permission catalog is a derived
 * union rather than a list of strings — a misspelt permission in the retail system's boolean
 * scheme is `undefined`, which reads as "denied" and produces a bug report about a role that
 * "randomly" cannot see a screen.
 *
 * Adding a capability touches exactly two places: the catalog entry, and this call.
 */
export function requirePermission(...needed: [Permission, ...Permission[]]): RequestHandler {
  // Tagged so the route-coverage test can find this gate once it is buried in an Express
  // layer stack — see `guardMeta.ts`. Without the tag the test cannot tell a permission gate
  // from any other middleware, and a route with no gate would pass silently.
  const guard: RequestHandler = (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(ApiError.unauthenticated());
      return;
    }

    // Several permissions means *all* of them. An "any of these" gate would let the caller
    // reach a handler that then needs the one they lack; where that genuinely applies, the
    // service makes the finer-grained decision itself.
    const missing = needed.filter((p) => !user.permissions.includes(p));
    if (missing.length > 0) {
      next(
        new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that', {
          required: needed,
          missing,
        }),
      );
      return;
    }

    next();
  };

  return markPermissions(guard, needed);
}

/**
 * Field-level gate, for use inside a service rather than on a route.
 *
 * `order:discount`, `order:priceOverride`, `stock:viewCost` and `dealer:setCreditLimit` are
 * enforced by **rejecting the field**, not by hiding the input (§10) — a hidden input is a
 * suggestion, and this codebase does not take suggestions from the client.
 */
export function assertPermission(
  user: { permissions: readonly Permission[] } | undefined,
  permission: Permission,
  message: string,
): void {
  if (!user) throw ApiError.unauthenticated();
  if (!user.permissions.includes(permission)) {
    throw new ApiError(403, 'FORBIDDEN', message, { required: [permission] });
  }
}

export function hasPermission(
  user: { permissions: readonly Permission[] } | undefined,
  permission: Permission,
): boolean {
  return Boolean(user?.permissions.includes(permission));
}
