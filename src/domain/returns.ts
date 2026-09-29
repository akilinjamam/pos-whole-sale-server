/**
 * What returned units are worth — pure, so the rounding is a unit test.
 *
 * A line's value is its **net** total (its own discount and its share of the order discount
 * already taken off), so a customer never gets back more than they paid for those units.
 *
 * Proration uses cumulative rounding: the value of the next `qty` units is
 * `round(total × (before + qty) / Q) − round(total × before / Q)`. Returning a line in any number
 * of pieces therefore adds up to exactly its total — no poisha lost or invented along the way.
 */
export function returnValueMinor(
  line: { lineTotalMinor: number; qtyBase: number; qtyReturnedBase: number },
  qtyBase: number,
): number {
  if (!Number.isInteger(qtyBase) || qtyBase < 1) throw new RangeError('qtyBase must be ≥ 1');
  const before = line.qtyReturnedBase;
  if (before + qtyBase > line.qtyBase) throw new RangeError('More than was sold');
  const at = (n: number) => Math.round((line.lineTotalMinor * n) / line.qtyBase);
  return at(before + qtyBase) - at(before);
}
