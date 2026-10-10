import { AuditLog } from '../modules/audit/auditLog.model.js';

import type { RequestActor } from '../lib/requestUser.js';
import type { AuditAction } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * THE audit writer. Takes the caller's session and never commits on its own: the entry lands with
 * the act it records, or not at all. Where the act came from — IP, browser, request id — comes off
 * the actor, set by `requestActorOf` from the HTTP request.
 */
export interface AuditInput {
  action: AuditAction;
  entity: string;
  entityId: Types.ObjectId | null;
  docNo?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  at?: Date;
}

export async function writeAudit(
  session: ClientSession,
  actor: RequestActor,
  input: AuditInput,
): Promise<void> {
  await AuditLog.create(
    [
      {
        orgId: actor.orgId,
        at: input.at ?? new Date(),
        actorUserId: actor.actorId,
        actorName: actor.user.name,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        docNo: input.docNo ?? null,
        reason: input.reason ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        ip: actor.context?.ip ?? null,
        userAgent: actor.context?.userAgent ?? null,
        requestId: actor.context?.requestId ?? null,
      },
    ],
    { session },
  );
}
