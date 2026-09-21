import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';
import { toPermissions } from '../../shared/permissions.js';

import type { RolePayload } from '@shared/types.js';
import type { Permission } from '@shared/permissions.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A named bundle of permissions.
 *
 * Roles are **data**, so the client can re-scope "Sales Rep" without a deploy. The catalog of
 * permissions they may contain is **code** (`@shared/permissions.ts`), so the set of possible
 * capabilities cannot drift from what the routes actually check.
 *
 * `permissions` is stored as plain strings rather than a Mongoose enum of the catalog: a role
 * saved before a permission was renamed must still load. `toPermissions` filters the unknown
 * entries out at the boundary, so a stale string is ignored rather than silently honoured.
 *
 * `isSystem` marks the seven seeded roles. They can be edited — that is the whole point of the
 * permission-matrix editor — but not deleted, because a user with no role has no access at all.
 */
export interface RoleDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDoc>(
  {
    ...auditableFields,
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: null },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
  },
);

roleSchema.plugin(baseSchemaPlugin);

roleSchema.index({ orgId: 1, code: 1 }, { unique: true });

export type RoleDocument = HydratedDocument<RoleDoc>;
export type RoleModel = Model<RoleDoc>;

export const Role: RoleModel = model<RoleDoc>('Role', roleSchema);

export function toRolePayload(doc: RoleDoc, userCount?: number): RolePayload {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    description: doc.description,
    permissions: toPermissions(doc.permissions) as Permission[],
    isSystem: doc.isSystem,
    ...(userCount === undefined ? {} : { userCount }),
  };
}
