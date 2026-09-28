/**
 * Dates as the business sees them — in the org's time zone, not the server's.
 *
 * A sale rung up at 00:30 in Dhaka is 18:30 the previous day in UTC. Bucketing it by UTC would
 * put it in yesterday's Z-report and, on the last night of a month, in last month's VAT return.
 */

function parts(date: Date, timeZone: string): { year: string; month: string; day: string } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** `YYYY-MM-DD` in the org's zone. */
export function dayIn(date: Date, timeZone: string): string {
  const { year, month, day } = parts(date, timeZone);
  return `${year}-${month}-${day}`;
}

/**
 * `YYYYMM` as a number, in the org's zone — the `periodKey` every ledger row carries (§6.1), so
 * "this month" is an indexed equality rather than a date-range scan.
 */
export function periodKeyOf(date: Date, timeZone: string): number {
  const { year, month } = parts(date, timeZone);
  return Number(`${year}${month}`);
}

/** How far `timeZone` is ahead of UTC at `date`, in milliseconds. */
function offsetMs(date: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const n = (type: string) => Number(f.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour'),
    n('minute'),
    n('second'),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant a business day **starts** in the org's zone: `2026-07-01` in Dhaka is
 * 2026-06-30T18:00Z. What a `from` filter compares against, and what `to + 1 day` ends at.
 */
export function startOfDayIn(day: string, timeZone: string): Date {
  const guess = new Date(`${day}T00:00:00.000Z`);
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

/** `YYYY-MM-DD` + n days, calendar arithmetic with no time zone involved. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` ↔ a Date at UTC midnight — for **calendar days** (price validity, expiry, warranty
 * end), which have no time of day and no zone. Never local time: a browser in Dhaka turning
 * midnight UTC into 06:00 is how "valid until 31 March" becomes "until 30 March".
 */
export function dayToDate(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export function dateToDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
