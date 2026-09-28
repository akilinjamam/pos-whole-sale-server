/**
 * Stock document inputs — adjustments, transfers, counts (Day 14).
 *
 * All three follow the same life: a **draft** is freely editable and moves nothing; **posting**
 * allocates the document number and writes the stock movements in one transaction; after that
 * the document is a record and the ledger rows it wrote are immutable.
 *
 * Quantities are entered in any unit the product declares (`DOZ`, `CTN`, …) and converted to base
 * units server-side. Money never appears here — a stock document moves quantities; value follows
 * from cost (Day 33).
 */

import { z } from 'zod';

import { ADJUSTMENT_REASONS } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const note = z.string().trim().max(500).nullable().optional();
const MAX_LINES = 500;

const lineBase = {
  productId: objectId,
  variantId: objectId.nullable().optional(),
  /** Defaults to the product's base unit. */
  uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
};

/** A line that only ever moves stock one way — a transfer. */
const positiveLine = z
  .object({
    ...lineBase,
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(10_000_000),
  })
  .strict();

/** An adjustment line: `+` for stock found, `−` for stock written off. Never zero. */
const signedLine = z
  .object({
    ...lineBase,
    qty: z
      .number()
      .int('Whole units only')
      .min(-10_000_000)
      .max(10_000_000)
      .refine((v) => v !== 0, 'Cannot be zero — use + for found, − for written off'),
  })
  .strict();

// ─── Adjustments ────────────────────────────────────────────────────────────────────────

export const createAdjustmentSchema = z
  .object({
    locationId: objectId,
    reason: z.enum(ADJUSTMENT_REASONS),
    note,
    lines: z.array(signedLine).min(1, 'Add at least one line').max(MAX_LINES),
  })
  .strict();

export const updateAdjustmentSchema = createAdjustmentSchema.partial().strict();

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type UpdateAdjustmentInput = z.infer<typeof updateAdjustmentSchema>;

/** Cancelling a *posted* adjustment writes reversing movements — and says why. */
export const cancelDocSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why').max(300) })
  .strict();

export type CancelDocInput = z.infer<typeof cancelDocSchema>;

// ─── Transfers ──────────────────────────────────────────────────────────────────────────

const transferShape = {
  fromLocationId: objectId,
  toLocationId: objectId,
  /**
   * A `TRANSIT` location to hold the goods between dispatch and receipt — the bus or courier
   * leg. Null is a direct transfer: both legs post together.
   */
  transitLocationId: objectId.nullable().optional(),
  note,
  lines: z.array(positiveLine).min(1, 'Add at least one line').max(MAX_LINES),
};

function checkDistinct(
  v: { fromLocationId?: string; toLocationId?: string; transitLocationId?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.fromLocationId && v.fromLocationId === v.toLocationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toLocationId'],
      message: 'Choose a different destination',
    });
  }
  if (v.transitLocationId && [v.fromLocationId, v.toLocationId].includes(v.transitLocationId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transitLocationId'],
      message: 'The transit location must differ from both ends',
    });
  }
}

export const createTransferSchema = z.object(transferShape).strict().superRefine(checkDistinct);
export const updateTransferSchema = z
  .object(transferShape)
  .partial()
  .strict()
  .superRefine(checkDistinct);

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type UpdateTransferInput = z.infer<typeof updateTransferSchema>;

// ─── Counts ─────────────────────────────────────────────────────────────────────────────

/**
 * Opening a count **freezes** what it covers: `ALL` stock at the location, or only the listed
 * products. Freezing is what lets the counters count a shelf that is not changing under them.
 */
export const createCountSchema = z
  .object({
    locationId: objectId,
    scope: z.enum(['ALL', 'PRODUCTS']),
    productIds: z.array(objectId).max(MAX_LINES).optional(),
    note,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === 'PRODUCTS' && (!v.productIds || v.productIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productIds'],
        message: 'Choose the products to count',
      });
    }
  });

export type CreateCountInput = z.infer<typeof createCountSchema>;

/**
 * What the counters found, line by line. May be sent in several batches as aisles are finished;
 * a later value for the same line replaces an earlier one. An item not on the sheet — found on
 * the wrong shelf — is added with an expected quantity of zero.
 */
export const recordCountSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            ...lineBase,
            /** What is physically there, in `uomCode`. Zero is a real answer: none found. */
            countedQty: z.number().int('Whole units only').min(0).max(10_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_LINES),
  })
  .strict();

export type RecordCountInput = z.infer<typeof recordCountSchema>;

export const postCountSchema = z
  .object({
    /**
     * Post with lines still uncounted, leaving those items as they are. Off by default: an
     * uncounted line is far more often a missed shelf than a deliberate choice.
     */
    skipUncounted: z.boolean().optional(),
  })
  .strict();

export type PostCountInput = z.infer<typeof postCountSchema>;
