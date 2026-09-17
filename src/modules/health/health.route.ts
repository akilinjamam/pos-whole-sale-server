import { Router } from 'express';

import { getHealth } from './health.controller.js';

const healthRouter = Router();

// Public by design — it is on the authenticate allow-list in app.ts, and reports no data
// beyond liveness and topology.
healthRouter.get('/', getHealth);

export default healthRouter;
