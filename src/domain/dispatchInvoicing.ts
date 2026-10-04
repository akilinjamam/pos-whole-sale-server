/**
 * Invoicing part of an order line — Day 24, invoice-per-dispatch (§7).
 *
 * A dealer orders 10 dozen at a negotiated price with a prorated order discount, and it ships in
 * three challans of 4, 3 and 3 dozen. Each challan raises its own invoice for what left the
 * building. The three invoices must add up to the order line **exactly** — a poisha astray on a
 * dealer's statement is a discrepancy someone has to explain.
 *
 * Rounding each portion on its own does not guarantee that (⅓ + ⅓ + ⅓ of an odd amount). Rounding
 * the **cumulative** share does: invoice *k* is `share(after k) − share(after k−1)`, so the sum
 * over all invoices telescopes to `share(everything) = the line total`. Pure, so it is a unit test.
 */

export interface InvoiceableLine {
  /** Ordered, in base units. */
  qtyBase: number;
  /** Already invoiced, in base units — by earlier dispatches. */
  qtyInvoicedBase: number;
  /** The order line's total after all its discounts. */
  lineTotalMinor: number;
  /** The order line's discount (its own plus its share of the order discount). */
  discountMinor: number;
}

export interface InvoicePortion {
  grossMinor: number;
  discountMinor: number;
  /** gross − discount, exactly. */
  netMinor: number;
}

export class InvoicingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoicingError';
  }
}

/** round-half-up(amount × part ÷ whole), in exact integer arithmetic — no float, no overflow. */
function share(amountMinor: number, part: number, whole: number): number {
  const num = 2n * BigInt(amountMinor) * BigInt(part) + BigInt(whole);
  return Number(num / (2n * BigInt(whole)));
}

/** The money for invoicing `qtyBase` more base units of `line`. */
export function invoicePortion(line: InvoiceableLine, qtyBase: number): InvoicePortion {
  if (!Number.isInteger(qtyBase) || qtyBase < 1) {
    throw new InvoicingError('Invoice at least one whole unit');
  }
  const before = line.qtyInvoicedBase;
  const after = before + qtyBase;
  if (after > line.qtyBase) {
    throw new InvoicingError(
      `Invoicing ${qtyBase} would take the line past its ordered ${line.qtyBase}`,
    );
  }
  const grossTotal = line.lineTotalMinor + line.discountMinor;
  const grossMinor =
    share(grossTotal, after, line.qtyBase) - share(grossTotal, before, line.qtyBase);
  const discountMinor =
    share(line.discountMinor, after, line.qtyBase) -
    share(line.discountMinor, before, line.qtyBase);
  return { grossMinor, discountMinor, netMinor: grossMinor - discountMinor };
}

/**
 * How a dispatched quantity reads on the invoice. In the order's unit when it divides evenly
 * (2 DOZ), otherwise in base units at the per-piece price (18 PCS at ৳60) — the line total, from
 * `invoicePortion`, is what is charged either way.
 */
export function invoiceQuantity(
  qtyBase: number,
  order: { uomCode: string; factor: number; unitPriceMinor: number },
  baseUom: string,
): { uomCode: string; uomQty: number; unitPriceMinor: number } {
  if (order.factor <= 1 || qtyBase % order.factor === 0) {
    return {
      uomCode: order.uomCode,
      uomQty: qtyBase / Math.max(order.factor, 1),
      unitPriceMinor: order.unitPriceMinor,
    };
  }
  return {
    uomCode: baseUom,
    uomQty: qtyBase,
    unitPriceMinor: share(order.unitPriceMinor, 1, order.factor),
  };
}
