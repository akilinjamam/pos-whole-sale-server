/**
 * Warranty and expiry arithmetic — pure, on `YYYY-MM-DD` strings, so the rules are unit tests and
 * no time zone can move a date.
 *
 * A warranty starts on the day a unit is **sold**, not the day it was received: a machine that
 * sits in the warehouse for eight months has not used eight months of its customer's warranty.
 */

import type { WarrantyState } from '../shared/enums.js';

/**
 * `YYYY-MM-DD` + n calendar months, clamped to the month's last day — 31 Jan + 1 month is
 * 28 (or 29) Feb, not 3 March, which is what a naive `setMonth` gives and what a customer would
 * reasonably dispute.
 */
export function addMonths(day: string, months: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + months;
  const d = Number(day.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month, Math.min(d, lastDay)));
  return date.toISOString().slice(0, 10);
}

/**
 * The last day the warranty covers, inclusive: a 12-month warranty sold on 15 Mar 2026 covers up
 * to and including 14 Mar 2027.
 */
export function warrantyEndDay(startDay: string, months: number): string {
  const end = new Date(`${addMonths(startDay, months)}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export interface WarrantyInfo {
  state: WarrantyState;
  /** Inclusive last day, when there is a warranty and it has started. */
  endsOn: string | null;
  /** Days left including today; 0 once expired; null when not applicable. */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Where a unit's warranty stands on `today`.
 *
 *  - NONE — the product carries no warranty;
 *  - NOT_STARTED — it has one, but the unit has not been sold;
 *  - ACTIVE / EXPIRED — sold, and today is within / past the covered period.
 */
export function warrantyStatus(
  unit: { warrantyMonths: number | null; warrantyStartDay: string | null },
  today: string,
): WarrantyInfo {
  if (!unit.warrantyMonths) return { state: 'NONE', endsOn: null, daysLeft: null };
  if (!unit.warrantyStartDay) return { state: 'NOT_STARTED', endsOn: null, daysLeft: null };

  const endsOn = warrantyEndDay(unit.warrantyStartDay, unit.warrantyMonths);
  const left = daysBetween(today, endsOn) + 1;
  return left > 0
    ? { state: 'ACTIVE', endsOn, daysLeft: left }
    : { state: 'EXPIRED', endsOn, daysLeft: 0 };
}

/**
 * A lot's expiry when only its manufacture date is known: mfg + shelf life. An explicit expiry
 * printed on the box always wins over this — it is only a default.
 */
export function expiryFromShelfLife(mfgDay: string, shelfLifeDays: number): string {
  const d = new Date(`${mfgDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + shelfLifeDays);
  return d.toISOString().slice(0, 10);
}

/** Days until a lot expires, from `today`: negative once expired, 0 on its last day. */
export function daysToExpiry(expiryDay: string, today: string): number {
  return daysBetween(today, expiryDay);
}
