import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { creditOverrides, listAudit } from '../../src/modules/audit/audit.service.js';
import { AuditLog } from '../../src/modules/audit/auditLog.model.js';
import { Dispatch } from '../../src/modules/dispatch/dispatch.model.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { receiveCheque } from '../../src/modules/payment/cheque.service.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import { postReceipt } from '../../src/modules/payment/receipt.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { openSession } from '../../src/modules/pos/posSession.service.js';
import { WholesaleOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import {
  approveOrder,
  confirmOrder,
  createOrder,
  quoteOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { creditExposure } from '../../src/services/creditExposure.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import { PERMISSIONS } from '../../src/shared/permissions.js';

import type { Permission } from '../../src/shared/permissions.js';

/**
 * Day 31's "done when", against a real replica set in a throwaway org:
 *   - an over-limit order blocks for a sales rep and routes to approval;
 *   - a sales manager overrides with a reason, and an audit entry records it.
 * And the edges: exposure counts confirmed orders not yet invoiced and nets off money on account
 * (but not a cheque in hand), the counter honours it too, dispatch re-checks it, a hold stops the
 * goods even for an overridden order, and the dashboard reads it all back.
 *
 * The dealer's limit is ৳1,000 throughout; each order is one dozen frames, ৳720.
 */

let f: PosFixture;
let manager: RequestActor;
let rep: RequestActor;
let storekeeper: RequestActor;

const REP: Permission[] = ['order:read', 'order:create', 'order:update', 'order:confirm'];
const STORE: Permission[] = [...PERMISSIONS.DISPATCH, 'order:read'];
const LIMIT = 100_000;
const DOZEN = 72_000;

const oid = (id: string) => new Types.ObjectId(id);
const today = () => new Date().toISOString().slice(0, 10);
const exposure = () => creditExposure(f.orgId, oid(f.dealerId));
const overrides = () => AuditLog.countDocuments({ orgId: f.orgId, action: 'CREDIT_OVERRIDE' });
const draft = (actor: RequestActor) =>
  createOrder(actor, {
    dealerPartyId: f.dealerId,
    locationId: String(f.locationId),
    lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
  });

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

async function packed(orderId: string) {
  const d = await createDispatch(storekeeper, { orderId });
  await packDispatch(storekeeper, oid(d.id));
  return d.id;
}

let orderA: string; // confirmed within the limit
let orderB: string; // parked, then approved past it

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([
    AuditLog.syncIndexes(),
    Dispatch.syncIndexes(),
    Invoice.syncIndexes(),
    PaymentDoc.syncIndexes(),
    WholesaleOrder.syncIndexes(),
  ]);
  f = await createPosFixture();
  manager = {
    ...actorFor(f),
    context: { ip: '203.0.113.7', userAgent: 'ZZTEST browser', requestId: 'zztest-req-1' },
  };
  rep = actorFor(f, REP);
  storekeeper = actorFor(f, STORE);
  await Party.updateOne(
    { _id: oid(f.dealerId) },
    { $set: { 'dealer.creditLimitMinor': LIMIT } },
  );
  await openSession(manager, {
    locationId: String(f.locationId),
    terminalCode: 'T1',
    openingFloatMinor: 0,
  });
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('exposure counts confirmed orders, not just invoices', () => {
  it('the first order fits; the second does not — though nothing is invoiced and the balance is 0', async () => {
    const a = await confirmOrder(rep, oid((await draft(rep)).id), {});
    expect(a).toMatchObject({ status: 'CONFIRMED', creditCheck: { status: 'OK' } });
    orderA = a.id;
    expect((await Party.findById(f.dealerId).lean())!.currentBalanceMinor).toBe(0);
    expect(await exposure()).toMatchObject({ openOrdersMinor: DOZEN, exposureMinor: DOZEN });

    // The builder's panel sees it before the rep presses Confirm.
    const q = await quoteOrder(rep, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
    });
    expect(q.credit).toMatchObject({
      verdict: 'OVER_LIMIT',
      balanceMinor: 0,
      openOrdersMinor: DOZEN,
      exposureMinor: DOZEN,
      exposureAfterMinor: 2 * DOZEN,
      shortfallMinor: 2 * DOZEN - LIMIT,
      canOverride: false,
    });
  });

  it('THE DONE-WHEN, part 1: for a rep, the over-limit order parks in approval — no audit entry', async () => {
    const before = await overrides();
    const b = await confirmOrder(rep, oid((await draft(rep)).id), {
      // A rep cannot override, so a reason changes nothing.
      creditOverrideReason: 'ZZTEST I say so',
    });
    expect(b).toMatchObject({ status: 'PENDING_APPROVAL', docNo: null });
    expect(b.creditCheck).toMatchObject({
      status: 'BLOCKED',
      outstandingMinor: DOZEN,
      exposureMinor: 2 * DOZEN,
      limitMinor: LIMIT,
    });
    orderB = b.id;
    // A parked order is not a commitment, so it is not exposure.
    expect((await exposure()).openOrdersMinor).toBe(DOZEN);
    expect(await overrides()).toBe(before);
  });

  it('THE DONE-WHEN, part 2: the manager approves with a reason, and the audit log records it', async () => {
    const approved = await approveOrder(manager, oid(orderB), {
      reason: 'ZZTEST pays on the 5th every month',
    });
    expect(approved).toMatchObject({
      status: 'CONFIRMED',
      creditCheck: {
        status: 'OVERRIDDEN',
        overrideReason: 'ZZTEST pays on the 5th every month',
        overriddenByUserId: String(f.userId),
      },
    });

    const entry = (await AuditLog.findOne({ orgId: f.orgId, entityId: oid(orderB) }).lean())!;
    expect(entry).toMatchObject({
      action: 'CREDIT_OVERRIDE',
      entity: 'WholesaleOrder',
      docNo: approved.docNo,
      actorUserId: f.userId,
      actorName: 'ZZTEST Cashier',
      reason: 'ZZTEST pays on the 5th every month',
      before: {
        stage: 'APPROVE',
        verdict: 'OVER_LIMIT',
        limitMinor: LIMIT,
        exposureMinor: DOZEN,
        exposureAfterMinor: 2 * DOZEN,
        shortfallMinor: 2 * DOZEN - LIMIT,
      },
      after: { dealerPartyId: f.dealerId, orderTotalMinor: DOZEN },
      ip: '203.0.113.7',
      userAgent: 'ZZTEST browser',
      requestId: 'zztest-req-1',
    });
    expect((await exposure()).openOrdersMinor).toBe(2 * DOZEN);
  });

  it('a manager confirming past the limit is asked for a reason, then audited at CONFIRM', async () => {
    const d = await draft(manager);
    const ask = await refusal(confirmOrder(manager, oid(d.id), {}));
    expect([ask.status, ask.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
    expect(ask.details).toMatchObject({
      canOverride: true,
      exposureMinor: 2 * DOZEN,
      exposureAfterMinor: 3 * DOZEN,
      shortfallMinor: 3 * DOZEN - LIMIT,
    });

    const o = await confirmOrder(manager, oid(d.id), {
      creditOverrideReason: 'ZZTEST festival stock',
    });
    expect(o.creditCheck?.status).toBe('OVERRIDDEN');
    const entry = (await AuditLog.findOne({ orgId: f.orgId, entityId: oid(o.id) }).lean())!;
    expect(entry.before).toMatchObject({ stage: 'CONFIRM', shortfallMinor: 3 * DOZEN - LIMIT });
  });

  it('an override that does not happen is not audited: refused for stock, nothing is written', async () => {
    const before = await overrides();
    const big = await createOrder(manager, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 5 }], // 60 PCS; 36 are reserved
    });
    const err = await refusal(
      confirmOrder(manager, oid(big.id), { creditOverrideReason: 'ZZTEST big one' }),
    );
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(await overrides()).toBe(before);
    expect((await WholesaleOrder.findById(big.id).lean())!.status).toBe('DRAFT');
  });
});

describe('money on account, and money not yet ours', () => {
  it('an advance comes off exposure; a cheque in hand does not', async () => {
    const before = await exposure();
    await postReceipt(manager, { partyId: f.dealerId, amountMinor: 50_000, method: 'CASH' });
    expect(await exposure()).toMatchObject({
      unallocatedMinor: 50_000,
      exposureMinor: before.exposureMinor - 50_000,
    });

    await receiveCheque(manager, {
      partyId: f.dealerId,
      amountMinor: 1_000_000,
      chequeNo: 'ZZ0031',
      bankName: 'Dutch-Bangla Bank',
      chequeDate: today(),
    });
    expect((await exposure()).exposureMinor).toBe(before.exposureMinor - 50_000);
  });

  it('the counter cannot sell round the limit while confirmed orders wait in the warehouse', async () => {
    // Balance is −৳500 (the advance); three orders worth ৳2,160 wait. A ৳60 credit sale is refused.
    const err = await refusal(
      postPosSale(manager, {
        clientRef: randomUUID(),
        paymentMode: 'CREDIT',
        partyId: f.dealerId,
        lines: [{ productId: f.frameId, uomCode: 'PCS', qty: 1 }],
        tenders: [],
      }),
    );
    expect([err.status, err.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
  });
});

describe('dispatch re-checks credit as the goods leave', () => {
  it('order A was within the limit when confirmed; the limit was not moved, but exposure has — so it stops', async () => {
    const before = await exposure();
    const dispatchId = await packed(orderA);
    const err = await refusal(postDispatch(storekeeper, oid(dispatchId)));
    expect([err.status, err.code]).toEqual([409, 'CREDIT_LIMIT_EXCEEDED']);
    expect(err.details).toMatchObject({
      reason: 'OVER_LIMIT',
      canOverride: false,
      exposureMinor: before.exposureMinor,
      limitMinor: LIMIT,
      shortfallMinor: before.exposureMinor - LIMIT,
    });
    expect((await Dispatch.findById(dispatchId).lean())!.status).toBe('PACKED');
    expect(await Invoice.countDocuments({ orgId: f.orgId, orderId: oid(orderA) })).toBe(0);

    // A manager posts it with a reason: recorded on the order, and audited at DISPATCH.
    const r = await postDispatch(
      manager,
      oid(dispatchId),
      {},
      {
        creditOverrideReason: 'ZZTEST cheque promised Friday',
      },
    );
    expect(r.dispatch.status).toBe('DISPATCHED');
    const a = (await WholesaleOrder.findById(orderA).lean())!;
    expect(a.creditCheck).toMatchObject({
      status: 'OVERRIDDEN',
      overrideReason: 'ZZTEST cheque promised Friday',
    });
    const entry = (await AuditLog.findOne({
      orgId: f.orgId,
      entityId: oid(orderA),
    }).lean())!;
    expect(entry.before).toMatchObject({
      stage: 'DISPATCH',
      exposureMinor: before.exposureMinor,
    });

    // Invoicing moved the value from "open orders" to "open invoices"; exposure did not change.
    const after = await exposure();
    expect(after.exposureMinor).toBe(before.exposureMinor);
    expect(after.openOrdersMinor).toBe(before.openOrdersMinor - DOZEN);
  });

  it('an order a manager already lent past the limit is not stopped again', async () => {
    const n = await overrides();
    const r = await postDispatch(storekeeper, oid(await packed(orderB)));
    expect(r.dispatch.status).toBe('DISPATCHED');
    expect(await overrides()).toBe(n);
  });

  it('but a hold stops the goods for anyone, overridden or not', async () => {
    const c = (await WholesaleOrder.findOne({
      orgId: f.orgId,
      status: 'CONFIRMED',
    }).lean())!;
    const dispatchId = await packed(String(c._id));
    await Party.updateOne(
      { _id: oid(f.dealerId) },
      {
        $set: { 'dealer.creditHold': true, 'dealer.creditHoldReason': 'ZZTEST cheque bounced' },
      },
    );
    const err = await refusal(
      postDispatch(manager, oid(dispatchId), {}, { creditOverrideReason: 'ZZTEST let it go' }),
    );
    expect(err.message).toMatch(/on credit hold: ZZTEST cheque bounced/);
    expect(err.details).toMatchObject({ reason: 'ON_HOLD', canOverride: false });
    await Party.updateOne({ _id: oid(f.dealerId) }, { $set: { 'dealer.creditHold': false } });
  });
});

describe('the overrides dashboard, and the log itself', () => {
  it('lists every override with who, why and how far, by approver and by dealer now', async () => {
    const d = await creditOverrides(manager, {});
    expect(d.count).toBe(3);
    expect(d.rows.map((r) => r.stage).sort()).toEqual(['APPROVE', 'CONFIRM', 'DISPATCH']);
    expect(d.rows.every((r) => r.dealerName === 'ZZTEST Rahman Optics' && r.reason)).toBe(true);
    expect(d.shortfallMinor).toBe(d.rows.reduce((t, r) => t + r.shortfallMinor, 0));
    expect(d.byApprover).toEqual([
      {
        userId: String(f.userId),
        name: 'ZZTEST Cashier',
        count: 3,
        shortfallMinor: d.shortfallMinor,
      },
    ]);
    const now = await exposure();
    expect(d.dealers).toEqual([
      expect.objectContaining({
        partyId: f.dealerId,
        overrides: 3,
        limitMinor: LIMIT,
        exposureNowMinor: now.exposureMinor,
        overNowMinor: Math.max(0, now.exposureMinor - LIMIT),
      }),
    ]);
    expect(d.rows.find((r) => r.orderId === orderB)?.orderStatus).toBe('DISPATCHED');

    // A period before any of it: empty.
    const old = await creditOverrides(manager, { from: '2026-01-01', to: '2026-01-31' });
    expect(old).toMatchObject({ count: 0, rows: [], dealers: [] });
  });

  it('the raw log pages newest first, filters by entity', async () => {
    const page = await listAudit(manager, {
      page: 1,
      limit: 2,
      order: 'asc',
      entity: 'WholesaleOrder',
    });
    expect(page.meta.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.at >= page.items[1]!.at).toBe(true);
    const byOrder = await listAudit(manager, {
      page: 1,
      limit: 20,
      order: 'asc',
      entityId: orderA,
    });
    expect(byOrder.items.map((e) => e.before?.stage)).toEqual(['DISPATCH']);
  });

  it('is append-only: an entry cannot be edited or deleted through the model', async () => {
    await expect(
      AuditLog.updateOne({ orgId: f.orgId }, { $set: { reason: 'nothing to see' } }),
    ).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteMany({ orgId: f.orgId })).rejects.toThrow(/append-only/);
    expect(await overrides()).toBe(3);
  });
});
