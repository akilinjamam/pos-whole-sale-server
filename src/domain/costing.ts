/**
 * Moving-average costing — §6.7. Pure: no database.
 *
 * One average per item — `(productId, variantId)` — across every location, updated only when
 * stock arrives at a known cost (a goods receipt; a purchase return, Day 35) and mirrored onto the
 * product (or variant) and every `StockBalance` row of the item. A transfer between warehouses
 * therefore never changes what a frame cost, and a sale anywhere is costed at the same figure.
 *
 * What a receipt costs is its **landed** cost: the supplier's net line value plus its share of
 * the receipt's other charges (freight, clearing, loading), spread by line value.
 */

import { prorate, roundHalfUp } from '../shared/money.js';

export interface CostedStock {
  /** Units on hand, across every location. */
  qtyOnHand: number;
  /** Their average cost per base unit, in minor units. */
  avgCostMinor: number;
}

/**
 * The item's stock today, as one average, from its per-location balance rows. Only rows with
 * stock on them carry weight: a row at zero (or below, with negative stock allowed) has nothing
 * on the shelf to have cost anything.
 */
export function currentCost(rows: readonly CostedStock[]): CostedStock {
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    if (r.qtyOnHand <= 0) continue;
    qty += r.qtyOnHand;
    value += r.qtyOnHand * r.avgCostMinor;
  }
  return { qtyOnHand: qty, avgCostMinor: qty > 0 ? roundHalfUp(value / qty) : 0 };
}

/**
 * The average after `qtyIn` units arrive costing `valueInMinor` in all. With nothing on the shelf
 * — or less than nothing, which has no meaningful cost to blend with — the incoming cost is it.
 */
export function movingAverage(
  before: CostedStock,
  qtyIn: number,
  valueInMinor: number,
): number {
  if (!Number.isInteger(qtyIn) || qtyIn < 1) {
    throw new RangeError('movingAverage: a whole quantity of 1 or more arriving');
  }
  if (!Number.isInteger(valueInMinor) || valueInMinor < 0) {
    throw new RangeError('movingAverage: a whole, non-negative value arriving');
  }
  if (before.qtyOnHand <= 0) return roundHalfUp(valueInMinor / qtyIn);
  return roundHalfUp(
    (before.qtyOnHand * before.avgCostMinor + valueInMinor) / (before.qtyOnHand + qtyIn),
  );
}

/**
 * Each line's landed value: its net value plus its share of `otherChargesMinor`, spread by net
 * value with the largest-remainder method, so the lines add up to the receipt exactly. A receipt
 * of free goods only (every line at zero) spreads the charges evenly.
 */
export function landedValues(
  lineNetMinor: readonly number[],
  otherChargesMinor: number,
): number[] {
  const shares = prorate(otherChargesMinor, lineNetMinor);
  return lineNetMinor.map((net, i) => net + shares[i]!);
}
