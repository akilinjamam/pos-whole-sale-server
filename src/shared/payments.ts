/**
 * Receipt inputs — Day 28. Shared: the Day-29 receipt screen validates with the same schemas.
 *
 * A receipt is money a dealer (or an account customer) paid us. It may carry an explicit
 * `allocations[]` — "this one pays WS-0041 and half of WS-0047" — or none, in which case the
 * server allocates oldest-due-first. Anything not allocated stays on the receipt as an advance.
 *
 * Cheques are not taken here yet: a cheque's money is not ours until it clears, so its ledger
 * entry and allocation post on clearing — the cheque lifecycle, Day 30.
 */

import { z } from 'zod';

import { MFS_PROVIDERS } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const minor = z
  .number()
  .int('Whole minor units')
  .min(1, 'More than zero')
  .max(Number.MAX_SAFE_INTEGER);

export const RECEIPT_METHODS = ['CASH', 'BANK', 'MFS', 'CARD'] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

export const MAX_ALLOCATIONS = 200;

export const allocationInputSchema = z
  .object({ invoiceId: objectId, amountMinor: minor })
  .strict();

const allocations = z.array(allocationInputSchema).max(MAX_ALLOCATIONS);

export const receiptSchema = z
  .object({
    partyId: objectId,
    amountMinor: minor,
    method: z.enum(RECEIPT_METHODS),
    /** When the money was received. Default: now. Back-dating is allowed; the future is not. */
    paidAt: z
      .string()
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, 'Cannot be in the future')
      .optional(),
    /**
     * Omitted: oldest-due-first. An empty list: none — the whole receipt is an advance. Otherwise
     * exactly these, and the rest (if any) an advance.
     */
    allocations: allocations.optional(),
    /** A bank transfer reference, a deposit slip number. */
    reference: z.string().trim().max(80).nullable().optional(),
    mfs: z
      .object({
        provider: z.enum(MFS_PROVIDERS),
        trxId: z.string().trim().toUpperCase().min(4).max(40),
        senderNumber: z.string().trim().max(20).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    narration: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((r) => r.method !== 'MFS' || Boolean(r.mfs), {
    path: ['mfs'],
    message: 'A bKash / Nagad / Rocket receipt needs its transaction id',
  })
  .refine((r) => r.method === 'MFS' || !r.mfs, {
    path: ['mfs'],
    message: 'Only a mobile-money receipt has an MFS transaction',
  });

/** Spend an advance later: allocate (some of) a receipt's unallocated amount. */
export const allocateReceiptSchema = z
  .object({
    /** Omitted: oldest-due-first, up to what is unallocated. */
    allocations: allocations.min(1).optional(),
  })
  .strict();

export const allocationPreviewQuerySchema = z
  .object({
    partyId: objectId,
    amountMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** The collector's round: dealers who owe, optionally narrowed by salesperson or territory. */
export const collectionSheetQuerySchema = z
  .object({
    salespersonUserId: objectId.optional(),
    territory: z.string().trim().max(60).optional(),
    /** Only dealers with something past due. */
    overdueOnly: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

export type CollectionSheetQuery = z.infer<typeof collectionSheetQuerySchema>;

// ─── Cheques (Day 30) ───────────────────────────────────────────────────────────────────

const notFuture = (v: string) => new Date(v).getTime() <= Date.now() + 60_000;
const when = z.string().datetime({ offset: true }).refine(notFuture, 'Cannot be in the future');

/**
 * Taking a cheque. Like a receipt, but nothing posts until it clears: `allocations` is the split
 * chosen now (default oldest-due-first), applied on clearing. Post-dated cheques are normal in this
 * trade — `chequeDate` may be in the future, up to six months.
 */
export const chequeSchema = z
  .object({
    partyId: objectId,
    amountMinor: minor,
    chequeNo: z.string().trim().toUpperCase().min(1, 'Required').max(30),
    bankName: z.string().trim().min(2, 'Which bank?').max(60),
    branch: z.string().trim().max(60).nullable().optional(),
    chequeDate: z
      .string()
      .date('Use YYYY-MM-DD')
      .refine(
        (v) => new Date(`${v}T00:00:00Z`).getTime() <= Date.now() + 183 * 86_400_000,
        'More than six months ahead',
      ),
    /** When it was handed over. Default: now. */
    receivedAt: when.optional(),
    allocations: allocations.optional(),
    narration: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export const depositChequeSchema = z
  .object({
    depositedAt: when.optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

/** Cleared — from the bank statement. Default: now. Never before the date on the cheque. */
export const clearChequeSchema = z.object({ clearedAt: when.optional() }).strict();

export const bounceChequeSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, 'Say why — insufficient funds, signature mismatch…')
      .max(200),
    /** What the bank charged us for it, to pass on to the dealer. */
    bounceChargeMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    bouncedAt: when.optional(),
  })
  .strict();

/** Receivables ageing as of a day — default today. Re-runnable for any past day. */
export const ageingQuerySchema = z
  .object({
    asOf: z.string().date('Use YYYY-MM-DD').optional(),
    partyId: objectId.optional(),
    territory: z.string().trim().max(60).optional(),
  })
  .strict();

export type ChequeInput = z.infer<typeof chequeSchema>;
export type DepositChequeInput = z.infer<typeof depositChequeSchema>;
export type ClearChequeInput = z.infer<typeof clearChequeSchema>;
export type BounceChequeInput = z.infer<typeof bounceChequeSchema>;
export type AgeingQuery = z.infer<typeof ageingQuerySchema>;

export type AllocationInput = z.infer<typeof allocationInputSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;
export type AllocationPreviewQuery = z.infer<typeof allocationPreviewQuerySchema>;

// ─── Supplier payments (Day 35) ─────────────────────────────────────────────────────────

/**
 * Money we pay a supplier (`PAY`, direction OUT), allocated against their bills — the posted goods
 * receipts — with the same machinery as a receipt: explicit `allocations`, or oldest-due-first.
 * What is not allocated is an advance to the supplier. Our own cheques post when issued: the
 * cheque number goes in `reference`.
 */
export const SUPPLIER_PAYMENT_METHODS = ['CASH', 'BANK', 'CHEQUE', 'MFS'] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export const payableAllocationInputSchema = z
  .object({ grnId: objectId, amountMinor: minor })
  .strict();

const payableAllocations = z.array(payableAllocationInputSchema).max(MAX_ALLOCATIONS);

export const supplierPaymentSchema = z
  .object({
    partyId: objectId,
    amountMinor: minor,
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    paidAt: z
      .string()
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, 'Cannot be in the future')
      .optional(),
    /** Omitted: oldest-due-first. Empty: none — all of it an advance. */
    allocations: payableAllocations.optional(),
    /** The cheque number, the bank transfer reference. */
    reference: z.string().trim().max(80).nullable().optional(),
    mfs: z
      .object({
        provider: z.enum(MFS_PROVIDERS),
        trxId: z.string().trim().toUpperCase().min(4).max(40),
        senderNumber: z.string().trim().max(20).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    narration: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((r) => r.method !== 'CHEQUE' || Boolean(r.reference?.trim()), {
    path: ['reference'],
    message: 'Which cheque? Give its number',
  })
  .refine((r) => r.method !== 'MFS' || Boolean(r.mfs), {
    path: ['mfs'],
    message: 'A bKash / Nagad / Rocket payment needs its transaction id',
  })
  .refine((r) => r.method === 'MFS' || !r.mfs, {
    path: ['mfs'],
    message: 'Only a mobile-money payment has an MFS transaction',
  });

export const allocateSupplierPaymentSchema = z
  .object({ allocations: payableAllocations.min(1).optional() })
  .strict();

export const payablesPreviewQuerySchema = allocationPreviewQuerySchema;

export type PayableAllocationInput = z.infer<typeof payableAllocationInputSchema>;
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;
export type AllocateSupplierPaymentInput = z.infer<typeof allocateSupplierPaymentSchema>;
