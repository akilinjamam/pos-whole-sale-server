import { Schema, model } from 'mongoose';

import type { DocSeries } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * Atomic sequences, one document per `(org, series, period)`.
 *
 * Day 9 needs only the never-resetting party-code series, so this holds just the primitive.
 * Day 17 builds `nextDocNo` — number-series config, yearly periods, formatting — on top of
 * `nextSequence`, and **must keep the key format**: party codes already issued live in the
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
