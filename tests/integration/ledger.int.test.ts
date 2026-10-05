import { randomUUID } from 'node:crypto';

import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import {
  importOpeningBalances,
  listLedgerEntries,
  reconcileLedger,
} from '../../src/modules/ledger/ledger.service.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import { postReceipt } from '../../src/modules/payment/receipt.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { openSession } from '../../src/modules/pos/posSession.service.js';
import {
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { postLedgerEntries } from '../../src/services/partyLedger.service.js';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';

/**
 * Day 27's "done when", against a real replica set in a throwaway org:
 *
 *   sum(debit − credit) === Party.currentBalanceMinor for every party after a mixed sequence —
 *   opening balances (both signs), a wholesale invoice raised by a challan, a counter credit sale
 *   with part-payment, and a burst of concurrent receipts against one dealer — and reconcile
 *   reports zero drift. Then a hand edit to a balance, which reconcile must catch.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;
let supplierId: string;
let dealerCode: string;
let supplierCode: string;

const oid = (id: string) => new Types.ObjectId(id);

/** The truth, summed here independently of the service under test. */
async function ledgerSums(): Promise<Map<string, number>> {
  const rows = await LedgerEntry.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { orgId: f.orgId } },
    {
      $group: { _id: '$partyId', n: { $sum: { $subtract: ['$debitMinor', '$creditMinor'] } } },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}
const balanceOf = async (id: string) => (await Party.findById(id).lean())!.currentBalanceMinor;

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  const supplier = await createParty(
    { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
    'SUPPLIER',
    { name: 'ZZTEST Lens Supplier' },
  );
  supplierId = supplier.id;
  supplierCode = supplier.code;
  dealerCode = (await Party.findById(f.dealerId).lean())!.code;
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('opening balances', () => {
  const file = () => [
    {
      line: 2,
      code: dealerCode,
      amountMinor: 1_000_000,
      dueDate: '2026-09-15',
      reference: 'Old INV 4412',
    },
    { line: 3, code: supplierCode, amountMinor: -250_000, reference: 'Bill 77' },
  ];

  it('the dry run reports each row and its side, and writes nothing', async () => {
    const r = await importOpeningBalances(actor, {
      asOf: '2026-09-01',
      dryRun: true,
      rows: [
        ...file(),
        { line: 4, code: 'ZZ-NOPE', amountMinor: 5 },
        { line: 5, code: dealerCode, amountMinor: 9 },
      ],
    });
    expect(r.rows.map((x) => [x.line, x.status, x.side])).toEqual([
      [2, 'POST', 'DEBIT'],
      [3, 'POST', 'CREDIT'],
      [4, 'ERROR', 'DEBIT'],
      [5, 'ERROR', 'DEBIT'],
    ]);
    expect(r.rows[2]!.errors).toEqual(['No party with code ZZ-NOPE']);
    // What each row will become, before anything is committed.
    expect(r.rows.slice(0, 2).map((x) => x.creates)).toEqual(['INVOICE', 'PAYABLE']);
    expect(r.rows[3]!.errors[0]).toMatch(/also on line 2/);
    expect(r.rows[0]).toMatchObject({ partyName: 'ZZTEST Rahman Optics', roles: ['DEALER'] });
    expect(r).toMatchObject({ posted: 0, failed: 2, netMinor: 750_000, refId: null });
    expect(await LedgerEntry.countDocuments({ orgId: f.orgId })).toBe(0);
  });

  it('a file with an error posts nothing at all', async () => {
    const r = await importOpeningBalances(actor, {
      asOf: '2026-09-01',
      dryRun: false,
      rows: [...file(), { line: 4, code: 'ZZ-NOPE', amountMinor: 5 }],
    });
    expect(r.posted).toBe(0);
    expect(await LedgerEntry.countDocuments({ orgId: f.orgId })).toBe(0);
    expect(await balanceOf(f.dealerId)).toBe(0);
  });

  it('commits: one OPENING entry per party, balances moved, opening recorded on the party', async () => {
    const r = await importOpeningBalances(actor, {
      asOf: '2026-09-01',
      dryRun: false,
      rows: file(),
    });
    expect(r).toMatchObject({ posted: 2, failed: 0, refDocNo: 'OPEN-BAL-2026-09-01' });

    expect(await balanceOf(f.dealerId)).toBe(1_000_000);
    expect(await balanceOf(supplierId)).toBe(-250_000);
    const entries = await LedgerEntry.find({ orgId: f.orgId }).sort({ debitMinor: -1 }).lean();
    expect(entries.map((e) => [e.docType, e.debitMinor, e.creditMinor, e.narration])).toEqual([
      ['OPENING', 1_000_000, 0, 'Opening balance — Old INV 4412'],
      ['OPENING', 0, 250_000, 'Opening balance — Bill 77'],
    ]);
    // Dated the cutover day (midday, Dhaka), with the old invoices' due date for ageing.
    expect(entries[0]!.postedAt.toISOString()).toBe('2026-09-01T06:00:00.000Z');
    expect(entries[0]!.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-14');
    expect(entries[1]!.dueDate).toBeNull();
    expect((await Party.findById(f.dealerId).lean())!.openingBalanceMinor).toBe(1_000_000);

    // The receivable is an opening invoice: payable and ageable like any other. Its ledger entry
    // points at it; it does not post a second time.
    expect(r.rows[0]!.docNo).toMatch(/^OB-/);
    expect(r.rows[1]!.docNo).toBeUndefined();
    const ob = (await Invoice.findOne({ orgId: f.orgId, series: 'OB' }).lean())!;
    expect(ob).toMatchObject({
      docNo: r.rows[0]!.docNo,
      status: 'POSTED',
      grandTotalMinor: 1_000_000,
      balanceMinor: 1_000_000,
      paymentStatus: 'UNPAID',
      locationId: null,
      note: 'Opening balance — Old INV 4412',
    });
    expect(ob.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-14');
    expect(entries[0]).toMatchObject({ refType: 'INVOICE', refDocNo: ob.docNo });
    expect(entries[0]!.refId?.equals(ob._id)).toBe(true);
    expect(entries[1]).toMatchObject({
      refType: 'OPENING_BALANCE',
      refDocNo: 'OPEN-BAL-2026-09-01',
    });
  });

  it('a receipt pays the opening invoice off like any other — it is the oldest due', async () => {
    const r = await postReceipt(actor, {
      partyId: f.dealerId,
      amountMinor: 300_000,
      method: 'CASH',
    });
    const ob = (await Invoice.findOne({ orgId: f.orgId, series: 'OB' }).lean())!;
    expect(r.receipt.allocations.map((a) => [a.docNo, a.amountMinor])).toEqual([
      [ob.docNo, 300_000],
    ]);
    expect(ob).toMatchObject({
      paidMinor: 300_000,
      balanceMinor: 700_000,
      paymentStatus: 'PARTIAL',
    });
  });

  it('a dealer’s opening advance becomes a receipt on account, spendable later', async () => {
    const prepaid = await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'DEALER',
      { name: 'ZZTEST Prepaid Dealer' },
    );
    const r = await importOpeningBalances(actor, {
      asOf: '2026-09-01',
      dryRun: false,
      rows: [
        { line: 1, code: prepaid.code, amountMinor: -40_000, reference: 'Advance 2026-08' },
      ],
    });
    expect(r.rows[0]).toMatchObject({
      creates: 'ADVANCE',
      docNo: expect.stringMatching(/^RCPT-/),
    });
    const pay = (await PaymentDoc.findOne({
      orgId: f.orgId,
      partyId: oid(prepaid.id),
    }).lean())!;
    expect(pay).toMatchObject({
      method: 'ADJUSTMENT',
      amountMinor: 40_000,
      allocatedMinor: 0,
      unallocatedMinor: 40_000,
      narration: 'Opening advance — Advance 2026-08',
    });
    // One ledger entry for it — the OPENING credit — not a second RECEIPT on top.
    const entries = await LedgerEntry.find({ orgId: f.orgId, partyId: oid(prepaid.id) }).lean();
    expect(entries.map((e) => [e.docType, e.creditMinor, e.refType])).toEqual([
      ['OPENING', 40_000, 'PAYMENT'],
    ]);
    expect(await balanceOf(prepaid.id)).toBe(-40_000);
  });

  it('a party gets one opening balance — a second is refused', async () => {
    const r = await importOpeningBalances(actor, {
      dryRun: true,
      rows: [{ line: 1, code: dealerCode, amountMinor: 1 }],
    });
    expect(r.rows[0]!.errors[0]).toMatch(/already has an opening balance/);
  });
});

describe('the done-when: a mixed sequence, then reconcile', () => {
  it('Σ(debit − credit) === currentBalanceMinor for every party, and reconcile is clean', async () => {
    // A wholesale invoice raised by a challan.
    const draft = await createOrder(actor, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
    });
    const order = await confirmOrder(actor, oid(draft.id), {});
    const d = await createDispatch(actor, { orderId: order.id });
    await packDispatch(actor, oid(d.id));
    const posted = await postDispatch(actor, oid(d.id));
    expect(posted.invoice!.grandTotalMinor).toBe(72_000);

    // A counter credit sale, part-paid: an invoice debit and a receipt credit.
    await openSession(actor, {
      locationId: String(f.locationId),
      terminalCode: 'T1',
      openingFloatMinor: 0,
    });
    await postPosSale(actor, {
      clientRef: randomUUID(),
      paymentMode: 'CREDIT',
      partyId: f.dealerId,
      lines: [{ productId: f.frameId, qty: 2 }],
      tenders: [{ method: 'CASH', amountMinor: 5_000 }],
    });

    // Twelve receipts against the dealer at once, each in its own transaction. The cache is a
    // `$inc` inside each — if any were lost to a race, the sums below would disagree.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withTransaction((session) =>
          postLedgerEntries(session, {
            orgId: f.orgId,
            postedAt: new Date(),
            actorId: f.userId,
            entries: [
              {
                partyId: oid(f.dealerId),
                docType: 'RECEIPT',
                refType: 'ZZTEST',
                refId: null,
                refDocNo: `ZZ-RCPT-${i + 1}`,
                creditMinor: 1_000 + i,
              },
            ],
          }),
        ),
      ),
    );
    // And a supplier payment (we pay part of what we owe: a debit).
    await withTransaction((session) =>
      postLedgerEntries(session, {
        orgId: f.orgId,
        postedAt: new Date(),
        actorId: f.userId,
        entries: [
          {
            partyId: oid(supplierId),
            docType: 'PAYMENT',
            refType: 'ZZTEST',
            refId: null,
            refDocNo: 'ZZ-PAY-1',
            debitMinor: 100_000,
          },
        ],
      }),
    );

    // ── The check, party by party, against an independent sum ──
    const sums = await ledgerSums();
    const parties = await Party.find({ orgId: f.orgId }).lean();
    for (const p of parties) {
      expect(p.currentBalanceMinor, p.code).toBe(sums.get(String(p._id)) ?? 0);
    }
    const receipts = Array.from({ length: 12 }, (_, i) => 1_000 + i).reduce((s, n) => s + n, 0);
    expect(await balanceOf(f.dealerId)).toBe(
      1_000_000 - 300_000 + 72_000 + 12_000 - 5_000 - receipts,
    );
    expect(await balanceOf(supplierId)).toBe(-250_000 + 100_000);

    const r = await reconcileLedger(f.orgId);
    expect(r.clean).toBe(true);
    expect(r.drift).toEqual([]);
    expect(r.counts).toMatchObject({ parties: 3, partiesWithEntries: 3 });
    expect(r.counts.entries).toBe(await LedgerEntry.countDocuments({ orgId: f.orgId }));
  });

  it('reconcile catches a hand-edited balance — and only that one — without repairing it', async () => {
    const real = await balanceOf(f.dealerId);
    // A direct database edit, the only way drift can happen.
    await mongoose.connection
      .db!.collection('parties')
      .updateOne({ _id: oid(f.dealerId) }, { $inc: { currentBalanceMinor: 777 } });
    try {
      const r = await reconcileLedger(f.orgId);
      expect(r.clean).toBe(false);
      expect(r.drift).toEqual([
        {
          partyId: f.dealerId,
          code: dealerCode,
          name: 'ZZTEST Rahman Optics',
          expected: real,
          actual: real + 777,
          drift: 777,
        },
      ]);
      // Reported, not repaired.
      expect(await balanceOf(f.dealerId)).toBe(real + 777);
    } finally {
      await mongoose.connection
        .db!.collection('parties')
        .updateOne({ _id: oid(f.dealerId) }, { $inc: { currentBalanceMinor: -777 } });
    }
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});

describe('the ledger stays append-only', () => {
  it('refuses edits and deletes through the model', async () => {
    const e = (await LedgerEntry.findOne({ orgId: f.orgId }).lean())!;
    await expect(
      LedgerEntry.updateOne({ _id: e._id }, { $set: { debitMinor: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(LedgerEntry.deleteOne({ _id: e._id })).rejects.toThrow(/append-only/);
  });

  it('lists a party’s entries oldest first — the back-dated opening leads', async () => {
    const { items, meta } = await listLedgerEntries(actor, {
      partyId: f.dealerId,
      page: 1,
      limit: 100,
      order: 'asc',
    });
    expect(items[0]).toMatchObject({
      docType: 'OPENING',
      debitMinor: 1_000_000,
      partyCode: dealerCode,
    });
    expect(meta.total).toBe(items.length);
    // 12 concurrent receipts, the counter part-payment, and the ৳3,000 against the opening invoice.
    expect(items.map((i) => i.docType).filter((t) => t === 'RECEIPT')).toHaveLength(14);
  });

  it('a concurrent second load of the same openings is refused, not doubled', async () => {
    // Parties with no opening yet, loaded twice at once.
    const extra = await Promise.all(
      [1, 2].map((n) =>
        createParty(
          { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
          'DEALER',
          { name: `ZZTEST Twin Dealer ${n}` },
        ),
      ),
    );
    const rows = extra.map((p, i) => ({ line: i + 1, code: p.code, amountMinor: 10_000 }));
    const results = await Promise.allSettled([
      importOpeningBalances(actor, { dryRun: false, rows }),
      importOpeningBalances(actor, { dryRun: false, rows }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ApiError);
    for (const p of extra) expect(await balanceOf(p.id)).toBe(10_000);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});
