import { Schema, model } from 'mongoose';

import { NumberSeries } from '../modules/numberSeries/numberSeries.model.js';
import { Org } from '../modules/org/org.model.js';
import { defaultSeriesConfig, formatNumber, periodFor } from '../shared/numbering.js';

import { dayIn } from './period.js';

import type { DocSeries } from '@shared/enums.js';
import type { SeriesConfig } from '@shared/numbering.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * Atomic sequences, one document per `(org, series, period)`.
 *
 * `nextSequence` is the primitive; `nextDocNo` below adds periods and the org's configured format
 * (`NumberSeries`, Day 17). The key format `${orgId}:${series}:${period}` is permanent: party codes
 * live in `…:DLR:ALL` and every yearly series in `…:<SERIES>:<fy>`, and a different key would
 * restart them at 1 and collide with every number already issued.
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

/** A number in the *default* format — `ADJ-2627-00007`. Kept for tests and callers that need no config. */
export function formatDocNo(series: DocSeries, period: string, seq: number): string {
  return formatNumber(defaultSeriesConfig(series), period, seq);
}

/** The org's configuration for a series, or the default when it has none. */
export async function seriesConfig(
  orgId: Types.ObjectId,
  series: DocSeries,
  session?: ClientSession,
): Promise<SeriesConfig> {
  const q = NumberSeries.findOne({ orgId, series }).select(
    'prefix padding resetPolicy separator',
  );
  const row = await (session ? q.session(session) : q).lean();
  return row
    ? {
        prefix: row.prefix,
        padding: row.padding,
        resetPolicy: row.resetPolicy,
        separator: row.separator,
      }
    : defaultSeriesConfig(series);
}

/** The period a document dated `at` falls in, for this org and series policy. */
async function periodOf(
  orgId: Types.ObjectId,
  cfg: SeriesConfig,
  at: Date,
  session?: ClientSession,
): Promise<string> {
  const q = Org.findById(orgId).select('timeZone fiscalYearStartMonth');
  const org = await (session ? q.session(session) : q).lean();
  const day = dayIn(at, org?.timeZone ?? 'Asia/Dhaka');
  return periodFor(cfg.resetPolicy, day, fiscalYearLabel(day, org?.fiscalYearStartMonth ?? 7));
}

/**
 * The next number in a series — `WS-2627-00042` by default, or as the org has configured it.
 *
 * The three properties §10 asks of numbering:
 *  1. **Atomic** — one `$inc` on the counter document; two posts can never get the same number.
 *  2. **Transactional** — the increment joins the caller's session, so a post that fails after
 *     taking a number gives it back. That, plus drafts carrying no number, keeps series gapless.
 *  3. **Backstopped** — every numbered collection has a unique index on its number, so even a
 *     bug here would surface as a 409, never as two invoices with one number.
 *
 * **Must be called inside the posting transaction.**
 */
export async function nextDocNo(
  session: ClientSession,
  orgId: Types.ObjectId,
  series: DocSeries,
  at: Date,
): Promise<string> {
  const cfg = await seriesConfig(orgId, series, session);
  const period = await periodOf(orgId, cfg, at, session);
  const seq = await nextSequence(counterKey(orgId, series, period), session);
  return formatNumber(cfg, period, seq);
}

/**
 * The number the next post *would* get — for a settings preview. Reads the counter without
 * incrementing it, so it is a forecast: a concurrent post may take it first.
 */
export async function peekDocNo(
  orgId: Types.ObjectId,
  series: DocSeries,
  at: Date,
): Promise<string> {
  const cfg = await seriesConfig(orgId, series);
  const period = await periodOf(orgId, cfg, at);
  const counter = await Counter.findById(counterKey(orgId, series, period)).lean();
  return formatNumber(cfg, period, (counter?.seq ?? 0) + 1);
}
