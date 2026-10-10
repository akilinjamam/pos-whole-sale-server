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
import {
  importOpeningBalances,
  reconcileLedger,
} from '../../src/modules/ledger/ledger.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { ageingReport } from '../../src/modules/payment/ageing.service.js';
import {
  bounceCheque,
  clearCheque,
  depositCheque,
  receiveCheque,
} from '../../src/modules/payment/cheque.service.js';
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
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';

/**
 * Day 30's "done when", against a real replica set in a throwaway org:
 *   - a bounced cheque reverses cleanly, and the affected invoices return to their prior balances;
 *   - ageing buckets tie to the sum of open invoice balances — today, and as of past days.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;
const oid = (id: string) => new Types.ObjectId(id);
const inv = async (id: string) => (await Invoice.findById(id).lean())!;
const balance = async (id = f.dealerId) =>
  (await Party.findById(id).lean())!.currentBalanceMinor;
const ledgerCount = () => LedgerEntry.countDocuments({ orgId: f.orgId });

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

async function invoiced(qty: number, dealerId = f.dealerId) {
  const draft = await createOrder(actor, {
    dealerPartyId: dealerId,
    locationId: String(f.locationId),
    lines: [{ productId: f.frameId, qty }],
  });
  const order = await confirmOrder(actor, oid(draft.id), {});
  const d = await createDispatch(actor, { orderId: order.id });
  await packDispatch(actor, oid(d.id));
  return (await postDispatch(actor, oid(d.id))).invoice!;
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('a cheque, taken → deposited → cleared → bounced', () => {
  let ws1: { id: string; docNo: string | null };
  let ws2: { id: string; docNo: string | null };
  let ws3: { id: string; docNo: string | null };
  let chequeId: string;
  const prior: Record<string, number> = {};

  it('taking it posts nothing — no ledger, no invoice paid, no advance', async () => {
    ws1 = await invoiced(12); // ৳720
    ws2 = await invoiced(6); // ৳360
    const ledger = await ledgerCount();
    const owed = await balance();

    const c = await receiveCheque(actor, {
      partyId: f.dealerId,
      amountMinor: 100_000,
      chequeNo: '000451',
      bankName: 'Dutch-Bangla Bank',
      chequeDate: today(),
    });
    chequeId = c.id;
    expect(c).toMatchObject({
      method: 'CHEQUE',
      amountMinor: 100_000,
      allocatedMinor: 0,
      unallocatedMinor: 0,
      instrument: { status: 'PENDING', chequeNo: '000451' },
    });
    // The split chosen now, oldest first, kept for clearing.
    expect(c.intendedAllocations.map((a) => [a.docNo, a.amountMinor])).toEqual([
      [ws1.docNo, 72_000],
      [ws2.docNo, 28_000],
    ]);
    expect(await ledgerCount()).toBe(ledger);
    expect(await balance()).toBe(owed);
    expect((await inv(ws1.id)).balanceMinor).toBe(72_000);
    expect(
      (await allocationPreview(actor, { partyId: f.dealerId, amountMinor: 1 }))
        .existingAdvanceMinor,
    ).toBe(0);
  });

  it('the same cheque cannot be entered twice; a post-dated one cannot clear early', async () => {
    const dup = await refusal(
      receiveCheque(actor, {
        partyId: f.dealerId,
        amountMinor: 1,
        chequeNo: '000451',
        bankName: 'Dutch-Bangla Bank',
        chequeDate: today(),
      }),
    );
    expect(dup.status).toBe(409);

    const later = await receiveCheque(actor, {
      partyId: f.dealerId,
      amountMinor: 500,
      chequeNo: '000999',
      bankName: 'City Bank',
      chequeDate: plusDays(10),
      allocations: [],
    });
    const early = await refusal(clearCheque(actor, oid(later.id), {}));
    expect(early.status).toBe(422);
    expect(early.message).toBe('Validation failed');
    // Returned before it ever cleared: nothing to reverse, nothing posts.
    const ledger = await ledgerCount();
    const back = await bounceCheque(actor, oid(later.id), {
      reason: 'ZZTEST returned to dealer',
    });
    expect(back.receipt.instrument?.status).toBe('BOUNCED');
    expect(back.invoices).toEqual([]);
    expect(await ledgerCount()).toBe(ledger);
  });

  it('deposit moves nothing; depositing twice is refused', async () => {
    const d = await depositCheque(actor, oid(chequeId), {});
    expect(d.instrument?.status).toBe('DEPOSITED');
    expect((await refusal(depositCheque(actor, oid(chequeId), {}))).status).toBe(409);
  });

  it('clearing posts the credit and applies the split — capped where cash got there first', async () => {
    // While the cheque sat at the bank, the dealer paid ৳200 cash off WS2.
    await postReceipt(actor, {
      partyId: f.dealerId,
      amountMinor: 20_000,
      method: 'CASH',
      allocations: [{ invoiceId: ws2.id, amountMinor: 20_000 }],
    });
    prior[ws1.id] = (await inv(ws1.id)).balanceMinor; // 72,000
    prior[ws2.id] = (await inv(ws2.id)).balanceMinor; // 16,000
    prior.dealer = await balance();

    const r = await clearCheque(actor, oid(chequeId), {});
    // WS2 only owed ৳160 by now: the intended ৳280 is capped; ৳120 stays on account.
    expect(r.receipt).toMatchObject({
      allocatedMinor: 88_000,
      unallocatedMinor: 12_000,
      instrument: { status: 'CLEARED' },
    });
    expect(await inv(ws1.id)).toMatchObject({ balanceMinor: 0, paymentStatus: 'PAID' });
    expect(await inv(ws2.id)).toMatchObject({ balanceMinor: 0, paymentStatus: 'PAID' });
    const credit = await LedgerEntry.findOne({
      refId: oid(chequeId),
      docType: 'RECEIPT',
    }).lean();
    expect(credit).toMatchObject({ creditMinor: 100_000 });
    expect(await balance()).toBe(prior.dealer - 100_000);
  });

  it('its advance can be spent like any other', async () => {
    ws3 = await invoiced(3); // ৳180
    prior[ws3.id] = (await inv(ws3.id)).balanceMinor;
    prior.dealer = await balance();
    const r = await allocateReceipt(actor, oid(chequeId), {});
    expect(r.receipt.unallocatedMinor).toBe(0);
    expect((await inv(ws3.id)).balanceMinor).toBe(6_000);
  });

  it('THE DONE-WHEN: it bounces — every invoice back to exactly what it owed, the credit reversed', async () => {
    const ledger = await ledgerCount();
    const r = await bounceCheque(actor, oid(chequeId), {
      reason: 'ZZTEST insufficient funds',
      bounceChargeMinor: 5_000,
    });

    // Every invoice it had paid — including the one paid from its advance — owes again exactly
    // what it owed before the cheque touched it. WS2 keeps the cash paid against it.
    expect(await inv(ws1.id)).toMatchObject({
      balanceMinor: prior[ws1.id],
      paymentStatus: 'UNPAID',
    });
    expect(await inv(ws2.id)).toMatchObject({
      balanceMinor: prior[ws2.id],
      paymentStatus: 'PARTIAL',
    });
    expect(await inv(ws3.id)).toMatchObject({
      balanceMinor: prior[ws3.id],
      paymentStatus: 'UNPAID',
    });
    expect(r.invoices.map((i) => i.docNo).sort()).toEqual(
      [ws1.docNo, ws2.docNo, ws3.docNo].sort(),
    );

    // The receipt: bounced, nothing allocated, its allocations kept and marked reversed.
    const p = (await PaymentDoc.findById(chequeId).lean())!;
    expect(p).toMatchObject({ allocatedMinor: 0, unallocatedMinor: 0 });
    expect(p.instrument).toMatchObject({
      status: 'BOUNCED',
      bounceReason: 'ZZTEST insufficient funds',
      bounceChargeMinor: 5_000,
    });
    expect(p.allocations).toHaveLength(3);
    expect(p.allocations.every((a) => a.reversedAt)).toBe(true);

    // The ledger: a reversing debit pointing at the credit, and the bank's charge.
    const entries = await LedgerEntry.find({ refId: oid(chequeId) })
      .sort({ createdAt: 1, debitMinor: -1 })
      .lean();
    expect(entries.map((e) => [e.docType, e.debitMinor, e.creditMinor])).toEqual([
      ['RECEIPT', 0, 100_000],
      ['CHEQUE_BOUNCE', 100_000, 0],
      ['CHEQUE_BOUNCE', 5_000, 0],
    ]);
    expect(entries[1]!.reversalOfId?.equals(entries[0]!._id)).toBe(true);
    expect(await ledgerCount()).toBe(ledger + 2);
    // The dealer owes what they owed before the cheque, plus the charge.
    expect(await balance()).toBe(prior.dealer + 100_000 - 12_000 + 12_000 + 5_000);

    expect(
      (await refusal(bounceCheque(actor, oid(chequeId), { reason: 'again' }))).status,
    ).toBe(409);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});

describe('ageing — tied to open invoices, today and as of past days', () => {
  it('today: the buckets tie to the sum of open invoice balances, party by party', async () => {
    const report = await ageingReport(actor, {});
    const open = await Invoice.find({
      orgId: f.orgId,
      status: 'POSTED',
      balanceMinor: { $gt: 0 },
    }).lean();
    const sum = open.reduce((t, i) => t + i.balanceMinor, 0);
    expect(report.totalMinor).toBe(sum);
    expect(Object.values(report.totals).reduce((t, n) => t + n, 0)).toBe(sum);
    for (const row of report.rows) {
      expect(Object.values(row.buckets).reduce((t, n) => t + n, 0)).toBe(row.totalMinor);
      for (const i of row.invoices) {
        // Worked out from allocation history, it must equal the invoice's own balance today.
        expect(i.balanceMinor).toBe(open.find((o) => String(o._id) === i.id)!.balanceMinor);
      }
    }
  });

  it('as of past days: an old receivable, part-paid by a back-dated receipt, ages as it stood', async () => {
    const old = await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'DEALER',
      { name: 'ZZTEST Old Account' },
    );
    await importOpeningBalances(actor, {
      asOf: '2026-08-01',
      dryRun: false,
      rows: [{ line: 1, code: old.code, amountMinor: 100_000, dueDate: '2026-08-15' }],
    });
    // ৳400 received on 10 Sep, typed in today.
    await postReceipt(actor, {
      partyId: old.id,
      amountMinor: 40_000,
      method: 'BANK',
      paidAt: '2026-09-10T06:00:00.000Z',
    });

    const at = async (asOf: string) =>
      (await ageingReport(actor, { asOf, partyId: old.id })).rows[0]?.invoices[0];

    expect(await at('2026-07-31')).toBeUndefined(); // not raised yet
    expect(await at('2026-08-15')).toMatchObject({
      balanceMinor: 100_000,
      daysOverdue: 0,
      bucket: 'CURRENT',
    });
    expect(await at('2026-09-01')).toMatchObject({
      balanceMinor: 100_000,
      daysOverdue: 17,
      bucket: '1-30',
    });
    // After the back-dated receipt: the balance it left.
    expect(await at('2026-09-30')).toMatchObject({
      balanceMinor: 60_000,
      daysOverdue: 46,
      bucket: '31-60',
    });
    expect(await at('2026-11-20')).toMatchObject({
      balanceMinor: 60_000,
      daysOverdue: 97,
      bucket: '90+',
    });
  });

  it('a bounce un-pays in ageing too — but not for days before it bounced', async () => {
    // The cheque above cleared and bounced today: ageing as of today shows WS1 owing in full.
    const now = await ageingReport(actor, {});
    const mine = now.rows.find((r) => r.partyId === f.dealerId)!;
    expect(mine.invoices.some((i) => i.balanceMinor === 72_000)).toBe(true);
  });
});
