import { getDatabaseHealth } from '../../config/db.js';
import { config } from '../../config/env.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { sendData } from '../../lib/respond.js';

import type { HealthPayload } from '@shared/types.js';

/**
 * Liveness + topology report.
 *
 * Deliberately reports the replica-set flag: the client's Home page surfaces it, so a
 * standalone mongod that would break every transaction is visible from the first screen
 * rather than on the first sale.
 */
export const getHealth = asyncHandler(async (_req, res) => {
  const db = getDatabaseHealth();

  const payload: HealthPayload = {
    status: db.state === 'connected' && db.replicaSet ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    environment: config.env,
    timestamp: new Date().toISOString(),
    db,
  };

  sendData(res, payload);
});
