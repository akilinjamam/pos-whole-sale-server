import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import {
  OrderStatusWriteError,
  WholesaleOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import {
  getOrder,
  transitionOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { OrderStatus } from '../../src/shared/enums.js';
import type { Permission } from '../../src/shared/permissions.js';

/**
 * Day 21's "done when", against a real replica set in a throwaway org:
 *   - no status can be set except through the state machine;
 *   - illegal transitions return 409;
 *   - every transition is appended to `statusHistory`.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;

async function draftOrder(): Promise<Types.ObjectId> {
  const doc = await WholesaleOrder.create({
    orgId: f.orgId,
    dealerPartyId: new Types.ObjectId(f.dealerId),
    locationId: f.locationId,
    orderDate: new Date(),
    createdBy: f.userId,
    lines: [
      {
        lineNo: 1,
        productId: new Types.ObjectId(f.frameId),
        uomCode: 'PCS',
        uomQty: 12,
        qtyBase: 12,
        unitPriceMinor: 5_000,
        lineTotalMinor: 60_000,
      },
    ],
  });
  return doc._id;
}

/** Stand-in for Day 22's credit check, which is not a status write and so is not guarded. */
const markCreditOk = (id: Types.ObjectId) =>
  WholesaleOrder.updateOne(
    { _id: id },
    { $set: { creditCheck: { status: 'OK', checkedAt: new Date() } } },
  );

const move = (id: Types.ObjectId, to: OrderStatus, reason?: string, who = actor) =>
  withTransaction((session) => transitionOrder(who, id, to, { session, reason }));

const statusOf = async (id: Types.ObjectId) =>
  (await WholesaleOrder.findById(id).lean())!.status;

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeAll(async () => {
  await connectDatabase();
  await WholesaleOrder.syncIndexes();
  f = await createPosFixture();
  actor = actorFor(f);
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('creation', () => {
  it('creates a DRAFT with no number and the creation entry in its history', async () => {
    const order = (await WholesaleOrder.findById(await draftOrder()).lean())!;
    expect(order.status).toBe('DRAFT');
    expect(order.docNo).toBeNull();
    expect(order.fulfillmentStatus).toBe('NONE');
    expect(order.billingStatus).toBe('UNBILLED');
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0]).toMatchObject({ from: null, to: 'DRAFT', action: 'create' });
  });

  it('refuses to create an order in any other status', async () => {
    await expect(
      WholesaleOrder.create({
        orgId: f.orgId,
        dealerPartyId: new Types.ObjectId(f.dealerId),
        locationId: f.locationId,
        orderDate: new Date(),
        status: 'CONFIRMED',
      }),
    ).rejects.toBeInstanceOf(OrderStatusWriteError);
    await expect(
      WholesaleOrder.insertMany([
        {
          orgId: f.orgId,
          dealerPartyId: new Types.ObjectId(f.dealerId),
          locationId: f.locationId,
          orderDate: new Date(),
          status: 'DISPATCHED',
        },
      ]),
    ).rejects.toBeInstanceOf(OrderStatusWriteError);
  });
});

describe('no status can be set except through the state machine', () => {
  let id: Types.ObjectId;
  beforeAll(async () => {
    id = await draftOrder();
  });

  it('refuses updateOne / updateMany / findOneAndUpdate / findByIdAndUpdate', async () => {
    const attempts = [
      () => WholesaleOrder.updateOne({ _id: id }, { $set: { status: 'CONFIRMED' } }),
      () => WholesaleOrder.updateOne({ _id: id }, { status: 'CONFIRMED' }),
      () => WholesaleOrder.updateMany({ orgId: f.orgId }, { $set: { status: 'CANCELLED' } }),
      () => WholesaleOrder.findOneAndUpdate({ _id: id }, { $set: { status: 'CLOSED' } }),
      () => WholesaleOrder.findByIdAndUpdate(id, { status: 'DISPATCHED' }),
      () =>
        WholesaleOrder.updateOne(
          { _id: id },
          { $push: { statusHistory: { to: 'CLOSED', action: 'x', at: new Date() } } },
        ),
      () => WholesaleOrder.updateOne({ _id: id }, { $unset: { statusHistory: 1 } }),
      () => WholesaleOrder.updateOne({ _id: id }, [{ $set: { status: 'CLOSED' } }]),
      () => WholesaleOrder.replaceOne({ _id: id }, { status: 'CLOSED' }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(OrderStatusWriteError);
    }
    expect(await statusOf(id)).toBe('DRAFT');
  });

  it('refuses save() of a loaded order with a changed status or history', async () => {
    const doc = (await WholesaleOrder.findById(id))!;
    doc.status = 'CONFIRMED';
    await expect(doc.save()).rejects.toBeInstanceOf(OrderStatusWriteError);

    const again = (await WholesaleOrder.findById(id))!;
    again.statusHistory.push({
      from: 'DRAFT',
      to: 'CLOSED',
      action: 'x',
      at: new Date(),
      by: null,
      reason: null,
    });
    await expect(again.save()).rejects.toBeInstanceOf(OrderStatusWriteError);
    expect(await statusOf(id)).toBe('DRAFT');
  });

  it('still allows writes that do not touch status', async () => {
    await WholesaleOrder.updateOne({ _id: id }, { $set: { note: 'ZZTEST note' } });
    const doc = (await WholesaleOrder.findById(id))!;
    doc.requiredDate = new Date();
    await doc.save();
    expect((await WholesaleOrder.findById(id).lean())!.note).toBe('ZZTEST note');
  });
});

describe('transitionOrder', () => {
  it('moves along a legal edge and appends to the history', async () => {
    const id = await draftOrder();
    await markCreditOk(id);
    const confirmed = await move(id, 'CONFIRMED');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect(String(confirmed.confirmedBy)).toBe(String(f.userId));

    const picking = await move(id, 'PICKING');
    expect(picking.statusHistory.map((h) => [h.from, h.to, h.action])).toEqual([
      [null, 'DRAFT', 'create'],
      ['DRAFT', 'CONFIRMED', 'confirm'],
      ['CONFIRMED', 'PICKING', 'startPicking'],
    ]);
    expect(String(picking.statusHistory[2]!.by)).toBe(String(f.userId));

    const cancelled = await move(id, 'CANCELLED', 'ZZTEST dealer withdrew');
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'ZZTEST dealer withdrew',
    });
    expect(cancelled.statusHistory.at(-1)).toMatchObject({
      from: 'PICKING',
      to: 'CANCELLED',
      reason: 'ZZTEST dealer withdrew',
    });
  });

  it('returns 409 ILLEGAL_TRANSITION for an edge that does not exist, and writes nothing', async () => {
    const id = await draftOrder();
    await markCreditOk(id);
    await move(id, 'CONFIRMED');
    const before = (await WholesaleOrder.findById(id).lean())!;

    for (const to of ['DRAFT', 'DISPATCHED', 'DELIVERED', 'CLOSED', 'CONFIRMED'] as const) {
      const err = await refusal(move(id, to, 'ZZTEST'));
      expect(err.status).toBe(409);
      expect(err.code).toBe('ILLEGAL_TRANSITION');
    }
    const after = (await WholesaleOrder.findById(id).lean())!;
    expect(after.status).toBe('CONFIRMED');
    expect(after.statusHistory).toHaveLength(before.statusHistory.length);
  });

  it('returns 409 when a guard fails — confirming before the credit check has run', async () => {
    const id = await draftOrder();
    const err = await refusal(move(id, 'CONFIRMED'));
    expect([err.status, err.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
    expect(await statusOf(id)).toBe('DRAFT');
  });

  it('nothing leaves a terminal status', async () => {
    const id = await draftOrder();
    await move(id, 'CANCELLED');
    for (const to of ['DRAFT', 'CONFIRMED', 'CLOSED'] as const) {
      expect((await refusal(move(id, to, 'ZZTEST'))).status).toBe(409);
    }
  });

  it('403 without the edge’s permission; 422 without a required reason', async () => {
    const id = await draftOrder();
    await markCreditOk(id);
    const rep = actorFor(f, ['order:read', 'order:create'] as Permission[]);
    expect((await refusal(move(id, 'CONFIRMED', undefined, rep))).status).toBe(403);

    await move(id, 'CONFIRMED');
    const err = await refusal(move(id, 'CANCELLED'));
    expect([err.status, err.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(await statusOf(id)).toBe('CONFIRMED');
  });

  it('two racing transitions of one order: exactly one wins, the other gets 409', async () => {
    const id = await draftOrder();
    await markCreditOk(id);
    await move(id, 'CONFIRMED');

    // The same move twice, so the loser is illegal whichever lands first. (Two *different* moves
    // can both be legal in sequence — a loser retried after a WriteConflict re-reads the order and
    // is judged against the winner's status, which is the point of the retry.)
    const results = await Promise.allSettled([move(id, 'PICKING'), move(id, 'PICKING')]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ApiError);
    expect((lost[0]!.reason as ApiError).status).toBe(409);

    const order = (await WholesaleOrder.findById(id).lean())!;
    // One history entry for the winner, none for the loser.
    expect(order.statusHistory).toHaveLength(3);
    expect(order.statusHistory.at(-1)!.to).toBe(order.status);
  });

  it('an order at a location outside the caller’s scope does not exist for them', async () => {
    const id = await draftOrder();
    const elsewhere = actorFor(f);
    elsewhere.user.locationIds = [String(new Types.ObjectId())];
    expect((await refusal(move(id, 'CANCELLED', undefined, elsewhere))).status).toBe(404);
  });
});

describe('getOrder', () => {
  it('serialises the order with the caller’s available actions', async () => {
    const id = await draftOrder();
    await markCreditOk(id);
    const payload = await getOrder(actor, id);
    expect(payload).toMatchObject({
      status: 'DRAFT',
      docNo: null,
      dealerName: expect.any(String),
      locationName: 'ZZTEST Counter',
    });
    expect(payload.lines[0]).toMatchObject({
      qtyBase: 12,
      qtyOutstandingBase: 12,
      sku: 'ZZ-FRM',
    });
    expect(payload.availableActions.map((a) => a.action)).toEqual(['confirm', 'cancel']);
    expect(payload.statusHistory[0]).toMatchObject({ from: null, to: 'DRAFT' });
  });
});
