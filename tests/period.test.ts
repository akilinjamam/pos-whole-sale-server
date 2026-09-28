import { describe, expect, it } from 'vitest';

import { addDays, dayIn, periodKeyOf, startOfDayIn } from '../src/lib/period.js';
import { MOVEMENT_SIGN } from '../src/shared/stock.js';
import { STOCK_MOVEMENT_TYPES } from '../src/shared/enums.js';

/**
 * Business dates in the org's zone. Every ledger row's `periodKey` and every "from–to" filter
 * goes through these, and the failure they prevent is quiet: a sale at 00:30 in Dhaka filed
 * under yesterday — and, on the last night of the month, under last month.
 */

const DHAKA = 'Asia/Dhaka'; // UTC+6, no DST

describe('periodKeyOf / dayIn', () => {
  it('uses the org zone, not UTC, at a month boundary', () => {
    // 1 July 00:30 in Dhaka is still 30 June in UTC.
    const t = new Date('2026-06-30T18:30:00Z');
    expect(periodKeyOf(t, DHAKA)).toBe(202607);
    expect(periodKeyOf(t, 'UTC')).toBe(202606);
    expect(dayIn(t, DHAKA)).toBe('2026-07-01');
  });

  it('gives a YYYYMM number', () => {
    expect(periodKeyOf(new Date('2026-01-15T06:00:00Z'), DHAKA)).toBe(202601);
  });
});

describe('startOfDayIn', () => {
  it('is local midnight, as a UTC instant', () => {
    expect(startOfDayIn('2026-07-01', DHAKA).toISOString()).toBe('2026-06-30T18:00:00.000Z');
    expect(startOfDayIn('2026-07-01', 'UTC').toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('puts a 00:30 sale on its own day for an inclusive date filter', () => {
    const sale = new Date('2026-06-30T18:30:00Z'); // 1 July 00:30 Dhaka
    const from = startOfDayIn('2026-07-01', DHAKA);
    const toExclusive = startOfDayIn(addDays('2026-07-01', 1), DHAKA);
    expect(sale >= from && sale < toExclusive).toBe(true);
  });
});

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('MOVEMENT_SIGN', () => {
  it('declares a direction for every movement type', () => {
    expect(Object.keys(MOVEMENT_SIGN).sort()).toEqual([...STOCK_MOVEMENT_TYPES].sort());
  });

  it('makes every sale-like movement outbound', () => {
    expect(MOVEMENT_SIGN.SALE).toBe('OUT');
    expect(MOVEMENT_SIGN.TRANSFER_OUT).toBe('OUT');
    expect(MOVEMENT_SIGN.OPENING).toBe('IN');
  });
});
