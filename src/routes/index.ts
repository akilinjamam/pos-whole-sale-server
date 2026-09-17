import type { Router } from 'express';

import healthRouter from '../modules/health/health.route.js';

/**
 * The route table. Every module's router is mounted at `/api/v1/<path>` from this array —
 * a module that is not listed here is unreachable.
 *
 * `public: true` exempts a router from the blanket `authenticate` guard in app.ts. Keep that
 * list minimal and obvious; from Day 3 a test walks this table and fails the build if any
 * non-public route lacks both `authenticate` and `requirePermission`.
 */
export interface RouteEntry {
  path: string;
  route: Router;
  public?: boolean;
}

export const allRoutes: RouteEntry[] = [
  { path: 'health', route: healthRouter, public: true },

  // Day 2 onwards:
  // { path: 'auth',     route: authRouter, public: true },
  // { path: 'users',    route: userRouter },
  // { path: 'roles',    route: roleRouter },
  // { path: 'locations', route: locationRouter },
  // …
];

/** Paths that skip authentication, as full mount prefixes. */
export const publicPaths: string[] = allRoutes
  .filter((r) => r.public)
  .map((r) => `/api/v1/${r.path}`);
