import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';

import { Org, toOrgPayload } from './org.model.js';

import type { UpdateOrgInput, UpdateOrgSettingsInput } from './org.schema.js';
import type { OrgPayload } from '@shared/types.js';

/**
 * The org is read on nearly every posting path — `invoiceOnDispatch` on each dispatch,
 * `allowNegativeStock` on each movement, `enforceCreditLimit` on each confirm. Callers that
 * need the settings inside a transaction read the document; callers that need the profile for
 * display get the payload.
 */

export async function getOrg(orgId: Types.ObjectId): Promise<OrgPayload> {
  const org = await Org.findById(orgId).lean();
  if (!org) throw ApiError.notFound('Organisation');
  return toOrgPayload(org);
}

export async function updateOrg(
  orgId: Types.ObjectId,
  input: UpdateOrgInput,
  actorId: Types.ObjectId,
): Promise<OrgPayload> {
  const org = await Org.findByIdAndUpdate(
    orgId,
    { $set: { ...input, updatedBy: actorId } },
    { new: true, runValidators: true },
  ).lean();

  if (!org) throw ApiError.notFound('Organisation');
  return toOrgPayload(org);
}

export async function updateOrgSettings(
  orgId: Types.ObjectId,
  input: UpdateOrgSettingsInput,
  actorId: Types.ObjectId,
): Promise<OrgPayload> {
  // Dot-path `$set` so a partial update touches only the flags named, rather than replacing
  // the whole subdocument and resetting the ones the client did not send.
  const set: Record<string, unknown> = { updatedBy: actorId };
  for (const [key, value] of Object.entries(input)) {
    set[`settings.${key}`] =
      key === 'defaultRetailTierId' && typeof value === 'string'
        ? new Types.ObjectId(value)
        : value;
  }

  const org = await Org.findByIdAndUpdate(
    orgId,
    { $set: set },
    { new: true, runValidators: true },
  ).lean();

  if (!org) throw ApiError.notFound('Organisation');
  return toOrgPayload(org);
}
