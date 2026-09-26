/**
 * Price tiers and price-list entries — the input schemas and the two pieces of arithmetic both
 * sides must agree on exactly: when two validity windows overlap, and what a bulk % adjustment
 * turns a price into.
 *
 * §6.6 of the project plan. The *resolution* of a price (dealer → tier → retail → product
 * default) is Day 12's `domain/pricing.ts`; this file only describes what can be stored.
 *
 * An entry is scoped to **exactly one** of a tier or a dealer. A dealer-specific price is an
 * override for that dealer alone and needs no tier; a tier price applies to every dealer on the
 * tier. Keeping the two apart is what lets the resolver say *which* rule produced a price.
 *
 * Money is **minor units** on the wire, as everywhere else. The CSV importer converts from the
 * major units people type before sending.
 */

import { z } from 'zod';

import { roundHalfUp } from './money.js';

// ─── Building blocks ────────────────────────────────────────────────────────────────────

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/** A price. Zero is allowed — a free sample line is a real thing — negative is not. */
const priceMinor = z.number().int('Whole minor units only').min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The smallest quantity, **in the entry's own `uomCode`**, at which the price applies. `3` on a
 * DOZ entry means "from 3 dozen". Qty breaks are several entries differing only in `minQty`.
 */
const minQty = z.number().int('Whole units only').min(1, 'At least 1').max(1_000_000);

/** `YYYY-MM-DD`, inclusive at both ends. `null` is open: "since always" / "until further notice". */
const day = z.string().date('Use YYYY-MM-DD');

// ─── Tiers ──────────────────────────────────────────────────────────────────────────────

export const createPriceTierSchema = z
  .object({
    /** Stable key for imports and reports. Immutable once created — see the service. */
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(20)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Capitals, digits and underscores, starting with a letter'),
    name: z.string().trim().min(1, 'Required').max(60),
    description: z.string().trim().max(200).nullable().optional(),
    /** Display order, lowest first. Conventionally retail first, then down the discount ladder. */
    level: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updatePriceTierSchema = createPriceTierSchema.partial().strict();

export type CreatePriceTierInput = z.infer<typeof createPriceTierSchema>;
export type UpdatePriceTierInput = z.infer<typeof updatePriceTierSchema>;

// ─── Scope: a tier, or a dealer ─────────────────────────────────────────────────────────

const scopeFields = {
  tierId: objectId.nullable().optional(),
  partyId: objectId.nullable().optional(),
};

function checkScope(
  value: { tierId?: string | null; partyId?: string | null },
  ctx: z.RefinementCtx,
) {
  const hasTier = Boolean(value.tierId);
  const hasParty = Boolean(value.partyId);
  if (hasTier === hasParty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasTier ? 'partyId' : 'tierId'],
      message: 'Choose either a price tier or a dealer — exactly one',
    });
  }
}

function checkWindow(
  value: { validFrom?: string | null; validTo?: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.validFrom && value.validTo && value.validTo < value.validFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validTo'],
      message: 'Ends before it starts',
    });
  }
}

// ─── Entries ────────────────────────────────────────────────────────────────────────────

export const createPriceEntrySchema = z
  .object({
    ...scopeFields,
    productId: objectId,
    /** Null prices every variant of the product; a variant price wins over it (Day 12). */
    variantId: objectId.nullable().optional(),
    /** The product's base unit or one of its packs. Checked against the product in the service. */
    uomCode: z.string().trim().toUpperCase().min(1).max(10),
    priceMinor,
    minQty: minQty.optional(),
    validFrom: day.nullable().optional(),
    validTo: day.nullable().optional(),
    isActive: z.boolean().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    checkScope(v, ctx);
    checkWindow(v, ctx);
  });

/**
 * What an entry's *identity* is — scope, product, variant, unit — cannot be edited. Changing any
 * of them is a different price, so it is a new entry; editing in place would rewrite what an
 * already-quoted order line claims to have been priced from.
 */
export const updatePriceEntrySchema = z
  .object({
    priceMinor: priceMinor.optional(),
    minQty: minQty.optional(),
    validFrom: day.nullable().optional(),
    validTo: day.nullable().optional(),
    isActive: z.boolean().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .superRefine(checkWindow);

export type CreatePriceEntryInput = z.infer<typeof createPriceEntrySchema>;
export type UpdatePriceEntryInput = z.infer<typeof updatePriceEntrySchema>;

// ─── CSV import ─────────────────────────────────────────────────────────────────────────

export const MAX_IMPORT_ROWS = 2000;

/** One spreadsheet row, already converted to minor units by the client. */
export const priceImportRowSchema = z
  .object({
    /** 1-based line in the file, echoed back so the report points at the right row. */
    line: z.number().int().min(1),
    sku: z.string().trim().toUpperCase().min(1, 'Required').max(40),
    /** A variant's own SKU, when the price is for one variant only. */
    variantSku: z.string().trim().toUpperCase().max(60).nullable().optional(),
    /** Defaults to the product's base unit. */
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    minQty: minQty.optional(),
    priceMinor,
    validFrom: day.nullable().optional(),
    validTo: day.nullable().optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const priceImportSchema = z
  .object({
    ...scopeFields,
    rows: z.array(priceImportRowSchema).min(1, 'The file has no rows').max(MAX_IMPORT_ROWS),
    /** True: validate and report only. False: write every valid row, skip the rest. */
    dryRun: z.boolean(),
  })
  .strict()
  .superRefine(checkScope);

export type PriceImportRow = z.infer<typeof priceImportRowSchema>;
export type PriceImportInput = z.infer<typeof priceImportSchema>;

// ─── Bulk % adjust ──────────────────────────────────────────────────────────────────────

/** Round-to steps offered in the UI, in minor units: none, ৳1, ৳5, ৳10, ৳50, ৳100. */
export const ROUNDING_STEPS = [1, 100, 500, 1000, 5000, 10000] as const;

export const bulkAdjustSchema = z
  .object({
    ...scopeFields,
    /** −90 … +500. A 100% cut would zero the price list, which is never what anyone meant. */
    pct: z
      .number()
      .min(-90)
      .max(500)
      .refine((v) => v !== 0, 'A 0% change changes nothing'),
    roundToMinor: z
      .number()
      .int()
      .refine((v) => (ROUNDING_STEPS as readonly number[]).includes(v), 'Not a rounding step'),
    /** Narrow the adjustment; omit all three for the whole tier. */
    brandId: objectId.nullable().optional(),
    categoryId: objectId.nullable().optional(),
    productType: z.string().trim().max(20).nullable().optional(),
    dryRun: z.boolean(),
  })
  .strict()
  .superRefine(checkScope);

export type BulkAdjustInput = z.infer<typeof bulkAdjustSchema>;

/**
 * A price after a % change, rounded to the nearest `roundToMinor` — half up, so ৳4,525 rounded
 * to ৳50 is ৳4,550 on both sides of the wire. Never below one step: a 90% cut on a ৳3 item
 * rounded to ৳5 would otherwise become free.
 */
export function adjustPrice(priceMinor: number, pct: number, roundToMinor: number): number {
  const raw = (priceMinor * (100 + pct)) / 100;
  const rounded = roundHalfUp(raw / roundToMinor) * roundToMinor;
  return priceMinor === 0 ? 0 : Math.max(roundToMinor, rounded);
}

// ─── Validity windows ───────────────────────────────────────────────────────────────────

export interface ValidityWindow {
  /** `YYYY-MM-DD` or null (open). */
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Whether two inclusive windows share at least one day. `null` ends are open.
 *
 * ISO dates compare correctly as strings, so no Date parsing — and no time zone — is involved.
 * That matters: a price valid "until 31 March" must not stop at 18:00 on the 30th because a
 * browser in Dhaka converted midnight UTC.
 */
export function windowsOverlap(a: ValidityWindow, b: ValidityWindow): boolean {
  const startsBeforeOtherEnds = !a.validFrom || !b.validTo || a.validFrom <= b.validTo;
  const otherStartsBeforeThisEnds = !b.validFrom || !a.validTo || b.validFrom <= a.validTo;
  return startsBeforeOtherEnds && otherStartsBeforeThisEnds;
}
