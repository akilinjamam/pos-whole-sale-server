import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { partyStatement, reconcileLedger } from '../../src/modules/ledger/ledger.service.js';
import { collectionSheet } from '../../src/modules/payment/collection.service.js';
import { Party } from '../../src/modules/party/party.model.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import {
  allocateReceipt,
  allocationPreview,
  postReceipt,
} from '../../src/modules/payment/receipt.service.js';
import {
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { ReceiptInput } from '../../src/shared/payments.js';

/**
 * Day 28's "done when", against a real replica set in a throwaway org:
 *   - a receipt larger than the oldest invoice splits correctly across invoices;
 *   - an over-allocation is rejected — and leaves nothing behind;
 *   - an unallocated remainder is retained as an advance, and can be allocated later.
 *
 * Three real wholesale invoices, raised by posted challans, oldest first:
 *   WS1 ৳720 (12 frames) · WS2 ৳360 (6 frames) · WS3 ৳1,440 (24 frames)  — ৳2,520 owed.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;
let ws: { id: string; docNo: string }[] = [];

const oid = (id: string) => new Types.ObjectId(id);
const invoice = async (i: number) => (await Invoice.findById(ws[i]!.id).lean())!;
const balance = async () => (await Party.findById(f.dealerId).lean())!.currentBalanceMinor;
const receipt = (over: Partial<ReceiptInput>): ReceiptInput => ({
  partyId: f.dealerId,
  amountMinor: 1,
  method: 'CASH',
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

/** A confirmed order for `qty` frames, shipped in one challan — which raises its invoice. */
async function invoiced(qty: number) {
  const draft = await createOrder(actor, {
    dealerPartyId: f.dealerId,
    locationId: String(f.locationId),
    lines: [{ productId: f.frameId, qty }],
  });
  const order = await confirmOrder(actor, oid(draft.id), {});
  const d = await createDispatch(actor, { orderId: order.id });
  await packDispatch(actor, oid(d.id));
  const r = await postDispatch(actor, oid(d.id));
  return { id: r.invoice!.id, docNo: r.invoice!.docNo! };
}

beforeAll(async () => {
  await connectDatabase();
  await PaymentDoc.syncIndexes();
  f = await createPosFixture();
  actor = actorFor(f);
  ws = [await invoiced(12), await invoiced(6), await invoiced(24)];
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('the FIFO proposal', () => {
  it('previews oldest-due-first, as editable rows, without posting anything', async () => {
    const p = await allocationPreview(actor, { partyId: f.dealerId, amountMinor: 100_000 });
    expect(p.openInvoices.map((i) => [i.docNo, i.balanceMinor])).toEqual([
      [ws[0]!.docNo, 72_000],
      [ws[1]!.docNo, 36_000],
      [ws[2]!.docNo, 144_000],
    ]);
    expect(p.totalOpenMinor).toBe(252_000);
    expect(p.allocations).toEqual([
      { invoiceId: ws[0]!.id, docNo: ws[0]!.docNo, amountMinor: 72_000 },
      { invoiceId: ws[1]!.id, docNo: ws[1]!.docNo, amountMinor: 28_000 },
    ]);
    expect(p).toMatchObject({
      allocatedMinor: 100_000,
      unallocatedMinor: 0,
      existingAdvanceMinor: 0,
    });
    expect(await PaymentDoc.countDocuments({ orgId: f.orgId })).toBe(0);
  });
});

describe('the done-when', () => {
  it('a receipt larger than the oldest invoice splits across invoices', async () => {
    const owed = await balance();
    const r = await postReceipt(
      actor,
      receipt({ amountMinor: 100_000, method: 'BANK', reference: 'DBBL-77812' }),
    );

    expect(r.receipt).toMatchObject({
      docNo: expect.stringMatching(/^RCPT-/),
      amountMinor: 100_000,
      allocatedMinor: 100_000,
      unallocatedMinor: 0,
      reference: 'DBBL-77812',
    });
    expect(r.receipt.allocations.map((a) => [a.docNo, a.amountMinor])).toEqual([
      [ws[0]!.docNo, 72_000],
      [ws[1]!.docNo, 28_000],
    ]);
    // The oldest is paid off; the next is part-paid; the newest untouched.
    expect(await invoice(0)).toMatchObject({
      paidMinor: 72_000,
      balanceMinor: 0,
      paymentStatus: 'PAID',
    });
    expect(await invoice(1)).toMatchObject({
      paidMinor: 28_000,
      balanceMinor: 8_000,
      paymentStatus: 'PARTIAL',
    });
    expect(await invoice(2)).toMatchObject({
      paidMinor: 0,
      balanceMinor: 144_000,
      paymentStatus: 'UNPAID',
    });
    expect(r.invoices.map((i) => i.paymentStatus)).toEqual(['PAID', 'PARTIAL']);

    // One credit for the whole receipt; the dealer owes ৳1,000 less.
    const credit = await LedgerEntry.findOne({
      orgId: f.orgId,
      refId: oid(r.receipt.id),
    }).lean();
    expect(credit).toMatchObject({ docType: 'RECEIPT', creditMinor: 100_000, debitMinor: 0 });
    expect(await balance()).toBe(owed - 100_000);
  });

  it('an over-allocation is rejected — per invoice and in total — and changes nothing', async () => {
    const before = {
      payments: await PaymentDoc.countDocuments({ orgId: f.orgId }),
      ledger: await LedgerEntry.countDocuments({ orgId: f.orgId }),
      ws2: (await invoice(1)).balanceMinor,
      balance: await balance(),
    };

    // More than WS2 still owes (৳80).
    const perInvoice = await refusal(
      postReceipt(
        actor,
        receipt({
          amountMinor: 50_000,
          allocations: [{ invoiceId: ws[1]!.id, amountMinor: 9_000 }],
        }),
      ),
    );
    expect(perInvoice.status).toBe(422);
    expect(perInvoice.details).toEqual([
      {
        path: 'allocations.0.amountMinor',
        message: `${ws[1]!.docNo} only has 8000 left to pay`,
      },
    ]);

    // More in total than the receipt.
    const total = await refusal(
      postReceipt(
        actor,
        receipt({
          amountMinor: 10_000,
          allocations: [
            { invoiceId: ws[1]!.id, amountMinor: 8_000 },
            { invoiceId: ws[2]!.id, amountMinor: 5_000 },
          ],
        }),
      ),
    );
    expect(total.details).toEqual([
      { path: 'allocations', message: 'Allocated 13000, but the receipt is only 10000' },
    ]);

    // A paid-off invoice is not open.
    const paid = await refusal(
      postReceipt(
        actor,
        receipt({
          amountMinor: 100,
          allocations: [{ invoiceId: ws[0]!.id, amountMinor: 100 }],
        }),
      ),
    );
    expect((paid.details as { path: string }[])[0]!.path).toBe('allocations.0.invoiceId');

    expect({
      payments: await PaymentDoc.countDocuments({ orgId: f.orgId }),
      ledger: await LedgerEntry.countDocuments({ orgId: f.orgId }),
      ws2: (await invoice(1)).balanceMinor,
      balance: await balance(),
    }).toEqual(before);
  });

  it('an unallocated remainder is kept as an advance — then spent later, oldest first', async () => {
    // ৳600 received; the dealer says "pay ৳500 off WS3" — ৳100 stays on account.
    const r = await postReceipt(
      actor,
      receipt({
        amountMinor: 60_000,
        allocations: [{ invoiceId: ws[2]!.id, amountMinor: 50_000 }],
      }),
    );
    expect(r.receipt).toMatchObject({ allocatedMinor: 50_000, unallocatedMinor: 10_000 });
    expect((await invoice(2)).balanceMinor).toBe(94_000);
    // The ledger took the whole ৳600 at once.
    expect((await LedgerEntry.findOne({ refId: oid(r.receipt.id) }).lean())!.creditMinor).toBe(
      60_000,
    );

    const preview = await allocationPreview(actor, { partyId: f.dealerId, amountMinor: 1 });
    expect(preview.existingAdvanceMinor).toBe(10_000);

    // Later: spend the advance, oldest-due-first — WS2's ৳80, then ৳20 off WS3.
    const ledgerRows = await LedgerEntry.countDocuments({ orgId: f.orgId });
    const owed = await balance();
    const later = await allocateReceipt(actor, oid(r.receipt.id), {});
    expect(later.receipt).toMatchObject({ allocatedMinor: 60_000, unallocatedMinor: 0 });
    expect(later.receipt.allocations.map((a) => [a.docNo, a.amountMinor])).toEqual([
      [ws[2]!.docNo, 50_000],
      [ws[1]!.docNo, 8_000],
      [ws[2]!.docNo, 2_000],
    ]);
    expect(await invoice(1)).toMatchObject({ balanceMinor: 0, paymentStatus: 'PAID' });
    expect((await invoice(2)).balanceMinor).toBe(92_000);
    // Allocating later moves no money: no ledger entry, no balance change.
    expect(await LedgerEntry.countDocuments({ orgId: f.orgId })).toBe(ledgerRows);
    expect(await balance()).toBe(owed);
    // And nothing is left to allocate.
    expect((await refusal(allocateReceipt(actor, oid(r.receipt.id), {}))).status).toBe(409);
  });

  it('more than everything open: the whole remainder is an advance', async () => {
    const r = await postReceipt(actor, receipt({ amountMinor: 100_000 }));
    // Only WS3's ৳920 was open.
    expect(r.receipt).toMatchObject({ allocatedMinor: 92_000, unallocatedMinor: 8_000 });
    expect((await invoice(2)).paymentStatus).toBe('PAID');
    // Now nothing is open: an empty explicit list, or any receipt, is wholly on account.
    const allAdvance = await postReceipt(
      actor,
      receipt({ amountMinor: 5_000, allocations: [] }),
    );
    expect(allAdvance.receipt).toMatchObject({ allocatedMinor: 0, unallocatedMinor: 5_000 });
  });
});

describe('integrity', () => {
  it('two receipts racing to pay the same invoice cannot overpay it', async () => {
    const extra = await invoiced(2); // ৳120
    const pay = (n: number) =>
      postReceipt(
        actor,
        receipt({ amountMinor: n, allocations: [{ invoiceId: extra.id, amountMinor: n }] }),
      );
    const results = await Promise.allSettled([pay(12_000), pay(12_000)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const inv = (await Invoice.findById(extra.id).lean())!;
    expect(inv).toMatchObject({ paidMinor: 12_000, balanceMinor: 0, paymentStatus: 'PAID' });
  });

  it('a bKash transaction id is used once', async () => {
    const mfs = { provider: 'BKASH' as const, trxId: 'ZZ9K2LMQ1' };
    await postReceipt(actor, receipt({ amountMinor: 1_000, method: 'MFS', mfs }));
    const err = await refusal(
      postReceipt(actor, receipt({ amountMinor: 1_000, method: 'MFS', mfs })),
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/BKASH transaction ZZ9K2LMQ1 is already on receipt RCPT-/);
  });

  it('everything ties: Σ allocated on receipts = Σ paid on invoices; the ledger reconciles', async () => {
    const [alloc] = await PaymentDoc.aggregate<{ a: number; u: number; t: number }>([
      { $match: { orgId: f.orgId, direction: 'IN' } },
      {
        $group: {
          _id: null,
          a: { $sum: '$allocatedMinor' },
          u: { $sum: '$unallocatedMinor' },
          t: { $sum: '$amountMinor' },
        },
      },
    ]);
    const [paid] = await Invoice.aggregate<{ p: number }>([
      { $match: { orgId: f.orgId } },
      { $group: { _id: null, p: { $sum: '$paidMinor' } } },
    ]);
    expect(alloc!.a).toBe(paid!.p);
    expect(alloc!.a + alloc!.u).toBe(alloc!.t);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});

describe('the statement (Day 29): running balance across a back-dated entry', () => {
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  const today = dayOf(new Date(Date.now() + 6 * 3_600_000)); // Dhaka's day, near enough for a range end

  /** Every line's running balance, recomputed here in posting order, independently of the window. */
  function recompute(s: Awaited<ReturnType<typeof partyStatement>>) {
    let run = s.openingBalanceMinor;
    return s.lines.map((l) => (run += l.debitMinor - l.creditMinor));
  }

  it('matches the ledger exactly — and still does after a back-dated receipt lands in the past', async () => {
    const before = await partyStatement(actor, {
      partyId: f.dealerId,
      from: '2026-01-01',
      to: today,
    });
    expect(before.lines.map((l) => l.runningMinor)).toEqual(recompute(before));
    expect(before.closingBalanceMinor).toBe(await balance());
    expect(before.openingBalanceMinor).toBe(0);

    // Posted now, dated ten days ago: before every invoice in this org.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const late = await postReceipt(actor, {
      partyId: f.dealerId,
      amountMinor: 7_000,
      method: 'BANK',
      paidAt: tenDaysAgo.toISOString(),
      reference: 'ZZ back-dated deposit slip',
      allocations: [],
    });

    const after = await partyStatement(actor, {
      partyId: f.dealerId,
      from: '2026-01-01',
      to: today,
    });
    // It takes its place by date — first — not at the end where it was posted.
    expect(after.lines[0]).toMatchObject({
      refDocNo: late.receipt.docNo,
      creditMinor: 7_000,
      runningMinor: -7_000,
    });
    // Every later balance moved by exactly the back-dated amount.
    expect(after.lines.slice(1).map((l) => l.runningMinor)).toEqual(
      before.lines.map((l) => l.runningMinor - 7_000),
    );
    expect(after.lines.map((l) => l.runningMinor)).toEqual(recompute(after));
    expect(after.closingBalanceMinor).toBe(await balance());
    expect(after.closingBalanceMinor).toBe(after.currentBalanceMinor);
    expect(after.totals.creditMinor - before.totals.creditMinor).toBe(7_000);
  });

  it('a period starting after the back-dated entry carries it in the balance brought forward', async () => {
    const all = await partyStatement(actor, {
      partyId: f.dealerId,
      from: '2026-01-01',
      to: today,
    });
    const yesterday = dayOf(new Date(Date.now() - 86_400_000));
    const recent = await partyStatement(actor, {
      partyId: f.dealerId,
      from: yesterday,
      to: today,
    });
    const earlier = all.lines.filter((l) => l.postedAt.slice(0, 10) < yesterday);
    expect(recent.openingBalanceMinor).toBe(
      earlier.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0),
    );
    expect(recent.closingBalanceMinor).toBe(all.closingBalanceMinor);
    expect(recent.lines.map((l) => l.runningMinor)).toEqual(recompute(recent));
  });

  it('a period ending before the invoices closes on what was owed then', async () => {
    const s = await partyStatement(actor, {
      partyId: f.dealerId,
      from: '2026-01-01',
      to: dayOf(new Date(Date.now() - 5 * 86_400_000)),
    });
    expect(s.lines.map((l) => l.creditMinor)).toEqual([7_000]);
    expect(s.closingBalanceMinor).toBe(-7_000);
  });

  it('the collection sheet lists what is open, and the advance held against it', async () => {
    await postReceipt(actor, receipt({ amountMinor: 1_000, allocations: [] })); // an advance
    const owed = await invoiced(3); // ৳180 open
    const sheet = await collectionSheet(actor, {});
    const row = sheet.rows.find((r) => r.partyId === f.dealerId)!;
    const open = await Invoice.find({
      orgId: f.orgId,
      partyId: oid(f.dealerId),
      balanceMinor: { $gt: 0 },
    }).lean();
    expect(row.invoices.map((i) => i.docNo).sort()).toEqual(open.map((i) => i.docNo).sort());
    expect(row.invoices.some((i) => i.docNo === owed.docNo)).toBe(true);
    expect(row.totalDueMinor).toBe(open.reduce((t, i) => t + i.balanceMinor, 0));
    expect(row.advanceMinor).toBeGreaterThanOrEqual(1_000);
    expect(row.overdueMinor).toBe(0); // 30-day terms: nothing past due yet
    expect((await collectionSheet(actor, { overdueOnly: true })).rows).toEqual([]);
  });
});
