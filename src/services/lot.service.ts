import { ApiError } from '../lib/ApiError.js';
import { dateToDay, dayToDate } from '../lib/period.js';
import { Lot } from '../modules/lot/lot.model.js';

import type { LotDoc } from '../modules/lot/lot.model.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * Turning a lot *number* on a document line into a `Lot`, at post time, inside the posting
 * transaction.
 *
 * Inbound, a new lot number creates the lot with the dates on the box; a known one is reused —
 * but only if the dates agree. The same lot number with a different expiry is two different
 * batches under one label, and quietly keeping either date would sell someone expired stock.
 *
 * Outbound, the lot must already exist: stock cannot leave from a batch that never arrived.
 */

export interface LotRef {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  lotNo: string;
  mfgDate?: Date | null;
  expiryDate?: Date | null;
}

export async function lotForInbound(
  session: ClientSession,
  orgId: Types.ObjectId,
  ref: LotRef,
  actorId: Types.ObjectId,
): Promise<LotDoc> {
  const key = {
    orgId,
    productId: ref.productId,
    variantId: ref.variantId,
    lotNo: ref.lotNo.trim().toUpperCase(),
  };
  const existing = await Lot.findOne(key).session(session).lean();

  if (existing) {
    const stored = dateToDay(existing.expiryDate);
    const given = dateToDay(ref.expiryDate ?? null);
    if (given && stored && given !== stored) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        `Lot ${key.lotNo} is already on file with expiry ${stored}, not ${given}. A different expiry is a different batch — give it its own lot number.`,
        { lotNo: key.lotNo, expiryDate: stored },
      );
    }
    // A lot first recorded without dates learns them from the first document that has them.
    if (!stored && given) {
      await Lot.updateOne(
        { _id: existing._id },
        { $set: { expiryDate: ref.expiryDate, mfgDate: ref.mfgDate ?? existing.mfgDate } },
        { session },
      );
    }
    return existing;
  }

  const [created] = await Lot.create(
    [
      {
        ...key,
        mfgDate: ref.mfgDate ?? null,
        expiryDate: ref.expiryDate ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      },
    ],
    { session },
  );
  return created!.toObject();
}

export async function lotForOutbound(
  session: ClientSession,
  orgId: Types.ObjectId,
  ref: LotRef,
): Promise<LotDoc> {
  const lotNo = ref.lotNo.trim().toUpperCase();
  const lot = await Lot.findOne({
    orgId,
    productId: ref.productId,
    variantId: ref.variantId,
    lotNo,
  })
    .session(session)
    .lean();
  if (!lot) {
    throw ApiError.validation('Validation failed', [
      { path: 'lotNo', message: `No lot ${lotNo} of this product has been received` },
    ]);
  }
  return lot;
}

export { dayToDate as lotDay };
