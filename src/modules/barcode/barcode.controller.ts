import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/ApiError.js';
import { orgIdOf, requireAuth } from '../../lib/requestUser.js';
import { sendData } from '../../lib/respond.js';
import { findByBarcode } from '../../services/barcode.service.js';

/**
 * Resolve a scanned code.
 *
 * A 404 for an unknown code rather than `null` in a 200 envelope: at the counter this is the
 * difference between "that scan did not work" and "the scanner returned nothing", and the
 * client's interceptor already turns a 404 into a message.
 */
export const lookup = asyncHandler(async (req, res) => {
  const code = String(req.params.code ?? '').trim();
  const includeCost = requireAuth(req).permissions.includes('stock:viewCost');

  const match = await findByBarcode(orgIdOf(req), code, includeCost);
  if (!match) throw ApiError.notFound(`Barcode ${code}`);

  sendData(res, match);
});
