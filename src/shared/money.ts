/**
 * Money handling — integer MINOR units (poisha) everywhere.
 *
 * Every money field in the database and in every API payload is an integer number of minor
 * units, and every such field name ends in `Minor`. Nothing anywhere stores a float amount.
 *
 * Why not Decimal128: it round-trips through Mongoose as an object rather than a JS number,
 * JSON.stringify emits {"$numberDecimal":"…"} into every response, every aggregation operator
 * needs $toDecimal, and every client render needs a parse. Integer minor units $sum, $gte and
 * sort natively, are exact, and JS safe integers cover ৳90,000,000,000 — four orders of
 * magnitude beyond this business.
 */

/** Minor units per major unit. 100 poisha = 1 taka. */
export const MINOR_UNITS = 100;

/** Largest amount we will accept, as a guard against overflow and fat-finger input. */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/** Round half away from zero. JS Math.round rounds -0.5 to -0, which is wrong for money. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Major units (taka, possibly fractional) → minor units (integer poisha). */
export function toMinor(major: number | string): number {
  const n = typeof major === 'string' ? Number(major) : major;
  if (!Number.isFinite(n)) {
    throw new TypeError(`toMinor: not a finite number: ${String(major)}`);
  }
  const minor = roundHalfUp(n * MINOR_UNITS);
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`toMinor: amount out of safe range: ${String(major)}`);
  }
  return minor;
}

/** Minor units → major units. For display and export only — never for further arithmetic. */
export function fromMinor(minor: number): number {
  assertMinor(minor);
  return minor / MINOR_UNITS;
}

/** Throws unless the value is a valid minor-unit amount. */
export function assertMinor(minor: number): asserts minor is number {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`Expected integer minor units, received ${String(minor)}`);
  }
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Minor amount out of safe range: ${String(minor)}`);
  }
}

export interface FormatMoneyOptions {
  /** Currency symbol to prefix. Pass '' for a bare number. Default '৳'. */
  symbol?: string;
  /** Group thousands. Default true. */
  grouping?: boolean;
  /** Always show minor digits, even when zero. Default true. */
  alwaysShowMinor?: boolean;
}

/** Format minor units for display: 123456 → "৳1,234.56". */
export function formatMoney(minor: number, options: FormatMoneyOptions = {}): string {
  const { symbol = '৳', grouping = true, alwaysShowMinor = true } = options;
  assertMinor(minor);

  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / MINOR_UNITS);
  const rest = abs % MINOR_UNITS;

  const majorText = grouping ? major.toLocaleString('en-US') : String(major);
  const showMinor = alwaysShowMinor || rest !== 0;
  const restText = showMinor ? `.${String(rest).padStart(2, '0')}` : '';

  return `${negative ? '-' : ''}${symbol}${majorText}${restText}`;
}

/**
 * Split `totalMinor` across `weights` so the parts sum EXACTLY to the total.
 *
 * Used to prorate an order-level discount down to lines. Naive per-line rounding leaves stray
 * poisha and makes sum(lines) !== header total; the largest-remainder method gives every
 * leftover unit to the lines with the largest fractional parts, so the identity always holds.
 *
 * Returns an array of minor amounts, one per weight, in the same order.
 */
export function prorate(totalMinor: number, weights: readonly number[]): number[] {
  assertMinor(totalMinor);

  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) {
    throw new RangeError('prorate: weights must be non-negative');
  }

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Nothing to weight by — spread as evenly as possible, remainder to the earliest slots.
  if (totalWeight === 0) {
    const base = Math.trunc(totalMinor / weights.length);
    const parts = weights.map(() => base);
    let leftover = totalMinor - base * weights.length;
    const step = leftover < 0 ? -1 : 1;
    for (let i = 0; leftover !== 0; i = (i + 1) % parts.length) {
      parts[i] += step;
      leftover -= step;
    }
    return parts;
  }

  const exact = weights.map((w) => (totalMinor * w) / totalWeight);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = totalMinor - floors.reduce((sum, v) => sum + v, 0);

  // Hand out the remaining units to the largest fractional parts first.
  const order = exact
    .map((v, index) => ({ index, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const parts = [...floors];
  for (let i = 0; remainder > 0; i += 1, remainder -= 1) {
    parts[order[i % order.length].index] += 1;
  }
  return parts;
}

/** Apply a percentage discount to a minor amount, rounded once. */
export function applyPct(minor: number, pct: number): number {
  assertMinor(minor);
  if (!Number.isFinite(pct)) throw new TypeError(`applyPct: bad percentage ${String(pct)}`);
  return roundHalfUp((minor * pct) / 100);
}

/** Sum minor amounts with an overflow guard. */
export function sumMinor(amounts: readonly number[]): number {
  const total = amounts.reduce((sum, a) => {
    assertMinor(a);
    return sum + a;
  }, 0);
  assertMinor(total);
  return total;
}
