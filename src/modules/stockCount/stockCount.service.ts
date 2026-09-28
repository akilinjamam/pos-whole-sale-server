import { Types } from 'mongoose';

import { countVariances, UncountedLinesError } from '../../domain/stockCount.js';
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
} from '../../services/stockLines.js';
import { Location } from '../location/location.model.js';
import { Product } from '../product/product.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';

import { StockCount, toStockCountPayload } from './stockCount.model.js';

import type { ListCountsQuery } from './stockCount.schema.js';
import type { StockCountDoc, StockCountLineDoc } from './stockCount.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { CreateCountInput, PostCountInput, RecordCountInput } from '@shared/stockDocs.js';
import type { PageMeta, StockCountPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

const REF_TYPE = 'STOCK_COUNT';

async function serialize(
  orgId: Types.ObjectId,
  docs: StockCountDoc[],
): Promise<StockCountPayload[]> {
  const [names, locations] = await Promise.all([
    lineNames(
      orgId,
      docs.flatMap((d) => d.lines),
    ),
    Location.find({ orgId, _id: { $in: [...new Set(docs.map((d) => String(d.locationId)))] } })
      .select('name')
      .lean(),
  ]);
  const nameBy = new Map(locations.map((l) => [String(l._id), l.name]));
  return docs.map((d) =>
    toStockCountPayload(d, { lines: names, locationName: nameBy.get(String(d.locationId)) }),
  );
}

async function loadForActor(actor: RequestActor, id: Types.ObjectId): Promise<StockCountDoc> {
  const doc = await StockCount.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Stock count');
  assertLocationAllowed(actor.user, String(doc.locationId));
  return doc;
}

function assertCounting(doc: StockCountDoc): void {
  if (doc.status !== 'COUNTING') {
    throw ApiError.conflict('ILLEGAL_TRANSITION', `This count is ${doc.status.toLowerCase()}`);
  }
}

/** Lift the freeze this count holds — on post and on cancel alike. */
async function unfreeze(
  session: ClientSession,
  orgId: Types.ObjectId,
  countId: Types.ObjectId,
): Promise<void> {
  await StockBalance.updateMany(
    { orgId, frozenByCountId: countId },
    { $set: { frozenByCountId: null } },
    { session },
  );
}

export async function listCounts(
  actor: RequestActor,
  query: ListCountsQuery,
): Promise<{ items: StockCountPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<StockCountDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;

  const { items, meta } = await paginate<StockCountDoc>(StockCount, {
    filter,
    query,
    sortable: ['createdAt', 'postedAt', 'docNo'],
    searchFields: ['docNo', 'note'],
    defaultSort: { createdAt: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getCount(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<StockCountPayload> {
  const [payload] = await serialize(actor.orgId, [await loadForActor(actor, id)]);
  return payload!;
}

/**
 * Open a count: freeze what it covers and snapshot what the system holds.
 *
 * The freeze is written **onto the balance rows**, inside this transaction. A sale committing at
 * the same moment is writing one of those rows too, so one of the two transactions conflicts and
 * is retried — and the retried one sees the other's effect. There is no instant at which a
 * movement can slip past a count that has already read its expected quantity.
 */
export async function openCount(
  actor: RequestActor,
  input: CreateCountInput,
): Promise<StockCountPayload> {
  await assertStockLocation(actor.orgId, input.locationId, 'locationId');
  const locationId = new Types.ObjectId(input.locationId);
  const productIds =
    input.scope === 'PRODUCTS'
      ? [...new Set(input.productIds ?? [])].map((id) => new Types.ObjectId(id))
      : [];

  if (productIds.length > 0) {
    const found = await Product.find({ orgId: actor.orgId, _id: { $in: productIds } })
      .select('sku trackingMode')
      .lean();
    if (found.length !== productIds.length) {
      throw ApiError.validation('Validation failed', [
        { path: 'productIds', message: 'One or more products do not exist' },
      ]);
    }
    const tracked = found.filter((p) => p.trackingMode !== 'NONE');
    if (tracked.length > 0) {
      throw ApiError.validation('Validation failed', [
        {
          path: 'productIds',
          message: `${tracked.map((p) => p.sku).join(', ')} ${tracked.length === 1 ? 'is' : 'are'} lot- or serial-tracked — counted by lot or serial, not here`,
        },
      ]);
    }
  }

  const countId = new Types.ObjectId();

  await withTransaction(async (session) => {
    // One open count per shelf: two counts freezing the same item would each post a variance
    // against the same snapshot, and the stock would be corrected twice.
    const open = await StockCount.find({ orgId: actor.orgId, locationId, status: 'COUNTING' })
      .select('scope productIds')
      .session(session)
      .lean();
    const clash = open.find(
      (c) =>
        c.scope === 'ALL' ||
        input.scope === 'ALL' ||
        c.productIds.some((p) => productIds.some((q) => q.equals(p))),
    );
    if (clash) {
      throw ApiError.conflict(
        'STOCK_FROZEN',
        'A count already open at this location covers some of these items',
        {
          countId: String(clash._id),
        },
      );
    }

    // Lot- and serial-tracked products are left out of an ALL count: a product-level variance
    // could not say which lot or which unit is missing, so it could not be posted honestly.
    const trackedIds =
      productIds.length > 0
        ? []
        : (
            await Product.find({ orgId: actor.orgId, trackingMode: { $ne: 'NONE' } })
              .select('_id')
              .session(session)
              .lean()
          ).map((p) => p._id);
    const scopeFilter = {
      orgId: actor.orgId,
      locationId,
      ...(productIds.length > 0
        ? { productId: { $in: productIds } }
        : trackedIds.length > 0
          ? { productId: { $nin: trackedIds } }
          : {}),
    };

    // A listed product with no stock here still gets a row, so it is frozen and counted — "we
    // should have none of these" is worth checking too. (Variant products need a named variant,
    // so only their existing rows are counted; one found elsewhere is recorded as a found line.)
    if (productIds.length > 0) {
      const plain = await Product.find({
        orgId: actor.orgId,
        _id: { $in: productIds },
        hasVariants: false,
      })
        .select('_id')
        .session(session)
        .lean();
      for (const p of plain) {
        await StockBalance.updateOne(
          { orgId: actor.orgId, locationId, productId: p._id, variantId: null },
          { $setOnInsert: { qtyOnHand: 0, qtyReserved: 0, qtyIncoming: 0, avgCostMinor: 0 } },
          { upsert: true, session },
        );
      }
    }

    await StockBalance.updateMany(
      { ...scopeFilter, frozenByCountId: null },
      { $set: { frozenByCountId: countId } },
      { session },
    );

    const frozen = await StockBalance.find({ ...scopeFilter, frozenByCountId: countId })
      .select('productId variantId qtyOnHand')
      .session(session)
      .lean();

    const frozenAt = new Date();
    await StockCount.create(
      [
        {
          _id: countId,
          orgId: actor.orgId,
          locationId,
          scope: input.scope,
          productIds,
          note: input.note ?? null,
          frozenAt,
          lines: frozen.map((b) => ({
            productId: b.productId,
            variantId: b.variantId,
            expectedBase: b.qtyOnHand,
            countedBase: null,
            found: false,
          })),
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );
  });

  return getCount(actor, countId);
}

/**
 * Record what was counted. Each line is its own atomic update, so two counters finishing
 * different aisles at once do not overwrite each other's figures.
 */
export async function recordCount(
  actor: RequestActor,
  id: Types.ObjectId,
  input: RecordCountInput,
): Promise<StockCountPayload> {
  assertCounting(await loadForActor(actor, id));

  const resolved = await resolveStockLines(
    actor.orgId,
    input.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.countedQty,
    })),
    { allowTracked: false },
  );

  for (const line of resolved) {
    const match = { productId: line.productId, variantId: line.variantId };
    const updated = await StockCount.updateOne(
      { _id: id, orgId: actor.orgId, status: 'COUNTING' },
      { $set: { 'lines.$[l].countedBase': line.qtyBase, updatedBy: actor.actorId } },
      { arrayFilters: [{ 'l.productId': match.productId, 'l.variantId': match.variantId }] },
    );
    if (updated.matchedCount === 0)
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'This count is no longer open');

    if (updated.modifiedCount === 0) {
      // Not on the sheet: something found that the system did not think was here. Added only if
      // still absent, so two counters reporting the same find add it once.
      const line_: StockCountLineDoc = {
        ...match,
        expectedBase: 0,
        countedBase: line.qtyBase,
        found: true,
      };
      await StockCount.updateOne(
        {
          _id: id,
          orgId: actor.orgId,
          status: 'COUNTING',
          lines: {
            $not: { $elemMatch: { productId: match.productId, variantId: match.variantId } },
          },
        },
        { $push: { lines: line_ }, $set: { updatedBy: actor.actorId } },
      );
    }
  }

  return getCount(actor, id);
}

/**
 * Post the count: a `COUNT` movement for every non-zero variance, the number `CNT-…`, and the
 * freeze lifted — one transaction. Lines that match post nothing.
 */
export async function postCount(
  actor: RequestActor,
  id: Types.ObjectId,
  input: PostCountInput,
): Promise<StockCountPayload> {
  assertCounting(await loadForActor(actor, id));

  try {
    await withTransaction(async (session) => {
      const postedAt = new Date();
      const docNo = await nextDocNo(session, actor.orgId, 'CNT', postedAt);

      const claimed = await StockCount.findOneAndUpdate(
        { _id: id, orgId: actor.orgId, status: 'COUNTING' },
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
      if (!claimed)
        throw ApiError.conflict('ILLEGAL_TRANSITION', 'This count is no longer open');

      // Throws on uncounted lines unless skipped — rolling back the claim and the number too.
      const { movements } = countVariances(claimed.lines, {
        skipUncounted: input.skipUncounted,
      });

      await postMovements(session, {
        orgId: actor.orgId,
        postedAt,
        actorId: actor.actorId,
        bypassFreeze: true,
        movements: movements.map((m) => ({
          locationId: claimed.locationId,
          productId: m.productId,
          variantId: m.variantId,
          qtyBase: m.varianceBase,
          movementType: 'COUNT',
          refType: REF_TYPE,
          refId: claimed._id,
          refDocNo: docNo,
          narration: 'Stock count variance',
        })),
      });

      await unfreeze(session, actor.orgId, id);
    });
  } catch (error) {
    if (error instanceof UncountedLinesError) {
      throw ApiError.validation('Validation failed', [
        { path: 'lines', message: error.message },
      ]);
    }
    throw error;
  }

  return getCount(actor, id);
}

/** Abandon a count: nothing is posted, and the freeze is lifted. */
export async function cancelCount(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<StockCountPayload> {
  assertCounting(await loadForActor(actor, id));

  await withTransaction(async (session) => {
    const claimed = await StockCount.findOneAndUpdate(
      { _id: id, orgId: actor.orgId, status: 'COUNTING' },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'This count is no longer open');
    await unfreeze(session, actor.orgId, id);
  });

  return getCount(actor, id);
}
