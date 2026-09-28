import { describe, expect, it } from 'vitest';

import {
  addMonths,
  daysToExpiry,
  expiryFromShelfLife,
  warrantyEndDay,
  warrantyStatus,
} from '../src/domain/warranty.js';

/**
 * Warranty and expiry dates are promises made to customers; an off-by-one here is a disputed
 * claim. These pin the calendar rules down.
 */

describe('addMonths', () => {
  it('adds calendar months', () => {
    expect(addMonths('2026-03-15', 12)).toBe('2027-03-15');
    expect(addMonths('2026-11-10', 3)).toBe('2027-02-10');
  });

  it('clamps to the end of a shorter month instead of spilling into the next', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
  });
});

describe('warrantyEndDay', () => {
  it('is the day before the anniversary — inclusive of the last covered day', () => {
    expect(warrantyEndDay('2026-03-15', 12)).toBe('2027-03-14');
    expect(warrantyEndDay('2026-01-01', 6)).toBe('2026-06-30');
  });
});

describe('warrantyStatus', () => {
  const sold = { warrantyMonths: 12, warrantyStartDay: '2026-03-15' };

  it('is NONE for a product without a warranty', () => {
    expect(
      warrantyStatus({ warrantyMonths: null, warrantyStartDay: '2026-03-15' }, '2026-04-01')
        .state,
    ).toBe('NONE');
  });

  it('is NOT_STARTED until the unit is sold — shelf time does not use the warranty', () => {
    expect(
      warrantyStatus({ warrantyMonths: 12, warrantyStartDay: null }, '2029-01-01'),
    ).toEqual({
      state: 'NOT_STARTED',
      endsOn: null,
      daysLeft: null,
    });
  });

  it('is ACTIVE through the last covered day, counting today', () => {
    expect(warrantyStatus(sold, '2026-03-15')).toMatchObject({
      state: 'ACTIVE',
      endsOn: '2027-03-14',
    });
    expect(warrantyStatus(sold, '2027-03-14')).toMatchObject({ state: 'ACTIVE', daysLeft: 1 });
  });

  it('is EXPIRED the day after', () => {
    expect(warrantyStatus(sold, '2027-03-15')).toMatchObject({ state: 'EXPIRED', daysLeft: 0 });
  });
});

describe('expiry', () => {
  it('defaults an expiry from the manufacture date and shelf life', () => {
    expect(expiryFromShelfLife('2026-01-10', 365)).toBe('2027-01-10');
  });

  it('counts days to expiry, negative once past', () => {
    expect(daysToExpiry('2026-10-01', '2026-09-28')).toBe(3);
    expect(daysToExpiry('2026-09-28', '2026-09-28')).toBe(0);
    expect(daysToExpiry('2026-09-20', '2026-09-28')).toBe(-8);
  });
});
