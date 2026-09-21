import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { User } from '../user/user.model.js';

import { Role, toRolePayload } from './role.model.js';

import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from './role.schema.js';
import type { RoleDoc } from './role.model.js';
import type { PageMeta, RolePayload } from '@shared/types.js';
import type { FilterQuery, Types } from 'mongoose';

const SORTABLE = ['code', 'name', 'createdAt'] as const;

/**
 * Revoke every token issued to the holders of a role.
 *
 * This is the other half of `tokenVersion`. An access token lives fifteen minutes and carries
 * its bearer's permissions; without this bump, narrowing a role would leave everyone holding
 * it with their old access until their token expired — a quarter of an hour during which a
 * demoted user can still post. `authenticate` compares the version on every request, so the
 * change lands on their very next call.
 *
 * It is one `updateMany` on an indexed field, which is why it can be afforded on every edit.
 */
async function revokeTokensForRole(orgId: Types.ObjectId, roleId: Types.ObjectId): Promise<number> {
  const result = await User.updateMany({ orgId, roleIds: roleId }, { $inc: { tokenVersion: 1 } });
  return result.modifiedCount;
}

export async function listRoles(
  orgId: Types.ObjectId,
  query: ListRolesQuery,
): Promise<{ items: RolePayload[]; meta: PageMeta }> {
  const filter: FilterQuery<RoleDoc> = { orgId };
  if (query.isSystem !== undefined) filter.isSystem = query.isSystem;

  const { items, meta } = await paginate<RoleDoc>(Role, {
    filter,
    query,
    sortable: SORTABLE,
    defaultSort: { code: 1 },
  });

  // One grouped count for the page rather than a count per row — the roles screen shows
  // "how many users hold this" beside every role, and N+1 for a nine-row table is still N+1.
  const counts = await User.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { orgId, roleIds: { $in: items.map((r) => r._id) } } },
    { $unwind: '$roleIds' },
    { $group: { _id: '$roleIds', count: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.count]));

  return {
    items: items.map((r) => toRolePayload(r, countBy.get(String(r._id)) ?? 0)),
    meta,
  };
}

export async function getRole(orgId: Types.ObjectId, id: Types.ObjectId): Promise<RolePayload> {
  const role = await Role.findOne({ _id: id, orgId }).lean();
  if (!role) throw ApiError.notFound('Role');

  const userCount = await User.countDocuments({ orgId, roleIds: id });
  return toRolePayload(role, userCount);
}

export async function createRole(
  orgId: Types.ObjectId,
  input: CreateRoleInput,
  actorId: Types.ObjectId,
): Promise<RolePayload> {
  const role = await Role.create({
    ...input,
    orgId,
    isSystem: false,
    createdBy: actorId,
    updatedBy: actorId,
  });
  return toRolePayload(role.toObject(), 0);
}

/**
 * System roles are editable — re-scoping "Sales Rep" without a deploy is the point of storing
 * roles as data — but their `code` and their existence are fixed.
 */
export async function updateRole(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateRoleInput,
  actorId: Types.ObjectId,
): Promise<RolePayload> {
  const role = await Role.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { ...input, updatedBy: actorId } },
    { new: true, runValidators: true },
  ).lean();

  if (!role) throw ApiError.notFound('Role');

  if (input.permissions) {
    await revokeTokensForRole(orgId, id);
  }

  const userCount = await User.countDocuments({ orgId, roleIds: id });
  return toRolePayload(role, userCount);
}

/**
 * Deletion is refused in two cases, both of which would leave someone locked out with no
 * obvious cause: a seeded system role, and a role somebody still holds.
 */
export async function deleteRole(orgId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
  const role = await Role.findOne({ _id: id, orgId }).lean();
  if (!role) throw ApiError.notFound('Role');

  if (role.isSystem) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${role.name}" is a system role and cannot be deleted. Edit its permissions instead.`,
    );
  }

  const userCount = await User.countDocuments({ orgId, roleIds: id });
  if (userCount > 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `${userCount} user(s) still hold "${role.name}". Reassign them first.`,
      { userCount },
    );
  }

  await Role.deleteOne({ _id: id, orgId });
}
