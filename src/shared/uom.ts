/**
 * Unit-of-measure conversion — two-level, multiplier only.
 *
 * Optical wholesale quotes frames by the dozen and ships cartons, but **all stock, ledgers,
 * costing and reports are in base units, always** (§6.5). `Product.baseUom` is the atomic unit;
 * `Product.packs[]` declares multiplier-only aliases — `DOZ` ×12, `CTN` ×144.
 *
 * Every order, GRN and invoice line stores both sides:
 *
 *     { uomCode: 'DOZ', uomQty: 5, qtyBase: 60, unitPriceMinor: /* per DOZ *\/ }
 *
 * `qtyBase` is computed here, server-side, and is the only number the stock engine ever sees.
 * A dealer ordering "5 dozen" and the system recording 5 pieces is a business-ending bug, so
 * the conversion lives in one shared function rather than being re-derived per call site.
 *
 * Shared, because the client needs the same arithmetic to show "5 DOZ = 60 PCS" as the user
 * types — and a client that computed it differently would display one number and post another.
 *
 * **Not** a general UoM engine: there is no kg→g, no unit graph, no dimensional analysis. Two
 * levels and an integer multiplier is what the trade actually uses, and anything more would be
 * machinery nobody asked for standing between a cashier and a sale.
 */

/** The shape this module needs from a product — so it works on payloads and documents alike. */
export interface PackLike {
  code: string;
  name: string;
  /** Base units per pack. Always an integer ≥ 2 — a pack of one is the base unit renamed. */
  factor: number;
  barcode?: string | null;
}

export interface UomCarrier {
  baseUom: string;
  packs: readonly PackLike[];
}

/** Thrown for a UoM the product does not declare, or a quantity that cannot be whole. */
export class UomError extends Error {
  readonly code: 'UNKNOWN_UOM' | 'FRACTIONAL_PACK';

  constructor(code: UomError['code'], message: string) {
    super(message);
    this.name = 'UomError';
    this.code = code;
  }
}

/**
 * Base units in one unit of `uomCode`, or null if the product does not declare it.
 *
 * The base unit itself is factor 1 and is always valid without being listed in `packs`.
 */
export function packFactor(product: UomCarrier, uomCode: string): number | null {
  if (uomCode === product.baseUom) return 1;
  const pack = product.packs.find((p) => p.code === uomCode);
  return pack ? pack.factor : null;
}

/** Every unit this product can be transacted in, base first. */
export function uomOptions(
  product: UomCarrier,
): { code: string; factor: number; name: string }[] {
  return [
    { code: product.baseUom, factor: 1, name: product.baseUom },
    ...product.packs.map((p) => ({ code: p.code, factor: p.factor, name: p.name })),
  ];
}

/**
 * `5 DOZ` → `60` base units.
 *
 * Rejects a fractional pack quantity outright. "1.5 dozen" is 18 pieces and would convert
 * cleanly, but it is not how the trade orders, and allowing it means every downstream
 * `qtyBase` has to be re-checked for integrality — including the ones that arrive by CSV
 * import or API. Refusing once, here, is what keeps `qtyBase` an integer everywhere.
 */
export function toBase(qty: number, uomCode: string, product: UomCarrier): number {
  const factor = packFactor(product, uomCode);

  if (factor === null) {
    throw new UomError(
      'UNKNOWN_UOM',
      `${uomCode} is not a unit of this product (${uomOptions(product)
        .map((u) => u.code)
        .join(', ')})`,
    );
  }

  if (!Number.isInteger(qty)) {
    throw new UomError(
      'FRACTIONAL_PACK',
      `Quantity must be a whole number of ${uomCode} — ${qty} is not`,
    );
  }

  return qty * factor;
}

/**
 * `60` base units → `5 DOZ`.
 *
 * **May return a fraction**, and deliberately so: this is the display direction, and 66 pieces
 * genuinely is 5.5 dozen. Anything posting a document converts the other way, through `toBase`,
 * which is where whole packs are enforced.
 */
export function fromBase(qtyBase: number, uomCode: string, product: UomCarrier): number {
  const factor = packFactor(product, uomCode);

  if (factor === null) {
    throw new UomError('UNKNOWN_UOM', `${uomCode} is not a unit of this product`);
  }

  // Two decimals: enough to show a half or a quarter dozen, without float noise like 5.499999.
  return Math.round((qtyBase / factor) * 100) / 100;
}

/** Does this many base units divide exactly into whole `uomCode` packs? */
export function isWholePacks(qtyBase: number, uomCode: string, product: UomCarrier): boolean {
  const factor = packFactor(product, uomCode);
  if (factor === null || factor === 0) return false;
  return Number.isInteger(qtyBase) && qtyBase % factor === 0;
}

/**
 * Break base units into the largest packs that fit, then the remainder.
 *
 * `150` pieces of a frame with CTN ×144 and DOZ ×12 → `1 CTN, 0 DOZ, 6 PCS`, reported as only
 * the non-zero parts. Used for picking lists and stock displays, where "1 carton and 6 pieces"
 * is what the storekeeper is actually looking for on the shelf.
 */
export function splitIntoPacks(
  qtyBase: number,
  product: UomCarrier,
): { code: string; qty: number }[] {
  const descending = [...product.packs]
    .filter((p) => p.factor > 1)
    .sort((a, b) => b.factor - a.factor);

  const parts: { code: string; qty: number }[] = [];
  let left = Math.abs(qtyBase);

  for (const pack of descending) {
    const whole = Math.floor(left / pack.factor);
    if (whole > 0) {
      parts.push({ code: pack.code, qty: whole });
      left -= whole * pack.factor;
    }
  }

  // The remainder in base units — included even when zero if nothing else matched, so the
  // result is never an empty list for a real quantity.
  if (left > 0 || parts.length === 0) {
    parts.push({ code: product.baseUom, qty: left });
  }

  return parts;
}

/** `150` → `"1 CTN + 6 PCS"`. Sign is carried on the whole expression, not each part. */
export function describeQty(qtyBase: number, product: UomCarrier): string {
  const sign = qtyBase < 0 ? '-' : '';
  const parts = splitIntoPacks(qtyBase, product);
  return sign + parts.map((p) => `${p.qty} ${p.code}`).join(' + ');
}

/**
 * Validate a declared pack list.
 *
 * The same three rules the product schema enforces, in one place so the CSV importer and any
 * future API client get exactly the checks the form gets. Returns messages rather than
 * throwing, because the importer reports per row and the form reports per field.
 */
export function validatePacks(
  baseUom: string,
  packs: readonly PackLike[],
): { index: number; field: 'code' | 'factor'; message: string }[] {
  const problems: { index: number; field: 'code' | 'factor'; message: string }[] = [];
  const seen = new Set<string>();

  packs.forEach((pack, index) => {
    if (seen.has(pack.code)) {
      problems.push({
        index,
        field: 'code',
        message: `Already used: a product cannot declare ${pack.code} twice`,
      });
    }
    seen.add(pack.code);

    // A DOZ pack on a DOZ base makes `uomQty × factor` self-referential, and the stock engine —
    // which only ever sees base units — would multiply the base by itself.
    if (pack.code === baseUom) {
      problems.push({ index, field: 'code', message: `${pack.code} is already the base unit` });
    }

    if (!Number.isInteger(pack.factor) || pack.factor < 2) {
      problems.push({
        index,
        field: 'factor',
        message: 'Must be a whole number of at least 2',
      });
    }
  });

  return problems;
}
