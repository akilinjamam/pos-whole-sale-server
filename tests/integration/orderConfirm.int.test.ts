import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { Party } from '../../src/modules/party/party.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import { WholesaleOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import {
  approveOrder,
  cancelOrder,
  confirmOrder,
  createOrder,
  quoteOrder,
  rejectOrder,
  updateOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { postMovements } from '../../src/services/stock.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { CreateOrderInput } from '../../src/shared/orders.js';
import type { Permission } from '../../src/shared/permissions.js';

/**
 * Day 22's "done when", against a real replica set in a throwaway org:
 *   - confirming reserves stock: available drops, on-hand does not;
 *   - cancelling releases it exactly.
 * And the edges around it: prices recomputed server-side on every save, an oversubscribed confirm
 * refused cleanly, reservations respected by a counter sale, and the three credit outcomes.
 *
 * The fixture's shelf: 60 frames (PCS, DOZ ×12, ৳60 each by default) and 2 serialised machines.
 */

let f: PosFixture;
let manager: ReturnType<typeof actorFor>;
let rep: ReturnType<typeof actorFor>;

const REP: Permission[] = ['order:read', 'order:create', 'order:update', 'order:confirm'];
const oid = (id: string) => new Types.ObjectId(id);

async function shelf(productId: string) {
  const b = await StockBalance.findOne({
    orgId: f.orgId,
    locationId: f.locationId,
    productId: oid(productId),
  }).lean();
  const onHand = b?.qtyOnHand ?? 0;
  const reserved = b?.qtyReserved ?? 0;
  return { onHand, reserved, available: onHand - reserved };
}

const order = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  dealerPartyId: f.dealerId,
  locationId: String(f.locationId),
  lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 2 }],
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const ledgerRows = () => StockLedger.countDocuments({ orgId: f.orgId });

beforeAll(async () => {
  await connectDatabase();
  await WholesaleOrder.syncIndexes();
  f = await createPosFixture();
  manager = actorFor(f);
  rep = actorFor(f, REP);
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

// Every test starts from a full, unreserved shelf and a dealer in good standing.
beforeEach(async () => {
  const open = await WholesaleOrder.find({
    orgId: f.orgId,
    status: { $in: ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED'] },
  }).lean();
  for (const o of open) await cancelOrder(manager, o._id, { reason: 'ZZTEST reset' });
  await Party.updateOne(
    { _id: oid(f.dealerId) },
    { $set: { 'dealer.creditHold': false, 'dealer.creditLimitMinor': 20_000_000 } },
  );
});

describe('drafts', () => {
  it('creates a numberless draft priced by the server, not the client', async () => {
    const o = await createOrder(
      rep,
      order({ lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 2 }] }),
    );
    expect(o).toMatchObject({
      status: 'DRAFT',
      docNo: null,
      dealerName: 'ZZTEST Rahman Optics',
    });
    // ৳60 a piece × 12 = ৳720 a dozen, × 2.
    expect(o.lines[0]).toMatchObject({
      uomCode: 'DOZ',
      uomQty: 2,
      qtyBase: 24,
      unitPriceMinor: 72_000,
      lineTotalMinor: 144_000,
      qtyReservedBase: 0,
    });
    expect(o.grandTotalMinor).toBe(144_000);
    expect(o.availableActions.map((a) => a.action)).toEqual(['confirm']);
  });

  it('re-prices on every save and keeps line ids stable', async () => {
    const o = await createOrder(manager, order());
    const updated = await updateOrder(manager, oid(o.id), {
      lines: [
        { productId: f.frameId, uomCode: 'DOZ', qty: 3 },
        { productId: f.machineId, qty: 1 },
      ],
      shippingMinor: 50_000,
    });
    expect(updated.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(updated.lines[0]!.id).toBe(o.lines[0]!.id);
    expect(updated.lines[0]!.lineTotalMinor).toBe(216_000);
    expect(updated.grandTotalMinor).toBe(216_000 + 5_000_000 + 50_000);

    // Leaving `lines` out keeps them — and still re-prices them.
    const again = await updateOrder(manager, oid(o.id), {
      note: 'ZZTEST call before delivery',
    });
    expect(again.lines).toHaveLength(2);
    expect(again.grandTotalMinor).toBe(updated.grandTotalMinor);
  });

  it('prorates an order discount so the lines add up to the total exactly', async () => {
    const o = await createOrder(
      manager,
      order({
        lines: [
          { productId: f.frameId, qty: 7 },
          { productId: f.machineId, qty: 1 },
        ],
        orderDiscount: { kind: 'AMOUNT', amountMinor: 100_001 },
      }),
    );
    const sum = o.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    expect(sum).toBe(o.grandTotalMinor);
    expect(o.orderDiscountMinor).toBe(100_001);
    expect(o.orderDiscount).toEqual({ kind: 'AMOUNT', amountMinor: 100_001 });
  });

  it('a rep may not discount or override a price — but may edit a manager’s discounted draft', async () => {
    const discounted = { productId: f.frameId, uomCode: 'DOZ', qty: 2, discountPct: 5 };
    expect((await refusal(createOrder(rep, order({ lines: [discounted] })))).status).toBe(403);
    expect(
      (await refusal(createOrder(rep, order({ orderDiscount: { kind: 'PCT', pct: 2 } }))))
        .status,
    ).toBe(403);
    expect(
      (
        await refusal(
          createOrder(
            rep,
            order({ lines: [{ productId: f.frameId, qty: 1, unitPriceMinor: 1 }] }),
          ),
        )
      ).status,
    ).toBe(403);

    const o = await createOrder(manager, order({ lines: [discounted] }));
    // Same discount resubmitted, quantity changed: allowed.
    const edited = await updateOrder(rep, oid(o.id), { lines: [{ ...discounted, qty: 3 }] });
    expect(edited.lines[0]).toMatchObject({ discountPct: 5, qtyBase: 36 });
    // A bigger discount: refused.
    expect(
      (
        await refusal(
          updateOrder(rep, oid(o.id), { lines: [{ ...discounted, discountPct: 10 }] }),
        )
      ).status,
    ).toBe(403);
  });

  it('refuses a new order for a dealer on credit hold', async () => {
    await Party.updateOne(
      { _id: oid(f.dealerId) },
      {
        $set: { 'dealer.creditHold': true, 'dealer.creditHoldReason': 'ZZTEST cheque bounced' },
      },
    );
    const err = await refusal(createOrder(manager, order()));
    expect([err.status, err.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
  });
});

describe('confirm reserves stock; cancel releases it exactly', () => {
  it('available drops while on-hand does not, and no ledger row is written', async () => {
    const before = await shelf(f.frameId);
    const machineBefore = await shelf(f.machineId);
    const rows = await ledgerRows();

    const draft = await createOrder(
      manager,
      order({
        lines: [
          { productId: f.frameId, uomCode: 'DOZ', qty: 2 },
          { productId: f.machineId, qty: 1 },
        ],
      }),
    );
    const confirmed = await confirmOrder(manager, oid(draft.id), {});

    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.docNo).toMatch(/^SO-/);
    expect(confirmed.creditCheck?.status).toBe('OK');
    expect(confirmed.lines.map((l) => [l.qtyBase, l.qtyReservedBase])).toEqual([
      [24, 24],
      [1, 1],
    ]);

    const after = await shelf(f.frameId);
    expect(after.onHand).toBe(before.onHand);
    expect(after.reserved).toBe(before.reserved + 24);
    expect(after.available).toBe(before.available - 24);
    expect((await shelf(f.machineId)).reserved).toBe(machineBefore.reserved + 1);
    expect(await ledgerRows()).toBe(rows);

    const cancelled = await cancelOrder(manager, oid(draft.id), {
      reason: 'ZZTEST dealer called off',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.lines.every((l) => l.qtyReservedBase === 0)).toBe(true);
    expect(await shelf(f.frameId)).toEqual(before);
    expect(await shelf(f.machineId)).toEqual(machineBefore);
    expect(await ledgerRows()).toBe(rows);
  });

  it('cancelling a confirmed order needs a reason; the refusal releases nothing', async () => {
    const o = await confirmOrder(manager, oid((await createOrder(manager, order())).id), {});
    const held = await shelf(f.frameId);
    const err = await refusal(cancelOrder(manager, oid(o.id), {}));
    expect(err.status).toBe(422);
    expect(await shelf(f.frameId)).toEqual(held);
    expect((await WholesaleOrder.findById(o.id).lean())!.status).toBe('CONFIRMED');
  });

  it('a confirmed order is no longer editable', async () => {
    const o = await confirmOrder(manager, oid((await createOrder(manager, order())).id), {});
    const err = await refusal(updateOrder(manager, oid(o.id), { note: 'late edit' }));
    expect([err.status, err.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
  });

  it('refuses to reserve more than is available — and leaves the draft, the shelf and the series untouched', async () => {
    const first = await confirmOrder(
      manager,
      oid(
        (await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 40 }] }))).id,
      ),
      {},
    );
    const held = await shelf(f.frameId); // 60 on hand, 40 reserved, 20 available

    const second = await createOrder(
      manager,
      order({ lines: [{ productId: f.frameId, qty: 21 }] }),
    );
    const err = await refusal(confirmOrder(manager, oid(second.id), {}));
    expect([err.status, err.code]).toEqual([409, 'INSUFFICIENT_STOCK']);
    expect(err.details).toMatchObject({
      requested: 21,
      onHand: 60,
      reserved: 40,
      available: 20,
    });

    const still = (await WholesaleOrder.findById(second.id).lean())!;
    expect(still).toMatchObject({ status: 'DRAFT', docNo: null });
    expect(still.lines[0]!.qtyReservedBase).toBe(0);
    expect(await shelf(f.frameId)).toEqual(held);

    // The refused confirm took no number: the next one follows straight on from the first.
    const third = await confirmOrder(
      manager,
      oid(
        (await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 20 }] }))).id,
      ),
      {},
    );
    const seq = (d: string | null) => Number(d!.split('-').pop());
    expect(seq(third.docNo)).toBe(seq(first.docNo) + 1);
  });

  it('two orders racing for the same last units: exactly one is confirmed', async () => {
    const a = await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 40 }] }));
    const b = await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 40 }] }));
    const results = await Promise.allSettled([
      confirmOrder(manager, oid(a.id), {}),
      confirmOrder(manager, oid(b.id), {}),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as ApiError).code).toBe('INSUFFICIENT_STOCK');
    expect((await shelf(f.frameId)).reserved).toBe(40);
  });
});

describe('reservations bind the rest of the system', () => {
  const sell = (qtyBase: number, movementType: 'SALE' | 'ADJUSTMENT') =>
    withTransaction((session) =>
      postMovements(session, {
        orgId: f.orgId,
        postedAt: new Date(),
        actorId: f.userId,
        movements: [
          {
            locationId: f.locationId,
            productId: oid(f.frameId),
            variantId: null,
            qtyBase: -qtyBase,
            movementType,
            refType: 'ZZTEST',
          },
        ],
      }),
    );

  it('a counter sale cannot take units a confirmed order is holding', async () => {
    await confirmOrder(
      manager,
      oid(
        (await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 50 }] }))).id,
      ),
      {},
    );
    const err = await refusal(sell(11, 'SALE'));
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.message).toMatch(/reserved for confirmed orders/);
    expect((await shelf(f.frameId)).onHand).toBe(60);
  });

  it('the quote shows available, not on-hand', async () => {
    await confirmOrder(
      manager,
      oid(
        (await createOrder(manager, order({ lines: [{ productId: f.frameId, qty: 15 }] }))).id,
      ),
      {},
    );
    const q = await quoteOrder(
      rep,
      order({ lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }] }),
    );
    expect(q.lines[0]).toMatchObject({
      availableBase: 45,
      qtyBase: 12,
      unitPriceMinor: 72_000,
    });
    expect(q.credit).toMatchObject({ verdict: 'OK', canOverride: false });
  });
});

describe('the credit check at confirm', () => {
  // Limit ৳1,000: a ৳1,440 order is over it.
  const overLimit = () =>
    Party.updateOne({ _id: oid(f.dealerId) }, { $set: { 'dealer.creditLimitMinor': 100_000 } });

  it('without order:creditOverride, an over-limit order goes to approval — nothing reserved, no number', async () => {
    await overLimit();
    const before = await shelf(f.frameId);
    const o = await confirmOrder(rep, oid((await createOrder(rep, order())).id), {});
    expect(o).toMatchObject({ status: 'PENDING_APPROVAL', docNo: null });
    expect(o.creditCheck).toMatchObject({
      status: 'BLOCKED',
      limitMinor: 100_000,
      exposureMinor: 144_000,
    });
    expect(await shelf(f.frameId)).toEqual(before);

    // The manager approves with a reason: now it reserves and numbers.
    const approved = await approveOrder(manager, oid(o.id), {
      reason: 'ZZTEST pays every month',
    });
    expect(approved).toMatchObject({
      status: 'CONFIRMED',
      docNo: expect.stringMatching(/^SO-/),
    });
    expect(approved.creditCheck).toMatchObject({
      status: 'OVERRIDDEN',
      overrideReason: 'ZZTEST pays every month',
      overriddenByUserId: String(f.userId),
    });
    expect((await shelf(f.frameId)).reserved).toBe(before.reserved + 24);
    expect(approved.statusHistory.map((h) => h.action)).toEqual([
      'create',
      'submitForApproval',
      'approve',
    ]);
  });

  it('a rejected order goes back to the rep as a draft', async () => {
    await overLimit();
    const o = await confirmOrder(rep, oid((await createOrder(rep, order())).id), {});
    const rejected = await rejectOrder(manager, oid(o.id), { reason: 'ZZTEST collect first' });
    expect(rejected.status).toBe('DRAFT');
    expect(rejected.statusHistory.at(-1)).toMatchObject({
      action: 'reject',
      reason: 'ZZTEST collect first',
    });
  });

  it('with order:creditOverride: asks for a reason, then confirms as OVERRIDDEN', async () => {
    await overLimit();
    const draft = await createOrder(manager, order());
    const ask = await refusal(confirmOrder(manager, oid(draft.id), {}));
    expect([ask.status, ask.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
    expect(ask.details).toMatchObject({ canOverride: true, limitMinor: 100_000 });
    expect((await WholesaleOrder.findById(draft.id).lean())!.status).toBe('DRAFT');

    const o = await confirmOrder(manager, oid(draft.id), {
      creditOverrideReason: 'ZZTEST owner approved by phone',
    });
    expect(o).toMatchObject({ status: 'CONFIRMED', creditCheck: { status: 'OVERRIDDEN' } });
    expect(o.statusHistory.at(-1)).toMatchObject({
      action: 'confirm',
      reason: 'ZZTEST owner approved by phone',
    });
  });

  it('a dealer put on hold after the draft was saved cannot be confirmed, even by a manager', async () => {
    const draft = await createOrder(manager, order());
    await Party.updateOne({ _id: oid(f.dealerId) }, { $set: { 'dealer.creditHold': true } });
    const err = await refusal(
      confirmOrder(manager, oid(draft.id), { creditOverrideReason: 'ZZTEST please' }),
    );
    expect([err.status, err.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
    expect((await WholesaleOrder.findById(draft.id).lean())!.status).toBe('DRAFT');
  });
});
