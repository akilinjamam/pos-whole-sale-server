import { ApiError } from '../../lib/ApiError.js';

import { HELD_SALE_TTL_HOURS, HeldSale } from './heldSale.model.js';
import { PosSession } from './posSession.model.js';

import type { HeldSaleDoc } from './heldSale.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { HoldSaleInput } from '@shared/pos.js';
import type { HeldSalePayload } from '@shared/types.js';
import type { Types } from 'mongoose';

/**
 * Parked carts. Nothing is priced, reserved or posted — a held sale is the cart as typed, and it
 * is re-validated and re-priced like any other sale when it is finally sold (`heldSaleId` on the
 * sale deletes it in the same transaction). Scoped to the till: a cart parked at the counter is
 * resumed at the counter.
 */

const toPayload = (h: HeldSaleDoc): HeldSalePayload => ({
  id: String(h._id),
  label: h.label,
  partyId: h.partyId ? String(h.partyId) : null,
  walkInName: h.walkInName,
  lines: h.lines as HeldSalePayload['lines'],
  orderDiscount: (h.orderDiscount as HeldSalePayload['orderDiscount']) ?? null,
  note: h.note,
  createdAt: h.createdAt.toISOString(),
  expiresAt: h.expiresAt.toISOString(),
});

async function mySession(actor: RequestActor) {
  const s = await PosSession.findOne({
    orgId: actor.orgId,
    openedByUserId: actor.actorId,
    status: 'OPEN',
  }).lean();
  if (!s) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Open a shift first');
  return s;
}

export async function holdSale(
  actor: RequestActor,
  input: HoldSaleInput,
): Promise<HeldSalePayload> {
  const s = await mySession(actor);
  const doc = await HeldSale.create({
    orgId: actor.orgId,
    locationId: s.locationId,
    posSessionId: s._id,
    userId: actor.actorId,
    label: input.label,
    partyId: input.partyId ?? null,
    walkInName: input.walkInName ?? null,
    lines: input.lines,
    orderDiscount: input.orderDiscount ?? null,
    note: input.note ?? null,
    expiresAt: new Date(Date.now() + HELD_SALE_TTL_HOURS * 3_600_000),
  });
  return toPayload(doc.toObject());
}

/** Every cart parked at this till's location — any cashier there may resume one. */
export async function listHeld(actor: RequestActor): Promise<HeldSalePayload[]> {
  const s = await mySession(actor);
  const rows = await HeldSale.find({
    orgId: actor.orgId,
    locationId: s.locationId,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return rows.map(toPayload);
}

export async function getHeld(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<HeldSalePayload> {
  const s = await mySession(actor);
  const h = await HeldSale.findOne({
    _id: id,
    orgId: actor.orgId,
    locationId: s.locationId,
  }).lean();
  if (!h) throw ApiError.notFound('Held sale');
  return toPayload(h);
}

export async function discardHeld(actor: RequestActor, id: Types.ObjectId): Promise<void> {
  const s = await mySession(actor);
  const { deletedCount } = await HeldSale.deleteOne({
    _id: id,
    orgId: actor.orgId,
    locationId: s.locationId,
  });
  if (deletedCount === 0) throw ApiError.notFound('Held sale');
}
