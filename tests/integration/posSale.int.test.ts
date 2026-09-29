import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import { HeldSale } from '../../src/modules/pos/heldSale.model.js';
import { holdSale } from '../../src/modules/pos/heldSale.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { closeSession, openSession } from '../../src/modules/pos/posSession.service.js';
import { SerialUnit } from '../../src/modules/serialUnit/serialUnit.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { PosSaleInput } from '../../src/shared/pos.js';

/**
 * Day 18's "done when", end to end against a real replica set, in a throwaway org:
 *   - a counter sale posts atomically (invoice + receipts + stock, and ledger on credit);
 *   - killing the process mid-transaction leaves no partial state;
 *   - an oversell fails cleanly.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;
let sessionId: string;

const sale = (over: Partial<PosSaleInput>): PosSaleInput => ({
  clientRef: randomUUID(),
  paymentMode: 'CASH',
  lines: [],
  tenders: [],
  ...over,
});
const onHand = async (productId: string) =>
  (await StockBalance.findOne({ orgId: f.orgId, locationId: f.locationId, productId }).lean())
    ?.qtyOnHand ?? 0;
const seq = (docNo: string | null) => Number(docNo?.split('-').pop());

/** Everything a sale could have written, counted — to prove a refused sale wrote none of it. */
async function footprint() {
  return {
    invoices: await Invoice.countDocuments({ orgId: f.orgId }),
    payments: await PaymentDoc.countDocuments({ orgId: f.orgId }),
    ledger: await LedgerEntry.countDocuments({ orgId: f.orgId }),
    stockRows: await StockLedger.countDocuments({ orgId: f.orgId }),
    frame: await onHand(f.frameId),
    machine: await onHand(f.machineId),
    dealerBalance: (await Party.findById(f.dealerId).lean())?.currentBalanceMinor,
  };
}

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([Invoice.syncIndexes(), PaymentDoc.syncIndexes(), HeldSale.syncIndexes()]);
  f = await createPosFixture();
  actor = actorFor(f);
  sessionId = (
    await openSession(actor, {
      locationId: String(f.locationId),
      terminalCode: 'T1',
      openingFloatMinor: 500_000,
    })
  ).id;
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('POST /pos/sales — atomic counter sale', () => {
  it('posts invoice, receipt and stock together, priced by the server', async () => {
    const r = await postPosSale(
      actor,
      sale({
        lines: [
          { productId: f.frameId, uomCode: 'DOZ', qty: 2 },
          { productId: f.machineId, qty: 1, serials: ['ZZSN-1'] },
        ],
        tenders: [{ method: 'CASH', amountMinor: 5_200_000 }],
      }),
    );

    // 2 DOZ × (৳60 × 12) + ৳50,000 — prices from the product defaults, not from the till.
    expect(r.invoice.grandTotalMinor).toBe(2 * 72_000 + 5_000_000);
    expect(r.invoice.docNo).toMatch(/^POS-\d{4}-00001$/);
    expect(r.invoice.paymentStatus).toBe('PAID');
    expect(r.changeMinor).toBe(5_200_000 - 5_144_000);
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]!.amountMinor).toBe(5_144_000); // change is not money received
    expect(await onHand(f.frameId)).toBe(60 - 24);
    expect(
      (await SerialUnit.findOne({ orgId: f.orgId, serialNo: 'ZZSN-1' }).lean())?.status,
    ).toBe('SOLD');
    expect(await LedgerEntry.countDocuments({ orgId: f.orgId })).toBe(0); // cash sale: no ledger
  });

  it('replays — not repeats — a sale retried with the same clientRef', async () => {
    const input = sale({
      lines: [{ productId: f.frameId, qty: 1 }],
      tenders: [{ method: 'CASH', amountMinor: 6_000 }],
    });
    const first = await postPosSale(actor, input);
    const before = await footprint();
    const again = await postPosSale(actor, input);
    expect(again.replayed).toBe(true);
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(await footprint()).toEqual(before);
  });

  it('refuses an oversell cleanly: 409, and nothing written — not even a number', async () => {
    const before = await footprint();
    const lastNo = seq(
      (await Invoice.findOne({ orgId: f.orgId }).sort({ createdAt: -1 }).lean())!.docNo,
    );

    await expect(
      postPosSale(
        actor,
        sale({
          lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 10 }],
          tenders: [{ method: 'CASH', amountMinor: 1_000_000 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await footprint()).toEqual(before);

    const next = await postPosSale(
      actor,
      sale({
        lines: [{ productId: f.frameId, qty: 1 }],
        tenders: [{ method: 'CASH', amountMinor: 6_000 }],
      }),
    );
    expect(seq(next.invoice.docNo)).toBe(lastNo + 1);
  });

  it('refuses selling a serial twice, and a short cash payment', async () => {
    const before = await footprint();
    await expect(
      postPosSale(
        actor,
        sale({
          lines: [{ productId: f.machineId, qty: 1, serials: ['ZZSN-1'] }],
          tenders: [{ method: 'CASH', amountMinor: 5_000_000 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      postPosSale(
        actor,
        sale({
          lines: [{ productId: f.frameId, qty: 1 }],
          tenders: [{ method: 'CASH', amountMinor: 5_000 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await footprint()).toEqual(before);
  });

  it('splits a payment across card and cash, with change from the cash', async () => {
    const r = await postPosSale(
      actor,
      sale({
        lines: [{ productId: f.frameId, qty: 2 }],
        tenders: [
          { method: 'CARD', amountMinor: 10_000, reference: '4242' },
          { method: 'CASH', amountMinor: 5_000 },
        ],
      }),
    );
    expect(r.invoice.grandTotalMinor).toBe(12_000);
    expect(r.payments.map((p) => [p.method, p.amountMinor])).toEqual([
      ['CARD', 10_000],
      ['CASH', 2_000],
    ]);
    expect(r.changeMinor).toBe(3_000);
  });

  it('refuses a discount or price change without the permission', async () => {
    const cashier = actorFor(f, ['pos:sell']);
    await expect(
      postPosSale(
        cashier,
        sale({
          lines: [{ productId: f.frameId, qty: 1, lineDiscountMinor: 500 }],
          tenders: [{ method: 'CASH', amountMinor: 6_000 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('credit at the counter', () => {
  it('posts the ledger and moves the dealer balance by the unpaid part', async () => {
    const r = await postPosSale(
      actor,
      sale({
        paymentMode: 'CREDIT',
        partyId: f.dealerId,
        lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
        tenders: [{ method: 'CASH', amountMinor: 20_000 }],
      }),
    );
    expect(r.invoice.paymentStatus).toBe('PARTIAL');
    expect(r.invoice.balanceMinor).toBe(72_000 - 20_000);
    const entries = await LedgerEntry.find({ orgId: f.orgId }).sort({ debitMinor: -1 }).lean();
    expect(entries.map((e) => [e.docType, e.debitMinor, e.creditMinor])).toEqual([
      ['INVOICE', 72_000, 0],
      ['RECEIPT', 0, 20_000],
    ]);
    expect((await Party.findById(f.dealerId).lean())?.currentBalanceMinor).toBe(52_000);
  });

  it('refuses credit over the limit, writing nothing', async () => {
    await Party.updateOne(
      { _id: f.dealerId },
      { $set: { 'dealer.creditLimitMinor': 100_000 } },
    );
    const before = await footprint();
    await expect(
      postPosSale(
        actor,
        sale({
          paymentMode: 'CREDIT',
          partyId: f.dealerId,
          lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'CREDIT_LIMIT_EXCEEDED' });
    expect(await footprint()).toEqual(before);
  });

  it('refuses credit to a walk-in', async () => {
    await expect(
      postPosSale(
        actor,
        sale({ paymentMode: 'CREDIT', lines: [{ productId: f.frameId, qty: 1 }] }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('killing the process mid-transaction', () => {
  it('leaves no partial state — and the next sale still gets the next number', async () => {
    const before = await footprint();
    const lastNo = seq(
      (await Invoice.findOne({ orgId: f.orgId, docNo: { $ne: null } })
        .sort({ createdAt: -1 })
        .lean())!.docNo,
    );
    const clientRef = randomUUID();
    const input = sale({
      clientRef,
      lines: [
        { productId: f.frameId, qty: 3 },
        { productId: f.machineId, qty: 1, serials: ['ZZSN-2'] },
      ],
      tenders: [{ method: 'CASH', amountMinor: 6_000_000 }],
    });

    const child = spawnSync('npx', ['tsx', 'tests/integration/fixtures/crashSale.ts'], {
      env: {
        ...process.env,
        FIXTURE: JSON.stringify({ orgId: String(f.orgId), userId: String(f.userId), input }),
      },
      encoding: 'utf8',
      timeout: 120_000,
    });

    // It really did get as far as writing everything, and really did die before committing.
    expect(child.stdout).toContain('WRITES-DONE');
    expect(child.status).toBe(137);

    expect(await Invoice.countDocuments({ orgId: f.orgId, clientRef })).toBe(0);
    expect(await footprint()).toEqual(before);
    expect(
      (await SerialUnit.findOne({ orgId: f.orgId, serialNo: 'ZZSN-2' }).lean())?.status,
    ).toBe('IN_STOCK');

    // The dead transaction's number was never committed: the next sale takes it.
    const next = await postPosSale(
      actor,
      sale({
        lines: [{ productId: f.frameId, qty: 1 }],
        tenders: [{ method: 'CASH', amountMinor: 6_000 }],
      }),
    );
    expect(seq(next.invoice.docNo)).toBe(lastNo + 1);
  }, 240_000);
});

describe('held sales and the shift close', () => {
  it('parks a cart, sells it later, and removes it in the same transaction', async () => {
    const held = await holdSale(actor, {
      label: 'ZZ lady in red',
      lines: [{ productId: f.frameId, qty: 1 }],
    });
    await postPosSale(
      actor,
      sale({
        heldSaleId: held.id,
        lines: [{ productId: f.frameId, qty: 1 }],
        tenders: [{ method: 'CASH', amountMinor: 6_000 }],
      }),
    );
    expect(await HeldSale.countDocuments({ _id: new Types.ObjectId(held.id) })).toBe(0);
  });

  it('closes with expected = float + cash kept, and the variance of the count', async () => {
    const cashKept = (
      await PaymentDoc.find({ orgId: f.orgId, method: 'CASH', direction: 'IN' }).lean()
    ).reduce((s, p) => s + p.amountMinor, 0);
    const expected = 500_000 + cashKept;
    // Count ৳100 short: the drawer holds expected − 10,000 poisha, in ৳1,000 notes and ৳1 coins.
    const counted = expected - 10_000;
    const closed = await closeSession(actor, new Types.ObjectId(sessionId), {
      denominations: [
        { note: 1000, count: Math.floor(counted / 100_000) },
        { note: 1, count: (counted % 100_000) / 100 },
      ],
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.expectedCashMinor).toBe(expected);
    expect(closed.countedCashMinor).toBe(counted);
    expect(closed.varianceMinor).toBe(-10_000);
    expect(closed.totals.salesCount).toBe(await Invoice.countDocuments({ orgId: f.orgId }));
  });
});
