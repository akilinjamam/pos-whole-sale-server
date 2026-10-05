import { describe, expect, it } from 'vitest';

import {
  openingBalanceImportSchema,
  openingBalanceRowSchema,
  openingSide,
} from '../src/shared/ledger.js';

/**
 * Day 27's pure rules: an opening balance is one signed amount, and the sign decides the side —
 * positive is owed to us (debit), negative is owed by us (credit). Zero is not a balance.
 */

const row = (over: Record<string, unknown> = {}) => ({
  line: 1,
  code: 'p-00001',
  amountMinor: 1,
  ...over,
});

describe('openingSide', () => {
  it('a positive amount is owed to us: a debit', () => {
    expect(openingSide(150_000)).toEqual({ debitMinor: 150_000, creditMinor: 0 });
  });

  it('a negative amount is owed by us: a credit of the magnitude', () => {
    expect(openingSide(-75_050)).toEqual({ debitMinor: 0, creditMinor: 75_050 });
  });
});

describe('openingBalanceRowSchema', () => {
  it('upper-cases the code, keeps the sign', () => {
    expect(openingBalanceRowSchema.parse(row({ amountMinor: -5 }))).toMatchObject({
      code: 'P-00001',
      amountMinor: -5,
    });
  });

  it('refuses zero, fractions and junk dates', () => {
    expect(openingBalanceRowSchema.safeParse(row({ amountMinor: 0 })).success).toBe(false);
    expect(openingBalanceRowSchema.safeParse(row({ amountMinor: 10.5 })).success).toBe(false);
    expect(openingBalanceRowSchema.safeParse(row({ dueDate: '31/03/2026' })).success).toBe(
      false,
    );
    expect(openingBalanceRowSchema.safeParse(row({ code: '' })).success).toBe(false);
  });

  it('accepts a due date and an old reference', () => {
    expect(
      openingBalanceRowSchema.safeParse(
        row({ dueDate: '2026-09-15', reference: 'Old INV 4412' }),
      ).success,
    ).toBe(true);
  });

  it('refuses fields it does not know — a misspelt column is an error, not ignored', () => {
    expect(openingBalanceRowSchema.safeParse(row({ amount: 5 })).success).toBe(false);
  });
});

describe('openingBalanceImportSchema', () => {
  it('needs rows and an explicit dry-run flag', () => {
    expect(openingBalanceImportSchema.safeParse({ rows: [], dryRun: true }).success).toBe(
      false,
    );
    expect(openingBalanceImportSchema.safeParse({ rows: [row()] }).success).toBe(false);
    expect(
      openingBalanceImportSchema.safeParse({ rows: [row()], dryRun: true, asOf: '2026-09-30' })
        .success,
    ).toBe(true);
  });
});
