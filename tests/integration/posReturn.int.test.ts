import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import {
  getReturnableInvoice,
  postCounterReturn,
  refundExchangeCredit,
} from '../../src/modules/pos/posReturn.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { closeSession, openSession } from '../../src/modules/pos/posSession.service.js';
import { SalesReturn } from '../../src/modules/salesReturn/salesReturn.model.js';
import { SerialUnit } from '../../src/modules/serialUnit/serialUnit.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { CounterReturnInput, PosSaleInput } from '../../src/shared/pos.js';

/**
 * Day 20 — counter returns against a POS invoice, end to end in a throwaway org: stock back in,
 * money back out (or on account, or into an exchange), the invoice's returned quantities, and the
 * Z-report netting it all off.
 */

let f: PosFixture;
let actor: ReturnType<typeof actorFor>;
let sessionId: string;
const FLOAT = 500_000;

const sell = (over: Partial<PosSaleInput>) =>
  postPosSale(actor, {
    clientRef: randomUUID(),
    paymentMode: 'CASH',
    lines: [],
    tenders: [],
    ...over,
  });
const giveBack = (
  over: Partial<CounterReturnInput> & Pick<CounterReturnInput, 'invoiceId' | 'lines'>,
) =>
  postCounterReturn(actor, {
    clientRef: randomUUID(),
    reason: 'NOT_SOLD',
    settlement: 'CASH_REFUND',
    ...over,
  });
const onHand = async (productId: string) =>
  (await StockBalance.findOne({ orgId: f.orgId, locationId: f.locationId, productId }).lean())
    ?.qtyOnHand ?? 0;
const serialStatus = async (sn: string) =>
  (await SerialUnit.findOne({ orgId: f.orgId, serialNo: sn }).lean())?.status;

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([
    Invoice.syncIndexes(),
    PaymentDoc.syncIndexes(),
    SalesReturn.syncIndexes(),
  ]);
  f = await createPosFixture();
  actor = actorFor(f);
  sessionId = (
    await openSession(actor, {
      locationId: String(f.locationId),
      terminalCode: 'T1',
      openingFloatMinor: FLOAT,
    })
  ).id;
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('POST /pos/returns — counter returns', () => {
  let cashSaleId: string;
  let frameLineId: string;

  it('refunds cash, restocks, and records what came back on the invoice', async () => {
    // 5 frames at ৳60 with ৳10 off the line: net ৳290.
    const sale = await sell({
      lines: [{ productId: f.frameId, qty: 5, lineDiscountMinor: 1_000 }],
      tenders: [{ method: 'CASH', amountMinor: 29_000 }],
    });
    cashSaleId = sale.invoice.id;
    frameLineId = sale.invoice.lines[0]!.id;
    const before = await onHand(f.frameId);

    const { salesReturn: r } = await giveBack({
      invoiceId: cashSaleId,
      lines: [{ invoiceLineId: frameLineId, qtyBase: 2, condition: 'GOOD' }],
    });

    expect(r.docNo).toMatch(/^SR-\d{4}-00001$/);
    expect(r.grandTotalMinor).toBe(11_600); // 2/5 of ৳290 — the discount is shared, not refunded
    expect(r.refundDocNo).toMatch(/^PAY-/);
    expect(await onHand(f.frameId)).toBe(before + 2);

    const refund = await PaymentDoc.findOne({ orgId: f.orgId, docNo: r.refundDocNo }).lean();
    expect(refund).toMatchObject({ direction: 'OUT', method: 'CASH', amountMinor: 11_600 });
    expect(String(refund!.posSessionId)).toBe(sessionId);

    const inv = await Invoice.findById(cashSaleId).lean();
    expect(inv!.lines[0]!.qtyReturnedBase).toBe(2);
    expect(inv!.paidMinor).toBe(29_000 - 11_600);
    expect(inv!.creditedMinor).toBe(11_600);
    expect(inv!.balanceMinor).toBe(0);
  });

  it('returns the rest piece by piece for exactly what the line cost, then refuses more', async () => {
    const a = await giveBack({
      invoiceId: cashSaleId,
      lines: [{ invoiceLineId: frameLineId, qtyBase: 1, condition: 'GOOD' }],
    });
    const b = await giveBack({
      invoiceId: cashSaleId,
      lines: [{ invoiceLineId: frameLineId, qtyBase: 2, condition: 'GOOD' }],
    });
    expect(11_600 + a.salesReturn.grandTotalMinor + b.salesReturn.grandTotalMinor).toBe(29_000);

    await expect(
      giveBack({
        invoiceId: cashSaleId,
        lines: [{ invoiceLineId: frameLineId, qtyBase: 1, condition: 'GOOD' }],
      }),
    ).rejects.toMatchObject({ status: 422 });
    const view = await getReturnableInvoice(actor, { id: new Types.ObjectId(cashSaleId) });
    expect(view.returnable[0]!.qtyBase).toBe(0);
    expect(view.previousReturns).toHaveLength(3);
    expect(view.settlements).toEqual(['CASH_REFUND', 'REPLACEMENT']);
  });

  it('lets only one of two racing returns of the same units through', async () => {
    const sale = await sell({
      lines: [{ productId: f.frameId, qty: 2 }],
      tenders: [{ method: 'CASH', amountMinor: 12_000 }],
    });
    const line = sale.invoice.lines[0]!.id;
    const results = await Promise.allSettled([
      giveBack({
        invoiceId: sale.invoice.id,
        lines: [{ invoiceLineId: line, qtyBase: 2, condition: 'GOOD' }],
      }),
      giveBack({
        invoiceId: sale.invoice.id,
        lines: [{ invoiceLineId: line, qtyBase: 2, condition: 'GOOD' }],
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await SalesReturn.countDocuments({ orgId: f.orgId, invoiceId: sale.invoice.id }),
    ).toBe(1);
    expect((await Invoice.findById(sale.invoice.id).lean())!.lines[0]!.qtyReturnedBase).toBe(2);
  });

  it('replays — not repeats — a return retried with the same clientRef', async () => {
    const sale = await sell({
      lines: [{ productId: f.frameId, qty: 1 }],
      tenders: [{ method: 'CASH', amountMinor: 6_000 }],
    });
    const input: CounterReturnInput = {
      clientRef: randomUUID(),
      invoiceId: sale.invoice.id,
      reason: 'OTHER',
      settlement: 'CASH_REFUND',
      lines: [{ invoiceLineId: sale.invoice.lines[0]!.id, qtyBase: 1, condition: 'GOOD' }],
    };
    const first = await postCounterReturn(actor, input);
    const again = await postCounterReturn(actor, input);
    expect(again.replayed).toBe(true);
    expect(again.salesReturn.id).toBe(first.salesReturn.id);
    expect(
      await PaymentDoc.countDocuments({ orgId: f.orgId, docNo: first.salesReturn.refundDocNo }),
    ).toBe(1);
  });

  it('puts a GOOD serial back on sale, and writes off a DAMAGED one', async () => {
    const sale = await sell({
      lines: [{ productId: f.machineId, qty: 2, serials: ['ZZSN-1', 'ZZSN-2'] }],
      tenders: [{ method: 'CASH', amountMinor: 10_000_000 }],
    });
    const line = sale.invoice.lines[0]!.id;
    await expect(
      giveBack({
        invoiceId: sale.invoice.id,
        lines: [{ invoiceLineId: line, qtyBase: 1, serials: ['ZZSN-9'], condition: 'GOOD' }],
      }),
    ).rejects.toMatchObject({ status: 422 });

    await giveBack({
      invoiceId: sale.invoice.id,
      lines: [{ invoiceLineId: line, qtyBase: 1, serials: ['ZZSN-1'], condition: 'GOOD' }],
    });
    await giveBack({
      invoiceId: sale.invoice.id,
      reason: 'DAMAGED',
      lines: [{ invoiceLineId: line, qtyBase: 1, serials: ['ZZSN-2'], condition: 'DAMAGED' }],
    });

    expect(await serialStatus('ZZSN-1')).toBe('IN_STOCK');
    expect(await serialStatus('ZZSN-2')).toBe('SCRAPPED');
    expect(await onHand(f.machineId)).toBe(1);
    // …and the good one sells again.
    await sell({
      lines: [{ productId: f.machineId, qty: 1, serials: ['ZZSN-1'] }],
      tenders: [{ method: 'CASH', amountMinor: 5_000_000 }],
    });
    expect(await serialStatus('ZZSN-1')).toBe('SOLD');
  });

  it('exchanges: the return becomes credit a new sale spends, once', async () => {
    const sale = await sell({
      lines: [{ productId: f.frameId, qty: 2 }],
      tenders: [{ method: 'CASH', amountMinor: 12_000 }],
    });
    const { salesReturn: r } = await giveBack({
      invoiceId: sale.invoice.id,
      settlement: 'REPLACEMENT',
      reason: 'WRONG_ITEM',
      lines: [{ invoiceLineId: sale.invoice.lines[0]!.id, qtyBase: 2, condition: 'GOOD' }],
    });
    expect(r.grandTotalMinor).toBe(12_000);
    expect(r.refundDocNo).toBeNull();

    // Credit worth more than the new items is refused — only cash gives change.
    await expect(
      sell({
        lines: [{ productId: f.frameId, qty: 1 }],
        tenders: [{ method: 'EXCHANGE', returnId: r.id, amountMinor: 12_000 }],
      }),
    ).rejects.toMatchObject({ status: 422 });

    const swap = await sell({
      lines: [{ productId: f.frameId, qty: 3 }],
      tenders: [
        { method: 'EXCHANGE', returnId: r.id, amountMinor: 12_000 },
        { method: 'CASH', amountMinor: 10_000 },
      ],
    });
    expect(swap.changeMinor).toBe(4_000);
    expect(swap.payments.map((p) => p.method).sort()).toEqual(['ADJUSTMENT', 'CASH']);
    expect((await SalesReturn.findById(r.id).lean())!.replacementDocNo).toBe(
      swap.invoice.docNo,
    );

    await expect(
      sell({
        lines: [{ productId: f.frameId, qty: 2 }],
        tenders: [{ method: 'EXCHANGE', returnId: r.id, amountMinor: 12_000 }],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(refundExchangeCredit(actor, new Types.ObjectId(r.id))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refunds an exchange credit nobody spent', async () => {
    const sale = await sell({
      lines: [{ productId: f.frameId, qty: 1 }],
      tenders: [{ method: 'CASH', amountMinor: 6_000 }],
    });
    const { salesReturn: r } = await giveBack({
      invoiceId: sale.invoice.id,
      settlement: 'REPLACEMENT',
      lines: [{ invoiceLineId: sale.invoice.lines[0]!.id, qtyBase: 1, condition: 'GOOD' }],
    });
    const refunded = await refundExchangeCredit(actor, new Types.ObjectId(r.id));
    expect(refunded.settlement).toBe('CASH_REFUND');
    expect(refunded.refundDocNo).toMatch(/^PAY-/);
  });

  it('credits a dealer’s account for a sale that went on it — and refuses cash beyond what was paid', async () => {
    const sale = await sell({
      paymentMode: 'CREDIT',
      partyId: f.dealerId,
      lines: [{ productId: f.frameId, qty: 4 }],
      tenders: [{ method: 'CASH', amountMinor: 6_000 }],
    });
    const line = sale.invoice.lines[0]!.id;
    const balanceBefore = (await Party.findById(f.dealerId).lean())!.currentBalanceMinor;

    await expect(
      giveBack({
        invoiceId: sale.invoice.id,
        settlement: 'REPLACEMENT',
        lines: [{ invoiceLineId: line, qtyBase: 1, condition: 'GOOD' }],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      giveBack({
        invoiceId: sale.invoice.id,
        settlement: 'CASH_REFUND',
        lines: [{ invoiceLineId: line, qtyBase: 2, condition: 'GOOD' }],
      }),
    ).rejects.toMatchObject({ status: 422 });

    const { salesReturn: r } = await giveBack({
      invoiceId: sale.invoice.id,
      settlement: 'CREDIT_NOTE',
      lines: [{ invoiceLineId: line, qtyBase: 2, condition: 'GOOD' }],
    });
    expect(r.creditNoteDocNo).toMatch(/^CN-/);
    expect((await Party.findById(f.dealerId).lean())!.currentBalanceMinor).toBe(
      balanceBefore - 12_000,
    );
    expect(
      await LedgerEntry.countDocuments({
        orgId: f.orgId,
        docType: 'CREDIT_NOTE',
        refDocNo: r.creditNoteDocNo,
      }),
    ).toBe(1);
    const inv = await Invoice.findById(sale.invoice.id).lean();
    expect(inv!.balanceMinor).toBe(24_000 - 6_000 - 12_000);
  });

  it('closes the shift with refunds netted off expected cash, and returns in the Z-report', async () => {
    const [cashIn, cashOut, returns, sales] = await Promise.all([
      PaymentDoc.aggregate([
        { $match: { orgId: f.orgId, method: 'CASH', direction: 'IN' } },
        { $group: { _id: null, t: { $sum: '$amountMinor' } } },
      ]),
      PaymentDoc.aggregate([
        { $match: { orgId: f.orgId, method: 'CASH', direction: 'OUT' } },
        { $group: { _id: null, t: { $sum: '$amountMinor' } } },
      ]),
      SalesReturn.aggregate([
        { $match: { orgId: f.orgId } },
        { $group: { _id: null, t: { $sum: '$grandTotalMinor' }, n: { $sum: 1 } } },
      ]),
      Invoice.aggregate([
        { $match: { orgId: f.orgId } },
        { $group: { _id: null, t: { $sum: '$grandTotalMinor' } } },
      ]),
    ]);
    const expected = FLOAT + cashIn[0].t - cashOut[0].t;

    const closed = await closeSession(actor, new Types.ObjectId(sessionId), {
      denominations: [{ note: 1000, count: Math.floor(expected / 100_000) }],
    });
    expect(closed.expectedCashMinor).toBe(expected);
    expect(closed.varianceMinor).toBe(Math.floor(expected / 100_000) * 100_000 - expected);
    expect(closed.totals.returnsMinor).toBe(returns[0].t);
    expect(closed.totals.returnsCount).toBe(returns[0].n);
    expect(closed.totals.netMinor).toBe(sales[0].t - returns[0].t);
    expect(closed.totals.cashOutMinor).toBe(cashOut[0].t);
  });
});
