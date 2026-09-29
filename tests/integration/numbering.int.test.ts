import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Counter, nextDocNo } from '../../src/lib/numbering.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { NumberSeries } from '../../src/modules/numberSeries/numberSeries.model.js';

/**
 * Day 17's "done when", against a real replica set (transactions need one).
 *
 *   npm run test:integration        — uses MONGODB_URI from .env
 *
 * Everything runs under a **fresh random org id**, so the counters and invoices it creates cannot
 * collide with — or be mistaken for — real data, and `afterAll` deletes exactly those.
 */

const orgId = new Types.ObjectId();
const locationId = new Types.ObjectId();

/** A real post: take a number and write the invoice that carries it, in one transaction. */
function post(series: 'POS' | 'WS' = 'POS') {
  return withTransaction(async (session) => {
    const docNo = await nextDocNo(session, orgId, series, new Date());
    await Invoice.create(
      [
        {
          orgId,
          series,
          docNo,
          channel: series === 'POS' ? 'COUNTER' : 'WHOLESALE',
          locationId,
          invoiceDate: new Date(),
          status: 'POSTED',
        },
      ],
      { session },
    );
    return docNo;
  });
}

const seqOf = (docNo: string) => Number(docNo.split('-').pop());

beforeAll(async () => {
  await connectDatabase();
  await Invoice.syncIndexes();
});

afterAll(async () => {
  await Invoice.deleteMany({ orgId });
  await NumberSeries.deleteMany({ orgId });
  await Counter.deleteMany({ _id: { $regex: `^${String(orgId)}:` } });
  await disconnectDatabase();
});

describe('document numbering under concurrency', () => {
  it('50 parallel posts produce 50 distinct, gapless numbers', async () => {
    const docNos = await Promise.all(Array.from({ length: 50 }, () => post()));

    expect(new Set(docNos).size).toBe(50);
    expect(docNos.map(seqOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(await Invoice.countDocuments({ orgId, series: 'POS' })).toBe(50);
  }, 180_000);

  it('a failed post consumes no number', async () => {
    await expect(
      withTransaction(async (session) => {
        await nextDocNo(session, orgId, 'POS', new Date());
        throw new Error('the post failed after taking a number');
      }),
    ).rejects.toThrow('the post failed');

    // The increment rolled back with the transaction: the next post gets 51, not 52.
    expect(seqOf(await post())).toBe(51);
  }, 60_000);

  it('the unique index refuses a duplicate number even if numbering were bypassed', async () => {
    const existing = await Invoice.findOne({ orgId, series: 'POS' }).select('docNo').lean();
    await expect(
      Invoice.create({
        orgId,
        series: 'POS',
        docNo: existing!.docNo,
        channel: 'COUNTER',
        locationId,
        invoiceDate: new Date(),
        status: 'POSTED',
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('each series counts on its own', async () => {
    expect(seqOf(await post('WS'))).toBe(1);
  });

  it('follows the org’s configured format without renumbering the sequence', async () => {
    await NumberSeries.create({
      orgId,
      series: 'WS',
      prefix: 'INV',
      padding: 6,
      resetPolicy: 'YEARLY',
      separator: '/',
    });
    const docNo = await post('WS');
    // Same yearly counter as the previous WS post — the prefix changed, the sequence did not.
    expect(docNo).toMatch(/^INV\/\d{4}\/000002$/);
  });
});
