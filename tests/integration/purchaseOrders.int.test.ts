import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { PurchaseOrder } from '../../src/modules/supplierPo/purchaseOrder.model.js';
import {
  approvePo,
  cancelPo,
  createPo,
  getPo,
  listPos,
  recordPoReceipt,
  reopenPo,
  sendPo,
  shortClosePo,
  updatePo,
} from '../../src/modules/supplierPo/supplierPo.service.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { PoReceiptLine } from '../../src/modules/supplierPo/supplierPo.service.js';
import type { CreatePoInput } from '../../src/shared/purchasing.js';
import type { Permission } from '../../src/shared/permissions.js';
import type { PurchaseOrderPayload } from '../../src/shared/types.js';

/**
 * Day 32's "done when", against a real replica set in a throwaway org:
 *   - a PO can be raised and approved;
 *   - its status follows receipts — part received, received, short-closed — and a receipt that
 *     fails leaves the PO exactly as it was.
 * Goods receipts themselves arrive Day 33; here their hook, `recordPoReceipt`, is called directly
 * inside a transaction, as the GRN posting will call it.
 *
 * Frames cost ৳40 a piece on average (৳480 a dozen); the supplier quotes 10 days' lead, 45 days' terms.
 */

let f: PosFixture;
let manager: RequestActor;
let buyer: RequestActor;
let storekeeper: RequestActor;
let supplierId: string;

const BUYER: Permission[] = [
  'po:read',
  'po:create',
  'po:update',
  'po:cancel',
  'stock:viewCost',
];
const STORE: Permission[] = [
  'po:read',
  ...PERMISSIONS.PURCHASE.filter((p) => p.startsWith('grn')),
];
const oid = (id: string) => new Types.ObjectId(id);

const po = (over: Partial<CreatePoInput> = {}): CreatePoInput => ({
  supplierPartyId: supplierId,
  locationId: String(f.locationId),
  orderDate: '2026-10-01',
  lines: [
    { productId: f.frameId, uomCode: 'DOZ', qty: 2 }, // 24 PCS at the average cost
    { productId: f.machineId, qty: 2, unitCostMinor: 4_000_000, discountPct: 5 },
  ],
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

const receive = (id: string, lines: PoReceiptLine[], actor = storekeeper) =>
  withTransaction((session) => recordPoReceipt(session, actor, oid(id), lines));
const line = (p: PurchaseOrderPayload, i: number, qtyBase: number): PoReceiptLine => ({
  poLineId: oid(p.lines[i]!.id),
  productId: oid(p.lines[i]!.productId),
  qtyBase,
});
const approvedAndSent = async (over: Partial<CreatePoInput> = {}) => {
  const d = await createPo(buyer, po(over));
  await approvePo(manager, oid(d.id));
  return sendPo(buyer, oid(d.id));
};

beforeAll(async () => {
  await connectDatabase();
  await PurchaseOrder.syncIndexes();
  f = await createPosFixture();
  manager = actorFor(f);
  buyer = actorFor(f, BUYER);
  storekeeper = actorFor(f, STORE);
  await Product.updateOne({ _id: oid(f.frameId) }, { $set: { avgCostMinor: 4_000 } });
  supplierId = (
    await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'SUPPLIER',
      {
        name: 'ZZTEST Lens House',
        supplier: { paymentTermsDays: 45, leadTimeDays: 10 },
      },
    )
  ).id;
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('raising a PO', () => {
  it('a draft: numberless, costs defaulted and totals worked out by the server', async () => {
    const d = await createPo(buyer, po());
    expect(d).toMatchObject({
      status: 'DRAFT',
      docNo: null,
      supplierName: 'ZZTEST Lens House',
      // The supplier's terms and lead time.
      paymentTermsDays: 45,
      expectedDate: new Date('2026-10-11T00:00:00.000Z').toISOString(),
      costHidden: false,
    });
    expect(
      d.lines.map((l) => [l.uomCode, l.qtyBase, l.unitCostMinor, l.lineTotalMinor]),
    ).toEqual([
      ['DOZ', 24, 48_000, 96_000], // ৳40 a piece × 12, in the line's unit
      ['PCS', 2, 4_000_000, 7_600_000], // ৳40,000 × 2 less 5%
    ]);
    expect(d).toMatchObject({
      subtotalMinor: 8_096_000,
      discountMinor: 400_000,
      grandTotalMinor: 7_696_000,
    });
    expect(d.availableActions.map((a) => a.action)).toEqual(['cancel']); // the buyer cannot approve
  });

  it('a supplier must be a supplier, and active', async () => {
    const err = await refusal(createPo(buyer, po({ supplierPartyId: f.dealerId })));
    expect(err.details).toEqual([{ path: 'supplierPartyId', message: 'No such supplier' }]);
  });

  it('a draft is editable; lines keep their ids across edits', async () => {
    const d = await createPo(buyer, po());
    const e = await updatePo(buyer, oid(d.id), {
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 5, unitCostMinor: 45_000 }],
      shippingMinor: 50_000,
    });
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]).toMatchObject({
      id: d.lines[0]!.id,
      qtyBase: 60,
      lineTotalMinor: 225_000,
    });
    expect(e.grandTotalMinor).toBe(275_000);
  });
});

describe('THE DONE-WHEN, part 1: raised and approved', () => {
  let id: string;

  it('the buyer cannot approve their own PO; the manager can, and it takes its number', async () => {
    id = (await createPo(buyer, po())).id;
    const no = await refusal(approvePo(buyer, oid(id)));
    expect([no.status, no.message]).toEqual([
      403,
      'You need po:approve to approve this purchase order',
    ]);

    const a = await approvePo(manager, oid(id));
    expect(a).toMatchObject({
      status: 'APPROVED',
      docNo: expect.stringMatching(/^PO-/),
      approvedByUserId: String(f.userId),
      approvedAt: expect.any(String),
    });
    expect(a.statusHistory.map((h) => h.action)).toEqual(['create', 'approve']);
  });

  it('an approved PO cannot be edited — reopen it (with a reason), and it needs approving again', async () => {
    const edit = await refusal(updatePo(buyer, oid(id), { note: 'ZZTEST more' }));
    expect(edit.code).toBe('ILLEGAL_TRANSITION');

    const before = await getPo(manager, oid(id));
    const reopened = await reopenPo(buyer, oid(id), {
      reason: 'ZZTEST supplier raised the price',
    });
    expect(reopened).toMatchObject({
      status: 'DRAFT',
      docNo: before.docNo, // keeps its number
      approvedByUserId: null,
      approvedAt: null,
    });
    await updatePo(buyer, oid(id), {
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 2, unitCostMinor: 50_000 }],
    });
    const again = await approvePo(manager, oid(id));
    expect(again.docNo).toBe(before.docNo);
  });

  it('sent to the supplier', async () => {
    const s = await sendPo(buyer, oid(id));
    expect(s).toMatchObject({ status: 'SENT', sentAt: expect.any(String) });
    expect(s.availableActions.map((a) => a.action)).toEqual(['cancel']);
  });
});

describe('THE DONE-WHEN, part 2: status follows receipts', () => {
  let p: PurchaseOrderPayload;

  it('part of it arrives: PARTIALLY_RECEIVED, the line counters moved', async () => {
    p = await approvedAndSent();
    await receive(p.id, [line(p, 0, 12), line(p, 1, 1)]);
    const now = await getPo(manager, oid(p.id));
    expect(now.status).toBe('PARTIALLY_RECEIVED');
    expect(now.lines.map((l) => [l.qtyReceivedBase, l.qtyOutstandingBase])).toEqual([
      [12, 12],
      [1, 1],
    ]);
    expect(now.receivedRatio).toBeCloseTo(13 / 26);
    expect(now.statusHistory.at(-1)).toMatchObject({
      from: 'SENT',
      to: 'PARTIALLY_RECEIVED',
      action: 'receive',
    });
  });

  it('more than was ordered is refused, and nothing moves', async () => {
    const err = await refusal(receive(p.id, [line(p, 0, 13)]));
    expect(err.details).toEqual([
      {
        path: 'lines.0.qtyBase',
        message: `Line 1 of ${p.docNo} has 12 still to come — 13 is more than was ordered`,
      },
    ]);
    // Two GRN lines for the same PO line count together.
    await refusal(receive(p.id, [line(p, 0, 6), line(p, 0, 7)]));
    expect((await getPo(manager, oid(p.id))).lines[0]!.qtyReceivedBase).toBe(12);
  });

  it('a line from another PO, or for another item, is refused', async () => {
    const other = await approvedAndSent();
    const stranger = await refusal(receive(p.id, [line(other, 0, 1)]));
    expect(stranger.details).toEqual([
      { path: 'lines.0.poLineId', message: `Not a line of ${p.docNo}` },
    ]);
    const wrongItem = await refusal(
      receive(p.id, [{ ...line(p, 0, 1), productId: oid(f.machineId) }]),
    );
    expect(wrongItem.message).toBe('Validation failed');
    await cancelPo(manager, oid(other.id), { reason: 'ZZTEST tidy' });
  });

  it('a receipt whose transaction fails leaves the PO exactly as it was', async () => {
    const before = await PurchaseOrder.findById(p.id).lean();
    await expect(
      withTransaction(async (session) => {
        await recordPoReceipt(session, storekeeper, oid(p.id), [line(p, 0, 12), line(p, 1, 1)]);
        throw new Error('ZZTEST the stock posting failed');
      }),
    ).rejects.toThrow('ZZTEST the stock posting failed');
    const after = await PurchaseOrder.findById(p.id).lean();
    expect(after!.status).toBe('PARTIALLY_RECEIVED');
    expect(after!.lines).toEqual(before!.lines);
    expect(after!.statusHistory).toHaveLength(before!.statusHistory.length);
  });

  it('the rest arrives: RECEIVED and closed; nothing more can be received', async () => {
    await receive(p.id, [line(p, 0, 12), line(p, 1, 1)]);
    const done = await getPo(manager, oid(p.id));
    expect(done).toMatchObject({ status: 'RECEIVED', closedAt: expect.any(String) });
    expect(done.receivedRatio).toBe(1);
    expect(done.availableActions).toEqual([]);
    const err = await refusal(receive(p.id, [line(p, 0, 1)]));
    expect(err.message).toMatch(/is RECEIVED — nothing can be received against it/);
  });

  it('receiving takes grn:create — a buyer cannot mark goods as arrived', async () => {
    const q = await approvedAndSent();
    const err = await refusal(receive(q.id, [line(q, 0, 1)], buyer));
    expect(err.status).toBe(403);
    expect((await getPo(manager, oid(q.id))).lines[0]!.qtyReceivedBase).toBe(0);
    await cancelPo(manager, oid(q.id), { reason: 'ZZTEST tidy' });
  });

  it('two receipts racing for the last units: exactly one lands', async () => {
    const q = await approvedAndSent({ lines: [{ productId: f.frameId, qty: 10 }] });
    const results = await Promise.allSettled([
      receive(q.id, [line(q, 0, 10)]),
      receive(q.id, [line(q, 0, 10)]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const done = await getPo(manager, oid(q.id));
    expect([done.status, done.lines[0]!.qtyReceivedBase]).toEqual(['RECEIVED', 10]);
  });

  it('short close: the rest is not coming — outstanding moves to cancelled', async () => {
    const q = await approvedAndSent();
    await receive(q.id, [line(q, 0, 20)]);
    const cancel = await refusal(cancelPo(manager, oid(q.id), { reason: 'ZZTEST stop' }));
    expect(cancel.message).toBe('Goods have been received against it — short-close it instead');

    const closed = await shortClosePo(manager, oid(q.id), {
      reason: 'ZZTEST supplier out of stock on the rest',
    });
    expect(closed).toMatchObject({ status: 'SHORT_CLOSED', closedAt: expect.any(String) });
    expect(
      closed.lines.map((l) => [l.qtyReceivedBase, l.qtyCancelledBase, l.qtyOutstandingBase]),
    ).toEqual([
      [20, 4, 0],
      [0, 2, 0],
    ]);
    expect(closed.statusHistory.at(-1)?.reason).toBe(
      'ZZTEST supplier out of stock on the rest',
    );
  });
});

describe('cancelling, and the edges', () => {
  it('a draft cancels without a reason; a sent PO needs one', async () => {
    const d = await createPo(buyer, po());
    expect((await cancelPo(buyer, oid(d.id), {})).status).toBe('CANCELLED');
    const s = await approvedAndSent();
    const err = await refusal(cancelPo(buyer, oid(s.id), {}));
    expect([err.status, err.details]).toEqual([
      422,
      [{ path: 'reason', message: 'A reason is required to cancel this purchase order' }],
    ]);
    const c = await cancelPo(buyer, oid(s.id), { reason: 'ZZTEST found it cheaper' });
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'ZZTEST found it cheaper' });
  });

  it('nothing writes status but the state machine', async () => {
    const d = await createPo(buyer, po());
    await expect(
      PurchaseOrder.updateOne({ _id: oid(d.id) }, { $set: { status: 'RECEIVED' } }),
    ).rejects.toThrow(/only through transitionPo/);
    await expect(
      PurchaseOrder.create({
        orgId: f.orgId,
        supplierPartyId: oid(supplierId),
        locationId: f.locationId,
        orderDate: new Date(),
        status: 'SENT',
      }),
    ).rejects.toThrow(/creating a purchase order as SENT/);
  });

  it('a store keeper sees quantities, not what the company pays', async () => {
    const [any] = (await listPos(storekeeper, { page: 1, limit: 1, order: 'asc' })).items;
    expect(any).toMatchObject({ costHidden: true, grandTotalMinor: null });
    expect(any!.lines[0]).toMatchObject({ unitCostMinor: null, lineTotalMinor: null });
    expect(any!.lines[0]!.qtyBase).toBeGreaterThan(0);
  });

  it('the goods receipt picker lists only POs that can still be received against', async () => {
    const open = await listPos(manager, { page: 1, limit: 100, order: 'asc', open: true });
    expect(open.items.length).toBeGreaterThan(0);
    expect(
      open.items.every((p) => ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(p.status)),
    ).toBe(true);
  });
});
