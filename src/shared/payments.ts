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

export type AllocationInput = z.infer<typeof allocationInputSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;
export type AllocationPreviewQuery = z.infer<typeof allocationPreviewQuerySchema>;
