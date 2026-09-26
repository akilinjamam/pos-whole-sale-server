import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PriceListEntry } from '../priceList/priceList.model.js';

import { PriceTier, toPriceTierPayload } from './priceTier.model.js';

import type { ListPriceTiersQuery } from './priceTier.schema.js';
import type { PriceTierDoc } from './priceTier.model.js';
import type { CreatePriceTierInput, UpdatePriceTierInput } from '@shared/pricing.js';
import type { PageMeta, PriceTierPayload } from '@shared/types.js';
import type { FilterQuery, Types } from 'mongoose';

const SORTABLE = ['level', 'code', 'name', 'createdAt'] as const;
const SEARCHABLE = ['code', 'name'] as const;

async function defaultRetailTierId(orgId: Types.ObjectId): Promise<Types.ObjectId | null> {
  const org = await Org.findById(orgId).select('settings.defaultRetailTierId').lean();
  return org?.settings?.defaultRetailTierId ?? null;
}

/** Dealer and entry counts for a set of tiers, in two grouped queries rather than two per row. */
async function usageOf(orgId: Types.ObjectId, ids: Types.ObjectId[]) {
  const [dealers, entries] = await Promise.all([
    Party.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { orgId, roles: 'DEALER', 'dealer.priceTierId': { $in: ids } } },
      { $group: { _id: '$dealer.priceTierId', count: { $sum: 1 } } },
    ]),
    PriceListEntry.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { orgId, tierId: { $in: ids } } },
      { $group: { _id: '$tierId', count: { $sum: 1 } } },
    ]),
  ]);
  const dealerBy = new Map(dealers.map((d) => [String(d._id), d.count]));
  const entryBy = new Map(entries.map((e) => [String(e._id), e.count]));
  return (id: Types.ObjectId) => ({
    dealerCount: dealerBy.get(String(id)) ?? 0,
    entryCount: entryBy.get(String(id)) ?? 0,
  });
}

async function serialize(
  orgId: Types.ObjectId,
  docs: PriceTierDoc[],
): Promise<PriceTierPayload[]> {
  const [retailId, usage] = await Promise.all([
    defaultRetailTierId(orgId),
    usageOf(
      orgId,
      docs.map((d) => d._id),
    ),
  ]);
  return docs.map((d) =>
    toPriceTierPayload(d, { defaultRetailTierId: retailId, ...usage(d._id) }),
  );
}

export async function listPriceTiers(
  orgId: Types.ObjectId,
  query: ListPriceTiersQuery,
): Promise<{ items: PriceTierPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PriceTierDoc> = { orgId };
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<PriceTierDoc>(PriceTier, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { level: 1, name: 1 },
  });

  return { items: await serialize(orgId, items), meta };
}

async function loadOrFail(orgId: Types.ObjectId, id: Types.ObjectId): Promise<PriceTierDoc> {
  const tier = await PriceTier.findOne({ _id: id, orgId }).lean();
  if (!tier) throw ApiError.notFound('Price tier');
  return tier;
}

export async function getPriceTier(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<PriceTierPayload> {
  const [payload] = await serialize(orgId, [await loadOrFail(orgId, id)]);
  return payload!;
}

async function assertCodeFree(orgId: Types.ObjectId, code: string): Promise<void> {
  const clash = await PriceTier.findOne({ orgId, code }).select('name').lean();
  if (clash) {
    throw ApiError.validation('Validation failed', [
      { path: 'code', message: `Already used by "${clash.name}"` },
    ]);
  }
}

export async function createPriceTier(
  orgId: Types.ObjectId,
  input: CreatePriceTierInput,
  actorId: Types.ObjectId,
): Promise<PriceTierPayload> {
  await assertCodeFree(orgId, input.code);
  const tier = await PriceTier.create({
    ...input,
    orgId,
    createdBy: actorId,
    updatedBy: actorId,
  });
  return getPriceTier(orgId, tier._id);
}

/**
 * `code` is accepted unchanged and refused when changed: imports and reports key on it, and a
 * renamed code would silently stop matching every CSV already in someone's downloads folder.
 * The `name` is what people see, and that can change freely.
 */
export async function updatePriceTier(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdatePriceTierInput,
  actorId: Types.ObjectId,
): Promise<PriceTierPayload> {
  const current = await loadOrFail(orgId, id);

  if (input.code !== undefined && input.code !== current.code) {
    throw ApiError.validation('Validation failed', [
      { path: 'code', message: 'A tier code cannot be changed once created' },
    ]);
  }

  // Deactivating the counter's tier would leave every counter sale falling through to the
  // product default price without anyone having decided that.
  if (input.isActive === false && (await defaultRetailTierId(orgId))?.equals(id)) {
    throw ApiError.validation('Validation failed', [
      {
        path: 'isActive',
        message:
          'This is the counter (default retail) tier. Choose another in Company settings first.',
      },
    ]);
  }

  const { code: _code, ...rest } = input;
  await PriceTier.updateOne({ _id: id, orgId }, { $set: { ...rest, updatedBy: actorId } });
  return getPriceTier(orgId, id);
}

/**
 * Deletion only for a tier nothing uses. A tier with prices or dealers is deactivated instead:
 * deleting it would orphan the entries and silently drop its dealers to retail prices.
 */
export async function deletePriceTier(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<void> {
  const tier = await loadOrFail(orgId, id);

  if ((await defaultRetailTierId(orgId))?.equals(id)) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${tier.name}" is the counter's default retail tier and cannot be deleted.`,
    );
  }

  const { dealerCount, entryCount } = (await usageOf(orgId, [id]))(id);
  if (dealerCount > 0 || entryCount > 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${tier.name}" has ${dealerCount} dealer(s) and ${entryCount} price(s). Deactivate it instead.`,
      { dealerCount, entryCount },
    );
  }

  await PriceTier.deleteOne({ _id: id, orgId });
}
