import { ApiError } from '../lib/ApiError.js';

import type { AuthUser } from '@shared/types.js';
import type { Request, RequestHandler } from 'express';

/**
 * Assert that every `locationId` the request mentions is one the caller may touch.
 *
 * This is the typed replacement for the retail system's `getBranchId` / `addBranch*` helpers,
 * which re-parsed the Authorization header at each call site and trusted whatever branch the
 * body happened to carry. Here the allowed set arrives on a verified token, and a request that
 * names a location outside it is refused before the handler runs.
 *
 * A user with an **empty** `locationIds` is unrestricted — that is how OWNER and ADMIN are
 * modelled, rather than by listing every warehouse on their account and having to remember to
 * extend it whenever one is opened.
 */
function isAllowed(user: AuthUser, locationId: string): boolean {
  return user.locationIds.length === 0 || user.locationIds.includes(locationId);
}

/** Pull candidate location ids out of params, body and query. */
function locationIdsIn(req: Request): string[] {
  const found: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) found.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
  };

  const sources: Record<string, unknown>[] = [
    req.params as Record<string, unknown>,
    (req.body ?? {}) as Record<string, unknown>,
    req.query as Record<string, unknown>,
  ];

  for (const source of sources) {
    collect(source.locationId);
    collect(source.fromLocationId);
    collect(source.toLocationId);
    collect(source.locationIds);
  }

  return found;
}

export const requireLocation: RequestHandler = (req, _res, next) => {
  const user = req.user;
  if (!user) {
    next(ApiError.unauthenticated());
    return;
  }

  const denied = locationIdsIn(req).filter((id) => !isAllowed(user, id));
  if (denied.length > 0) {
    next(
      new ApiError(403, 'FORBIDDEN', 'You do not have access to that location', {
        locationIds: [...new Set(denied)],
      }),
    );
    return;
  }

  next();
};

/**
 * The read-side counterpart, for services: the set a list query must be filtered by.
 *
 * Returns `null` for an unrestricted user, which callers translate to "no location clause" —
 * deliberately not an empty array, because `{ locationId: { $in: [] } }` matches nothing and
 * would silently show an owner an empty warehouse.
 */
export function locationScopeOf(user: AuthUser): string[] | null {
  return user.locationIds.length === 0 ? null : user.locationIds;
}

/** Throwing form, for a single id resolved inside a service. */
export function assertLocationAllowed(user: AuthUser, locationId: string): void {
  if (!isAllowed(user, locationId)) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to that location', {
      locationIds: [locationId],
    });
  }
}
