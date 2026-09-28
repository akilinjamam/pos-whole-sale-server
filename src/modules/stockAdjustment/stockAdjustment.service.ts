import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { postMovements } from '../../services/stock.service.js';
import {
  assertStockLocation,
  lineNames,
  resolveStockLines,
  trackingFor,
} from '../../services/stockLines.js';
import { Location } from '../location/location.model.js';
import { StockLedger } from '../stock/stockLedger.model.js';

import { StockAdjustment, toStockAdjustmentPayload } from './stockAdjustment.model.js';

import type { ListAdjustmentsQuery } from './stockAdjustment.schema.js';
import type { StockAdjustmentDoc } from './stockAdjustment.model.js';
import type {
  CancelDocInput,
  CreateAdjustmentInput,
  UpdateAdjustmentInput,
} from '@shared/stockDocs.js';
import type { RequestActor as StockDocActor } from '../../lib/requestUser.js';
import type { PageMeta, StockAdjustmentPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

const REF_TYPE = 'STOCK_ADJUSTMENT';

async function serialize(
  orgId: Types.ObjectId,
  docs: StockAdjustmentDoc[],
): Promise<StockAdjustmentPayload[]> {
  const [names, locations] = await Promise.all([
    lineNames(
      orgId,
      docs.flatMap((d) => d.lines),
    ),
    Location.find({ orgId, _id: { $in: [...new Set(docs.map((d) => String(d.locationId)))] } })
      .select('name')
      .lean(),
  ]);
  const locationBy = new Map(locations.map((l) => [String(l._id), l.name]));
  return docs.map((d) =>
    toStockAdjustmentPayload(d, {
      lines: names,
      locationName: locationBy.get(String(d.locationId)),
    }),
  );
}

/** Load a document the caller may act on — its location must be one of theirs. */
async function loadForActor(
  actor: StockDocActor,
  id: Types.ObjectId,
): Promise<StockAdjustmentDoc> {
  const doc = await StockAdjustment.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Adjustment');
  assertLocationAllowed(actor.user, String(doc.locationId));
  return doc;
}

function assertDraft(doc: StockAdjustmentDoc): void {
  if (doc.status !== 'DRAFT') {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      `${doc.docNo ?? 'This adjustment'} is ${doc.status.toLowerCase()} — only a draft can be changed`,
    );
  }
}

export async function listAdjustments(
  actor: StockDocActor,
  query: ListAdjustmentsQuery,
): Promise<{ items: StockAdjustmentPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<StockAdjustmentDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;
  if (query.reason) filter.reason = query.reason;

  const { items, meta } = await paginate<StockAdjustmentDoc>(StockAdjustment, {
    filter,
    query,
    sortable: ['createdAt', 'postedAt', 'docNo'],
    searchFields: ['docNo', 'note'],
    defaultSort: { createdAt: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getAdjustment(
  actor: StockDocActor,
  id: Types.ObjectId,
): Promise<StockAdjustmentPayload> {
  const [payload] = await serialize(actor.orgId, [await loadForActor(actor, id)]);
  return payload!;
}

export async function createAdjustment(
  actor: StockDocActor,
  input: CreateAdjustmentInput,
): Promise<StockAdjustmentPayload> {
  await assertStockLocation(actor.orgId, input.locationId, 'locationId');
  const lines = await resolveStockLines(actor.orgId, input.lines, { inboundCreatesLots: true });

  const doc = await StockAdjustment.create({
    orgId: actor.orgId,
    locationId: new Types.ObjectId(input.locationId),
    reason: input.reason,
    note: input.note ?? null,
    lines,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  });
  return getAdjustment(actor, doc._id);
}

export async function updateAdjustment(
  actor: StockDocActor,
  id: Types.ObjectId,
  input: UpdateAdjustmentInput,
): Promise<StockAdjustmentPayload> {
  assertDraft(await loadForActor(actor, id));
  if (input.locationId) {
    assertLocationAllowed(actor.user, input.locationId);
    await assertStockLocation(actor.orgId, input.locationId, 'locationId');
  }
  const lines = input.lines
    ? await resolveStockLines(actor.orgId, input.lines, { inboundCreatesLots: true })
    : undefined;

  const { matchedCount } = await StockAdjustment.updateOne(
    // `status: 'DRAFT'` again: it may have been posted between the load and now.
    { _id: id, orgId: actor.orgId, status: 'DRAFT' },
    {
      $set: {
        ...(input.locationId ? { locationId: new Types.ObjectId(input.locationId) } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(lines ? { lines } : {}),
        updatedBy: actor.actorId,
      },
    },
  );
  if (matchedCount === 0)
    throw ApiError.conflict('ILLEGAL_TRANSITION', 'Only a draft can be changed');
  return getAdjustment(actor, id);
}

/** Drafts only — a posted adjustment is a record, and is cancelled (reversed), not deleted. */
export async function deleteAdjustment(
  actor: StockDocActor,
  id: Types.ObjectId,
): Promise<void> {
  assertDraft(await loadForActor(actor, id));
  await StockAdjustment.deleteOne({ _id: id, orgId: actor.orgId, status: 'DRAFT' });
}

/**
 * Post: allocate `ADJ-…` and write one movement per line, in one transaction.
 *
 * The draft is **claimed first** with a conditional `DRAFT → POSTED` update. A double-click sends
 * two posts; the second matches nothing and is refused, instead of adjusting stock twice. If a
 * movement is then refused — not enough stock to write off — the claim, the number and every
 * earlier movement roll back together.
 */
export async function postAdjustment(
  actor: StockDocActor,
  id: Types.ObjectId,
): Promise<StockAdjustmentPayload> {
  const doc = await loadForActor(actor, id);
  assertDraft(doc);

  await withTransaction(async (session) => {
    const postedAt = new Date();
    const docNo = await nextDocNo(session, actor.orgId, 'ADJ', postedAt);

    const claimed = await StockAdjustment.findOneAndUpdate(
      { _id: id, orgId: actor.orgId, status: 'DRAFT' },
      {
        $set: {
          status: 'POSTED',
          docNo,
          postedAt,
          postedBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already posted');

    await postMovements(session, {
      orgId: actor.orgId,
      postedAt,
      actorId: actor.actorId,
      movements: await Promise.all(
        claimed.lines.map(async (l) => ({
          locationId: claimed.locationId,
          productId: l.productId,
          variantId: l.variantId,
          qtyBase: l.qtyBase,
          movementType: 'ADJUSTMENT' as const,
          refType: REF_TYPE,
          refId: claimed._id,
          refDocNo: docNo,
          narration: `${claimed.reason}${claimed.note ? `: ${claimed.note}` : ''}`,
          ...(await trackingFor(
            session,
            actor.orgId,
            l,
            l.qtyBase > 0 ? 'IN' : 'OUT',
            actor.actorId,
          )),
        })),
      ),
    });
  });

  return getAdjustment(actor, id);
}

/**
 * Cancel a posted adjustment by reversing it.
 *
 * The movements it wrote are found in the ledger by reference and each is answered with its exact
 * opposite, pointing back through `reversalOfId`. Reversing a *found* adjustment takes stock out
 * again, so it is refused like any other outbound movement if the stock has since been sold.
 */
export async function cancelAdjustment(
  actor: StockDocActor,
  id: Types.ObjectId,
  input: CancelDocInput,
): Promise<StockAdjustmentPayload> {
  const doc = await loadForActor(actor, id);
  if (doc.status !== 'POSTED') {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      doc.status === 'DRAFT' ? 'A draft is deleted, not cancelled' : 'Already cancelled',
    );
  }

  await withTransaction(async (session) => {
    const cancelledAt = new Date();
    const claimed = await StockAdjustment.findOneAndUpdate(
      { _id: id, orgId: actor.orgId, status: 'POSTED' },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledBy: actor.actorId,
          cancelReason: input.reason,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already cancelled');

    const originals = await StockLedger.find({
      orgId: actor.orgId,
      refType: REF_TYPE,
      refId: id,
      reversalOfId: null,
    })
      .session(session)
      .lean();

    await postMovements(session, {
      orgId: actor.orgId,
      postedAt: cancelledAt,
      actorId: actor.actorId,
      movements: originals.map((o) => ({
        locationId: o.locationId,
        productId: o.productId,
        variantId: o.variantId,
        qtyBase: -o.qtyBase,
        movementType: 'ADJUSTMENT',
        refType: REF_TYPE,
        refId: id,
        refDocNo: claimed.docNo,
        reversalOfId: o._id,
        // The original rows are one per serial, so each reversal carries exactly its unit back.
        lotId: o.lotId,
        ...(o.serialNo ? { serials: [o.serialNo] } : {}),
        narration: `Cancelled: ${input.reason}`,
      })),
    });
  });

  return getAdjustment(actor, id);
}
