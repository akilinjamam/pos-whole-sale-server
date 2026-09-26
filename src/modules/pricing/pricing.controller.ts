import { asyncHandler } from '../../lib/asyncHandler.js';
import { orgIdOf } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';

import * as pricingService from './pricing.service.js';

import type { ResolveQuery } from './pricing.schema.js';

export const resolve = asyncHandler(async (req, res) => {
  const query = req.query as unknown as ResolveQuery;
  sendData(res, await pricingService.resolveForRequest(orgIdOf(req), query));
});
