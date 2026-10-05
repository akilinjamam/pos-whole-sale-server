/**
 * Party-ledger inputs — Day 27: opening balances, and reading the ledger.
 *
 * An opening balance is one **signed** amount per party, as of the cutover date:
 *
 *   positive  the party owes us — a dealer's unpaid invoices from the old system  → DEBIT
 *   negative  we owe the party  — a supplier's unpaid bills, or a dealer's advance → CREDIT
 *
 * One column, one sign convention, because that is how the old books export it ("balance"), and
 * because two columns invite a row with both filled in. The dry run shows each row's side before
 * anything is posted.
 */

import { z } from 'zod';

import { LEDGER_DOC_TYPES } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const day = z.string().date('Use YYYY-MM-DD');

export const MAX_OPENING_BALANCE_ROWS = 5000;

export const openingBalanceRowSchema = z
  .object({
    /** 1-based line in the file, echoed back in the report. */
    line: z.number().int().min(1),
    /** The party's code (`P-00042`). Codes, not names: names are typed three ways in old books. */
    code: z.string().trim().toUpperCase().min(1, 'Required').max(30),
    /** Signed, minor units. Zero is not an opening balance — leave the row out. */
    amountMinor: z
      .number()
      .int('Whole minor units')
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((v) => v !== 0, 'Zero is not a balance — leave the row out'),
    /**
     * For a receivable: when the old invoices fall due, so ageing (Day 30) starts out right.
     * Defaults to the cutover date — "already due".
     */
    dueDate: day.nullable().optional(),
    /** The old system's reference — an invoice number, a ledger folio. Kept as the narration. */
    reference: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export const openingBalanceImportSchema = z
  .object({
    /** The cutover date, `YYYY-MM-DD`. Defaults to today in the org's time zone. */
    asOf: day.optional(),
    rows: z
      .array(openingBalanceRowSchema)
      .min(1, 'The file has no rows')
      .max(MAX_OPENING_BALANCE_ROWS),
    dryRun: z.boolean(),
  })
  .strict();

export const listLedgerQueryFields = {
  partyId: objectId.optional(),
  docType: z.enum(LEDGER_DOC_TYPES).optional(),
  from: day.optional(),
  to: day.optional(),
};

/** A party's statement: `from`–`to`, inclusive, in the org's zone. Defaults: this month to today. */
export const statementQuerySchema = z
  .object({ partyId: objectId, from: day.optional(), to: day.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: 'The end date is before the start date',
  });

export type StatementQuery = z.infer<typeof statementQuerySchema>;

export type OpeningBalanceRow = z.infer<typeof openingBalanceRowSchema>;
export type OpeningBalanceImportInput = z.infer<typeof openingBalanceImportSchema>;

/** The side an opening amount posts to: positive is owed *to* us. */
export function openingSide(amountMinor: number): { debitMinor: number; creditMinor: number } {
  return amountMinor > 0
    ? { debitMinor: amountMinor, creditMinor: 0 }
    : { debitMinor: 0, creditMinor: -amountMinor };
}
