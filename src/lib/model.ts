import { Schema } from 'mongoose';

import type { Types } from 'mongoose';

/**
 * The conventions every collection in this system follows, in one place.
 *
 * §6.1 of the project plan requires that *every* document carries `orgId` (indexed, taken from
 * the JWT and never from the request body), `createdBy`/`updatedBy` and timestamps. Repeating
 * that by hand in twenty-odd models is how one of them ends up without it.
 */

/** Fields every tenant-scoped document carries. Spread into the schema definition. */
export const auditableFields = {
  orgId: {
    type: Schema.Types.ObjectId,
    ref: 'Org',
    required: true,
    index: true,
  },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
} as const;

export interface AuditableDoc {
  orgId: Types.ObjectId;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Standard schema behaviour, applied as a plugin rather than as a shared options object.
 *
 * `SchemaOptions` is generic over the document type, so one shared constant cannot be handed
 * to `new Schema<Org>()` and `new Schema<User>()` both — it pins to whatever it was first
 * inferred as and the second call fails to unify. A plugin sidesteps the generic entirely and
 * applies the same settings to every schema.
 *
 * The `toJSON` transform renames `_id` to `id` and drops `__v`, so the wire shape matches the
 * `*Payload` types in `@shared/types` and the client never sees a Mongo-shaped document.
 */
export function baseSchemaPlugin(schema: Schema): void {
  schema.set('timestamps', true);
  schema.set('versionKey', false);
  schema.set('toJSON', {
    virtuals: true,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = String(ret._id);
      delete ret._id;
      return ret;
    },
  });
  schema.set('toObject', { virtuals: true });
}

/** `String(id)` that tolerates the `null | undefined` a populated-or-not field may hold. */
export function idToString(value: Types.ObjectId | null | undefined): string | null {
  return value ? String(value) : null;
}

export function idsToStrings(values: readonly Types.ObjectId[] | undefined): string[] {
  return (values ?? []).map((v) => String(v));
}
