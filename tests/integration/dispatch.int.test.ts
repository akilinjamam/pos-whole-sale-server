import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { Dispatch } from '../../src/modules/dispatch/dispatch.model.js';
import {
  cancelDispatch,
  createDispatch,
  deliverDispatch,
  getDispatch,
  packDispatch,
  postDispatch,
  updateDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { getInvoice, listInvoices } from '../../src/modules/invoice/invoice.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Org } from '../../src/modules/org/org.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { SerialUnit } from '../../src/modules/serialUnit/serialUnit.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import { WholesaleOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import {
  cancelOrder,
  closeOrder,
  confirmOrder,
  createOrder,
  orderCounts,
  shortCloseOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { postMovements } from '../../src/services/stock.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { OrderLineInput } from '../../src/shared/orders.js';

/**
 * Day 24's "done when", against a real replica set:
 *   - partial dispatch works — stock, the order's counters, its status, the invoice and the
 *     dealer's ledger all move together, and the parts add up to the order;
 *   - the concurrency test — two simultaneous dispatches of the last units: exactly one wins.
 *
 * Posting consumes stock, so each scenario gets its own throwaway org: 60 frames (PCS, DOZ ×12,
 * ৳60 each) and two serialised machines (ZZSN-1, ZZSN-2) at ৳50,000.
 */

const oid = (id: string) => new Types.ObjectId(id);

async function world() {
  const f = await createPosFixture();
  const actor = actorFor(f);
  const shelf = async (productId: string) => {
    const b = await StockBalance.findOne({
      orgId: f.orgId,
      locationId: f.locationId,
      productId: oid(productId),
    }).lean();
    return { onHand: b?.qtyOnHand ?? 0, reserved: b?.qtyReserved ?? 0 };
  };
  const confirmed = async (lines: OrderLineInput[]) => {
    const draft = await createOrder(actor, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines,
    });
    return confirmOrder(actor, oid(draft.id), {});
  };
  const order = async (id: string) => (await WholesaleOrder.findById(id).lean())!;
  const balance = async () => (await Party.findById(f.dealerId).lean())!.currentBalanceMinor;
  return { f, actor, shelf, confirmed, order, balance };
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const orgs: Types.ObjectId[] = [];
let w: Awaited<ReturnType<typeof world>>;

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([
    Dispatch.syncIndexes(),
    Invoice.syncIndexes(),
    WholesaleOrder.syncIndexes(),
  ]);
}, 120_000);

afterAll(async () => {
  for (const orgId of orgs) await cleanupOrg(orgId);
  await disconnectDatabase();
});

const fresh = async () => {
  w = await world();
  orgs.push(w.f.orgId);
};

describe('partial dispatch: ship half, then the rest', () => {
  beforeAll(fresh, 120_000);

  it('works end to end, and the two invoices add up to the order exactly', async () => {
    const { f, actor, shelf, confirmed, order, balance } = w;
    const o = await confirmed([
      { productId: f.frameId, uomCode: 'DOZ', qty: 2 }, // 24 PCS, ৳1,440
      { productId: f.machineId, qty: 1 }, // ৳50,000
    ]);
    const frameLine = o.lines[0]!.id;
    const machineLine = o.lines[1]!.id;
    expect(await shelf(f.frameId)).toEqual({ onHand: 60, reserved: 24 });

    // ── First challan: one dozen frames only ──
    const d1 = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: frameLine, qtyBase: 12 }],
    });
    expect(d1).toMatchObject({ status: 'DRAFT', docNo: null, orderDocNo: o.docNo });
    expect((await order(o.id)).status).toBe('PICKING');

    await packDispatch(actor, oid(d1.id));
    expect((await order(o.id)).status).toBe('PACKED');

    const r1 = await postDispatch(actor, oid(d1.id));
    expect(r1.dispatch).toMatchObject({
      status: 'DISPATCHED',
      docNo: expect.stringMatching(/^CHL-/),
    });
    expect(r1.order).toMatchObject({
      status: 'PARTIALLY_DISPATCHED',
      fulfillmentStatus: 'PARTIAL',
      billingStatus: 'PARTIAL',
    });
    expect(r1.order.lines[0]).toMatchObject({
      qtyDispatchedBase: 12,
      qtyReservedBase: 12,
      qtyInvoicedBase: 12,
      qtyOutstandingBase: 12,
    });
    // Stock left the shelf, and took its reservation with it.
    expect(await shelf(f.frameId)).toEqual({ onHand: 48, reserved: 12 });
    const rows = await StockLedger.find({ orgId: f.orgId, refType: 'DISPATCH' }).lean();
    expect(rows.map((r) => [r.movementType, r.qtyBase, r.refDocNo])).toEqual([
      ['SALE', -12, r1.dispatch.docNo],
    ]);
    // One dozen at ৳720, invoiced in the order's unit, debited to the dealer.
    expect(r1.invoice).toMatchObject({
      docNo: expect.stringMatching(/^WS-/),
      grandTotalMinor: 72_000,
      balanceMinor: 72_000,
      paymentStatus: 'UNPAID',
    });
    expect(r1.invoice!.lines[0]).toMatchObject({ uomCode: 'DOZ', uomQty: 1, qtyBase: 12 });
    expect(await balance()).toBe(72_000);

    // ── Second challan: everything left — the default ──
    const d2 = await createDispatch(actor, { orderId: o.id });
    expect((await order(o.id)).status).toBe('PICKING');
    expect(d2.lines.map((l) => [l.orderLineId, l.qtyBase])).toEqual([
      [frameLine, 12],
      [machineLine, 1],
    ]);

    // The machine is serialised: packing without the serial is refused.
    const noSerial = await refusal(packDispatch(actor, oid(d2.id)));
    expect(noSerial.status).toBe(422);
    expect(noSerial.details).toEqual([expect.objectContaining({ path: 'lines.1.serials' })]);

    await updateDispatch(actor, oid(d2.id), {
      lines: [
        { orderLineId: frameLine, qtyBase: 12 },
        { orderLineId: machineLine, qtyBase: 1, serials: ['ZZSN-1'] },
      ],
      transport: { mode: 'COURIER', courierName: 'ZZTEST Sundarban', trackingNo: 'ZZ-1' },
    });
    await packDispatch(actor, oid(d2.id));
    const r2 = await postDispatch(actor, oid(d2.id));

    expect(r2.order).toMatchObject({
      status: 'DISPATCHED',
      fulfillmentStatus: 'COMPLETE',
      billingStatus: 'BILLED',
    });
    expect(
      r2.order.lines.every((l) => l.qtyReservedBase === 0 && l.qtyOutstandingBase === 0),
    ).toBe(true);
    expect(await shelf(f.frameId)).toEqual({ onHand: 36, reserved: 0 });
    expect(await shelf(f.machineId)).toEqual({ onHand: 1, reserved: 0 });
    const unit = await SerialUnit.findOne({ orgId: f.orgId, serialNo: 'ZZSN-1' }).lean();
    expect(unit?.status).toBe('SOLD');

    // The two invoices add up to the order, to the poisha; the ledger agrees.
    const invoices = await Invoice.find({ orgId: f.orgId, orderId: oid(o.id) }).lean();
    expect(invoices).toHaveLength(2);
    expect(invoices.reduce((s, i) => s + i.grandTotalMinor, 0)).toBe(o.grandTotalMinor);
    expect(await balance()).toBe(o.grandTotalMinor);
    const debits = await LedgerEntry.find({ orgId: f.orgId, docType: 'INVOICE' }).lean();
    expect(debits.reduce((s, e) => s + e.debitMinor, 0)).toBe(o.grandTotalMinor);

    expect(r2.order.statusHistory.map((h) => h.action)).toEqual([
      'create',
      'confirm',
      'startPicking',
      'pack',
      'dispatch',
      'startPicking',
      'pack',
      'dispatch',
    ]);
  });

  it('refuses a challan for more than is left to ship', async () => {
    const { f, actor, confirmed } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 5 }]);
    const err = await refusal(
      createDispatch(actor, {
        orderId: o.id,
        lines: [{ orderLineId: o.lines[0]!.id, qtyBase: 6 }],
      }),
    );
    expect(err.status).toBe(422);
    expect(err.details).toEqual([
      expect.objectContaining({
        path: 'lines.0.qtyBase',
        message: 'Line 1 has only 5 left to ship',
      }),
    ]);
    await cancelOrder(actor, oid(o.id), { reason: 'ZZTEST tidy' });
  });

  it('a posted challan cannot be cancelled; an order with a posted challan cannot be either', async () => {
    const { f, actor, confirmed } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 4 }]);
    const d = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: o.lines[0]!.id, qtyBase: 2 }],
    });
    await packDispatch(actor, oid(d.id));
    await postDispatch(actor, oid(d.id));
    expect((await refusal(cancelDispatch(actor, oid(d.id), { reason: 'ZZTEST' }))).status).toBe(
      409,
    );
    expect((await refusal(cancelOrder(actor, oid(o.id), { reason: 'ZZTEST' }))).code).toBe(
      'ILLEGAL_TRANSITION',
    );
  });
});

describe('cancelling an order takes its open challans with it', () => {
  beforeAll(fresh, 120_000);

  it('a packed challan of a cancelled order is cancelled, and cannot be posted', async () => {
    const { f, actor, shelf, confirmed } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 10 }]);
    const d = await createDispatch(actor, { orderId: o.id });
    await packDispatch(actor, oid(d.id));
    await cancelOrder(actor, oid(o.id), { reason: 'ZZTEST dealer withdrew' });

    const challan = (await Dispatch.findById(d.id).lean())!;
    expect(challan.status).toBe('CANCELLED');
    expect(challan.cancelReason).toBe('Order cancelled: ZZTEST dealer withdrew');
    expect((await refusal(postDispatch(actor, oid(d.id)))).status).toBe(409);
    expect(await shelf(f.frameId)).toEqual({ onHand: 60, reserved: 0 });
  });
});

describe('posting is atomic', () => {
  beforeAll(fresh, 120_000);

  it('a failure just before commit leaves no trace — challan, stock, order, invoice, ledger', async () => {
    const { f, actor, shelf, confirmed, order, balance } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 10 }]);
    const d = await createDispatch(actor, { orderId: o.id });
    await packDispatch(actor, oid(d.id));
    const before = {
      shelf: await shelf(f.frameId),
      order: (await order(o.id)).lines,
      balance: await balance(),
      invoices: await Invoice.countDocuments({ orgId: f.orgId }),
      ledger: await StockLedger.countDocuments({ orgId: f.orgId }),
    };

    const err = await postDispatch(actor, oid(d.id), {
      beforeCommit: () => {
        throw new Error('ZZTEST power cut');
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('ZZTEST power cut');

    expect((await Dispatch.findById(d.id).lean())!).toMatchObject({
      status: 'PACKED',
      docNo: null,
    });
    expect({
      shelf: await shelf(f.frameId),
      order: (await order(o.id)).lines,
      balance: await balance(),
      invoices: await Invoice.countDocuments({ orgId: f.orgId }),
      ledger: await StockLedger.countDocuments({ orgId: f.orgId }),
    }).toEqual(before);
    expect((await order(o.id)).status).toBe('PACKED');

    // And it posts cleanly afterwards.
    expect((await postDispatch(actor, oid(d.id))).order.status).toBe('DISPATCHED');
  });

  it('without invoiceOnDispatch, stock and the order move but nothing is billed', async () => {
    const { f, actor, confirmed, balance } = w;
    await Org.updateOne({ _id: f.orgId }, { $set: { 'settings.invoiceOnDispatch': false } });
    try {
      const before = await balance();
      const o = await confirmed([{ productId: f.frameId, qty: 3 }]);
      const d = await createDispatch(actor, { orderId: o.id });
      await packDispatch(actor, oid(d.id));
      const r = await postDispatch(actor, oid(d.id));
      expect(r.invoice).toBeNull();
      expect(r.dispatch.invoiceDocNo).toBeNull();
      expect(r.order).toMatchObject({ status: 'DISPATCHED', billingStatus: 'UNBILLED' });
      expect(await balance()).toBe(before);
    } finally {
      await Org.updateOne({ _id: f.orgId }, { $set: { 'settings.invoiceOnDispatch': true } });
    }
  });
});

describe('concurrency: two dispatches, one set of units — exactly one wins', () => {
  beforeAll(fresh, 120_000);

  async function race(a: string, b: string) {
    const results = await Promise.allSettled([
      postDispatch(w.actor, oid(a)),
      postDispatch(w.actor, oid(b)),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    return { won, lost };
  }

  it('two challans for the same order line: one ships, the other is refused', async () => {
    const { f, actor, shelf, confirmed, balance } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 20 }]);
    const line = o.lines[0]!.id;
    // Two pickers each pick the whole line — both are within what is left *at pick time*.
    const a = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: line, qtyBase: 20 }],
    });
    const b = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: line, qtyBase: 20 }],
    });
    await packDispatch(actor, oid(a.id));
    await packDispatch(actor, oid(b.id));
    const before = { shelf: await shelf(f.frameId), balance: await balance() };

    const { won, lost } = await race(a.id, b.id);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ApiError);
    expect((lost[0]!.reason as ApiError).status).toBe(409);

    // Shipped once, invoiced once.
    expect(await shelf(f.frameId)).toEqual({
      onHand: before.shelf.onHand - 20,
      reserved: before.shelf.reserved - 20,
    });
    expect(await Invoice.countDocuments({ orgId: f.orgId, orderId: oid(o.id) })).toBe(1);
    expect(await balance()).toBe(before.balance + o.grandTotalMinor);
    const statuses = (await Dispatch.find({ _id: { $in: [oid(a.id), oid(b.id)] } }).lean())
      .map((d) => d.status)
      .sort();
    expect(statuses).toEqual(['DISPATCHED', 'PACKED']);
    // Tidy the loser.
    const loser =
      statuses[1] === 'PACKED'
        ? (await Dispatch.findOne({
            _id: { $in: [oid(a.id), oid(b.id)] },
            status: 'PACKED',
          }).lean())!
        : null;
    if (loser) await cancelDispatch(actor, loser._id, { reason: 'ZZTEST lost the race' });
  });

  it('two orders racing for the last units on the shelf: one ships, the other gets INSUFFICIENT_STOCK', async () => {
    const { f, actor, shelf, confirmed } = w;
    const { onHand } = await shelf(f.frameId); // 40 after the test above
    const half = onHand / 2;
    const A = await confirmed([{ productId: f.frameId, qty: half }]);
    const B = await confirmed([{ productId: f.frameId, qty: half }]);
    expect(await shelf(f.frameId)).toEqual({ onHand, reserved: onHand });

    // Half the shelf is found broken. A write-off records what physically happened, so it is not
    // blocked by reservations — and now two orders are promised `onHand` units with `half` left.
    await withTransaction((session) =>
      postMovements(session, {
        orgId: f.orgId,
        postedAt: new Date(),
        actorId: f.userId,
        movements: [
          {
            locationId: f.locationId,
            productId: oid(f.frameId),
            variantId: null,
            qtyBase: -half,
            movementType: 'ADJUSTMENT',
            refType: 'ZZTEST',
          },
        ],
      }),
    );
    expect(await shelf(f.frameId)).toEqual({ onHand: half, reserved: onHand });

    const a = await createDispatch(actor, { orderId: A.id });
    const b = await createDispatch(actor, { orderId: B.id });
    await packDispatch(actor, oid(a.id));
    await packDispatch(actor, oid(b.id));

    const { won, lost } = await race(a.id, b.id);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as ApiError).code).toBe('INSUFFICIENT_STOCK');
    expect(await shelf(f.frameId)).toEqual({ onHand: 0, reserved: half });
    const sold = await StockLedger.countDocuments({
      orgId: f.orgId,
      refType: 'DISPATCH',
      refId: { $in: [oid(a.id), oid(b.id)] },
    });
    expect(sold).toBe(1);
  });
});

describe('delivery (Day 25): proof of delivery, and the order follows its last challan', () => {
  beforeAll(fresh, 120_000);

  const sig =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('partial: the order waits for its last challan; then both delivered → order DELIVERED', async () => {
    const { f, actor, confirmed, order } = w;
    const o = await confirmed([{ productId: f.frameId, uomCode: 'DOZ', qty: 2 }]);
    const line = o.lines[0]!.id;

    const first = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: line, qtyBase: 18 }],
      transport: {
        mode: 'OWN',
        vehicleNo: 'DHAKA-METRO-GA-11',
        freightMinor: 30_000,
        freightPaidBy: 'DEALER',
      },
    });
    // Delivering before it has left is refused.
    expect(
      (await refusal(deliverDispatch(actor, oid(first.id), { receivedByName: 'ZZ Rafiq' })))
        .status,
    ).toBe(409);
    await packDispatch(actor, oid(first.id));
    const posted = await postDispatch(actor, oid(first.id));

    // 18 PCS of a dozen-priced line: invoiced in pieces, with dealer-paid freight on top.
    const inv = await getInvoice(actor, oid(posted.invoice!.id));
    expect(inv).toMatchObject({
      channel: 'WHOLESALE',
      dispatchId: first.id,
      orderId: o.id,
      shippingMinor: 30_000,
      paymentTermsDays: 30,
    });
    expect(inv.lines[0]).toMatchObject({
      uomCode: 'PCS',
      uomQty: 18,
      unitPriceMinor: 6_000,
      lineTotalMinor: 108_000,
    });
    expect(inv.grandTotalMinor).toBe(108_000 + 30_000);

    // A delivery time before the challan left is refused; then delivered, with a signature.
    const tooEarly = await refusal(
      deliverDispatch(actor, oid(first.id), {
        receivedByName: 'ZZ Rafiq',
        deliveredAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    expect(tooEarly.status).toBe(422);
    const d1 = await deliverDispatch(actor, oid(first.id), {
      receivedByName: 'ZZ Rafiq',
      receivedPhone: '01700000000',
      signatureDataUrl: sig,
    });
    expect(d1).toMatchObject({
      status: 'DELIVERED',
      receivedByName: 'ZZ Rafiq',
      receivedSignatureUrl: sig,
    });
    expect((await order(o.id)).status).toBe('PARTIALLY_DISPATCHED');
    expect(
      (await refusal(deliverDispatch(actor, oid(first.id), { receivedByName: 'ZZ Rafiq' })))
        .status,
    ).toBe(409);

    // The rest.
    const rest = await createDispatch(actor, { orderId: o.id });
    await packDispatch(actor, oid(rest.id));
    await postDispatch(actor, oid(rest.id));
    expect((await order(o.id)).status).toBe('DISPATCHED');
    await deliverDispatch(actor, oid(rest.id), { receivedByName: 'ZZ Rafiq' });
    const done = await order(o.id);
    expect(done.status).toBe('DELIVERED');
    expect(done.statusHistory.at(-1)).toMatchObject({
      from: 'DISPATCHED',
      to: 'DELIVERED',
      action: 'deliver',
    });

    // Both invoices, found by order; together they are the order plus the freight.
    const { items } = await listInvoices(actor, {
      orderId: o.id,
      page: 1,
      limit: 25,
      order: 'asc',
    });
    expect(items).toHaveLength(2);
    expect(items.reduce((s, i) => s + i.grandTotalMinor, 0)).toBe(o.grandTotalMinor + 30_000);
    // The signature travels with one challan, never in a list.
    expect((await getDispatch(actor, oid(first.id))).receivedSignatureUrl).toBe(sig);
  });
});

describe('short close (Day 26): ship what we have, forget the rest', () => {
  beforeAll(fresh, 120_000);

  it('releases the remaining reservations exactly and sets qtyCancelledBase to what was left', async () => {
    const { f, actor, shelf, confirmed, order, balance } = w;
    const o = await confirmed([
      { productId: f.frameId, uomCode: 'DOZ', qty: 2 }, // 24
      { productId: f.machineId, qty: 1 },
    ]);
    const [frameLine, machineLine] = [o.lines[0]!.id, o.lines[1]!.id];

    // Half the frames ship; the rest are picked and packed on a second challan, then abandoned.
    const first = await createDispatch(actor, {
      orderId: o.id,
      lines: [{ orderLineId: frameLine, qtyBase: 12 }],
    });
    await packDispatch(actor, oid(first.id));
    await postDispatch(actor, oid(first.id));
    const second = await createDispatch(actor, {
      orderId: o.id,
      lines: [
        { orderLineId: frameLine, qtyBase: 12 },
        { orderLineId: machineLine, qtyBase: 1, serials: ['ZZSN-2'] },
      ],
    });
    await packDispatch(actor, oid(second.id));
    expect(await shelf(f.frameId)).toEqual({ onHand: 48, reserved: 12 });
    expect(await shelf(f.machineId)).toEqual({ onHand: 2, reserved: 1 });
    const owed = await balance();
    const stockRows = await StockLedger.countDocuments({ orgId: f.orgId });

    // A reason is required.
    expect((await refusal(shortCloseOrder(actor, oid(o.id), { reason: ' ' }))).status).toBe(
      422,
    );
    expect((await order(o.id)).status).toBe('PACKED');

    const closed = await shortCloseOrder(actor, oid(o.id), {
      reason: 'ZZTEST dealer took what we had',
    });

    // ── The done-when ──
    expect(closed).toMatchObject({
      status: 'CLOSED',
      fulfillmentStatus: 'COMPLETE',
      billingStatus: 'BILLED',
    });
    expect(
      closed.lines.map((l) => [
        l.qtyBase,
        l.qtyDispatchedBase,
        l.qtyCancelledBase,
        l.qtyReservedBase,
        l.qtyOutstandingBase,
      ]),
    ).toEqual([
      [24, 12, 12, 0, 0],
      [1, 0, 1, 0, 0],
    ]);
    // Reservations released exactly; nothing physically moved; nobody billed again.
    expect(await shelf(f.frameId)).toEqual({ onHand: 48, reserved: 0 });
    expect(await shelf(f.machineId)).toEqual({ onHand: 2, reserved: 0 });
    expect(await StockLedger.countDocuments({ orgId: f.orgId })).toBe(stockRows);
    expect(await balance()).toBe(owed);

    // The packed challan went with the remainder; the posted one stands.
    const challans = await Dispatch.find({ orderId: oid(o.id) })
      .sort({ createdAt: 1 })
      .lean();
    expect(challans.map((c) => c.status)).toEqual(['DISPATCHED', 'CANCELLED']);
    expect(challans[1]!.cancelReason).toBe(
      'Order short-closed: ZZTEST dealer took what we had',
    );
    expect(closed.statusHistory.at(-1)).toMatchObject({
      from: 'PACKED',
      to: 'CLOSED',
      action: 'shortClose',
      reason: 'ZZTEST dealer took what we had',
    });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.availableActions).toEqual([]);
  });

  it('is refused when nothing has shipped — that is a cancel — and leaves the reservation intact', async () => {
    const { f, actor, shelf, confirmed, order } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 5 }]);
    const d = await createDispatch(actor, { orderId: o.id });
    await packDispatch(actor, oid(d.id));
    const before = await shelf(f.frameId);

    const err = await refusal(shortCloseOrder(actor, oid(o.id), { reason: 'ZZTEST' }));
    expect([err.status, err.code]).toEqual([409, 'ILLEGAL_TRANSITION']);
    expect(await shelf(f.frameId)).toEqual(before);
    expect((await order(o.id)).lines[0]).toMatchObject({
      qtyReservedBase: 5,
      qtyCancelledBase: 0,
    });
    expect((await Dispatch.findById(d.id).lean())!.status).toBe('PACKED');
    await cancelOrder(actor, oid(o.id), { reason: 'ZZTEST tidy' });
  });

  it('a delivered order is closed; the board counts by status', async () => {
    const { f, actor, confirmed } = w;
    const o = await confirmed([{ productId: f.frameId, qty: 2 }]);
    const d = await createDispatch(actor, { orderId: o.id });
    await packDispatch(actor, oid(d.id));
    await postDispatch(actor, oid(d.id));
    // Not delivered yet: DISPATCHED → CLOSED is not an edge.
    expect((await refusal(closeOrder(actor, oid(o.id)))).status).toBe(409);
    await deliverDispatch(actor, oid(d.id), { receivedByName: 'ZZ Rafiq' });
    expect((await closeOrder(actor, oid(o.id))).status).toBe('CLOSED');

    const counts = await orderCounts(actor, {});
    expect(counts.byStatus).toMatchObject({ CLOSED: 2, CANCELLED: 1, DRAFT: 0 });
    expect(counts.total).toBe(3);
  });
});
