/**
 * Stock input schemas — Day 13: the opening-stock import.
 *
 * Quantities arrive in the unit the spreadsheet uses (`DOZ`, `CTN`, …) and are converted to base
 * units server-side by `toBase`, which refuses a fractional pack. The stock engine only ever
 * sees base units (§6.5); the unit exists for the person typing the sheet.
 */

import { z } from 'zod';

import type { StockMovementType } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const MAX_OPENING_ROWS = 5000;

export const openingRowSchema = z
  .object({
    /** 1-based line in the file, echoed back in the report. */
    line: z.number().int().min(1),
    sku: z.string().trim().toUpperCase().min(1, 'Required').max(40),
    variantSku: z.string().trim().toUpperCase().max(60).nullable().optional(),
    /** Defaults to the product's base unit. */
    uomCode: z.string().trim().toUpperCase().max(10).nullable().optional(),
    /** In `uomCode`. Opening stock of zero is not a movement — leave the row out. */
    qty: z.number().int('Whole units only').min(1, 'At least 1').max(10_000_000),
    /**
     * Cost per **base unit**, minor units. Needs `stock:viewCost` — a user who may not see costs
     * may not set them either. Omitted, the stock is valued at zero until the first receipt.
     */
    unitCostMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .strict();

export const openingImportSchema = z
  .object({
    locationId: objectId,
    /** The cutover date, `YYYY-MM-DD`. Defaults to today in the org's time zone. */
    asOf: z.string().date('Use YYYY-MM-DD').optional(),
    rows: z.array(openingRowSchema).min(1, 'The file has no rows').max(MAX_OPENING_ROWS),
    dryRun: z.boolean(),
  })
  .strict();

export type OpeningRow = z.infer<typeof openingRowSchema>;
export type OpeningImportInput = z.infer<typeof openingImportSchema>;

/**
 * The sign each movement type must carry. `ADJUSTMENT` and `COUNT` go either way — a count finds
 * more or fewer than expected. Checked by `stock.service` on every posting, so a caller that
 * sends a positive SALE is refused rather than quietly *adding* stock.
 */
export const MOVEMENT_SIGN = {
  OPENING: 'IN',
  GRN: 'IN',
  SALE_RETURN: 'IN',
  TRANSFER_IN: 'IN',
  SALE: 'OUT',
  PURCHASE_RETURN: 'OUT',
  TRANSFER_OUT: 'OUT',
  DAMAGE: 'OUT',
  ADJUSTMENT: 'EITHER',
  COUNT: 'EITHER',
} as const satisfies Record<StockMovementType, 'IN' | 'OUT' | 'EITHER'>;
