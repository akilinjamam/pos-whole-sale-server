import { Schema, model } from 'mongoose';

import { Org } from '../modules/org/org.model.js';

import { dayIn } from './period.js';

import type { DocSeries } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * Atomic sequences, one document per `(org, series, period)`.
 *
 * `nextSequence` is the primitive; `nextDocNo` below adds fiscal-year periods (Day 14). Day 17
 * adds configurable number series on top, and **must keep the key format**: party codes already issued live in the
 * `…:DLR:ALL` document, and a different key would restart them at 1 and collide with every one.
 */
interface CounterDoc {
  /** `${orgId}:${series}:${period}` — see `counterKey`. */
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, collection: 'counters' },
);

export const Counter = model<CounterDoc>('Counter', counterSchema);

/** `'ALL'` is the period of a series that never resets. */
export function counterKey(orgId: Types.ObjectId, series: DocSeries, period = 'ALL'): string {
  return `${String(orgId)}:${series}:${period}`;
}

/**
 * The next number in a sequence, starting at 1.
 *
 * A single `findOneAndUpdate` with `$inc` is atomic, so two concurrent callers can never be
 * handed the same number. Pass the caller's `session` and the increment joins its transaction:
 * if the insert that consumes the number aborts, the increment is rolled back with it and the
 * number is never lost.
 */
export async function nextSequence(key: string, session?: ClientSession): Promise<number> {
  const counter = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  ).lean();

  // `upsert` + `new` always returns a document; the check narrows the type honestly rather
  // than asserting it.
  if (!counter) throw new Error(`Counter ${key} did not return a value`);
  return counter.seq;
}

// ─── Document numbers ───────────────────────────────────────────────────────────────────

/**
 * The fiscal year a day falls in, as the label documents carry.
 *
 * Bangladesh's fiscal year runs July–June, so 15 Aug 2026 is FY 2026–27 → `2627`. With a January
 * start the fiscal year *is* the calendar year → `2026`. Pure, and on a `YYYY-MM-DD` string, so
 * the caller decides the time zone (see `dayIn`).
 */
export function fiscalYearLabel(day: string, startMonth: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (startMonth === 1) return String(year);
  const start = month >= startMonth ? year : year - 1;
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`;
}

export const DOC_NO_PADDING = 5;

export function formatDocNo(series: DocSeries, period: string, seq: number): string {
  return `${series}-${period}-${String(seq).padStart(DOC_NO_PADDING, '0')}`;
}

/**
 * The next number in a yearly-reset series — `ADJ-2627-00001`.
 *
 * Minimal on purpose: Day 17 adds the configurable `NumberSeries` (prefixes, padding, reset
 * policy per series) on top of this, keeping the counter key `${orgId}:${series}:${fy}` so no
 * number already issued is ever issued again.
 *
 * **Must be called inside the posting transaction.** The increment joins the caller's session,
 * so a post that fails after taking a number gives it back, and drafts — which have no number —
 * never consume one. That is what keeps the sequence gapless.
 */
export async function nextDocNo(
  session: ClientSession,
  orgId: Types.ObjectId,
  series: DocSeries,
  at: Date,
): Promise<string> {
  const org = await Org.findById(orgId)
    .select('timeZone fiscalYearStartMonth')
    .session(session)
    .lean();
  const day = dayIn(at, org?.timeZone ?? 'Asia/Dhaka');
  const period = fiscalYearLabel(day, org?.fiscalYearStartMonth ?? 7);
  const seq = await nextSequence(counterKey(orgId, series, period), session);
  return formatDocNo(series, period, seq);
}
