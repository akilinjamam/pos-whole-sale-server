import { readFileSync } from 'node:fs';

import { Router } from 'express';

import { config } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { sendData } from '../lib/respond.js';

import { allRoutes } from './index.js';

/**
 * The service banner, served at `/` and at `/api/v1`.
 *
 * Neither path had a handler, so both fell through to `notFoundHandler` and answered a bare
 * 404. That is technically correct and practically useless: the first thing anyone does with a
 * new deployment — a developer, someone checking whether the VPS came back up, a load balancer
 * — is open the base URL, and "No route for GET /" tells them nothing about whether the
 * service is alive, which build is running, or where the endpoints are.
 *
 * So this answers the three questions that actually get asked at the root: *is it up*, *what
 * is it*, and *where do I go next*.
 *
 * The module list is derived from `allRoutes` rather than written out here, so it cannot drift
 * — a module registered in the table appears here automatically, and one that is commented out
 * disappears. `requiresAuth` is included deliberately: the most common confusion against a new
 * deployment is a 401 nobody expected, and this makes the two public mounts obvious.
 *
 * This is **not** `/health`. Health probes the database and reports the replica-set flag, and
 * it stays the endpoint uptime monitoring should watch. This one touches nothing.
 */

const API_BASE = '/api/v1';

/**
 * Read once, at import. `../../package.json` resolves identically from `src/routes/` under tsx
 * and from `dist/routes/` under `node dist/index.js`, because the build preserves the depth.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    // A missing or malformed package.json must not stop the service from answering.
    return '0.0.0';
  }
}

const version = readVersion();

/** Local to this file on purpose — `@shared/types` is the *client's* contract, and no client
 *  calls this. Putting it there would mean syncing both copies for an endpoint the app never
 *  consumes. */
interface ApiIndexPayload {
  name: string;
  version: string;
  environment: string;
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
  apiBase: string;
  health: string;
  modules: { path: string; url: string; requiresAuth: boolean }[];
}

const rootRouter = Router();

rootRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const payload: ApiIndexPayload = {
      name: 'Optical Wholesale ERP + POS API',
      version,
      environment: config.env,
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      apiBase: API_BASE,
      health: `${API_BASE}/health`,
      modules: allRoutes.map((r) => ({
        path: r.path,
        url: `${API_BASE}/${r.path}`,
        requiresAuth: !r.public,
      })),
    };

    sendData(res, payload);
  }),
);

export default rootRouter;
