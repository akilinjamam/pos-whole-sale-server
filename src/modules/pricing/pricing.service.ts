import { Types } from 'mongoose';

import { PricingError, resolvePrice } from '../../domain/pricing.js';
import { ApiError } from '../../lib/ApiError.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PriceListEntry, dateToDay } from '../priceList/priceList.model.js';
import { PriceTier } from '../priceTier/priceTier.model.js';
import { Product } from '../product/product.model.js';
import { Variant } from '../variant/variant.model.js';

import type { ResolveQuery } from './pricing.schema.js';
import type { EntryLike } from '../../domain/pricing.js';
import type { PriceResolution } from '@shared/types.js';

/**
 * Load everything `resolvePrice` needs, in a handful of queries, and hand it over.
 *
 * All the deciding happens in `domain/pricing.ts`; this file only fetches rows and translates
 * errors. That split is what makes the engine unit-testable without a database — and it is the
 * same call the order builder (Day 22) and the counter (Day 18) will make on every save, so the
 * price a user is shown and the price that is stored come from one function.
 */

/** Today in the org's own time zone — a quote at 00:30 in Dhaka is tomorrow's quote in UTC terms. */
function todayIn(timeZone: string): string {
  // `en-CA` formats as YYYY-MM-DD, which is exactly the shape the engine compares on.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const invalid = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

export async function resolveForRequest(
  orgId: Types.ObjectId,
  query: ResolveQuery,
): Promise<PriceResolution> {
  const productId = new Types.ObjectId(query.productId);

  const [org, product, variant, party] = await Promise.all([
    Org.findById(orgId).select('timeZone settings.defaultRetailTierId').lean(),
    Product.findOne({ _id: productId, orgId })
      .select('baseUom packs defaultSellPriceMinor')
      .lean(),
    query.variantId
      ? Variant.findOne({ _id: query.variantId, orgId, productId })
          .select('priceDeltaMinor')
          .lean()
      : Promise.resolve(null),
    query.partyId
      ? Party.findOne({ _id: query.partyId, orgId, roles: 'DEALER' })
          .select('name displayName dealer.priceTierId dealer.discountPct')
          .lean()
      : Promise.resolve(null),
  ]);

  if (!product) throw invalid('productId', 'No such product');
  if (query.variantId && !variant) throw invalid('variantId', 'Not a variant of this product');
  if (query.partyId && !party) throw invalid('partyId', 'No such dealer');

  const retailTierId = org?.settings?.defaultRetailTierId ?? null;
  const dealerTierId = party?.dealer?.priceTierId ?? null;

  const tierIds = [dealerTierId, retailTierId].filter((id): id is Types.ObjectId =>
    Boolean(id),
  );
  // The lists in play. None at all — a counter sale in an org with no retail tier — goes straight
  // to the product default, and must not reach Mongo as an empty `$or`, which it rejects.
  const scopes = [
    ...(party ? [{ partyId: party._id }] : []),
    ...(tierIds.length > 0 ? [{ tierId: { $in: tierIds }, partyId: null }] : []),
  ];

  const [entries, tiers] = await Promise.all([
    scopes.length > 0
      ? PriceListEntry.find({ orgId, productId, $or: scopes })
          .select(
            'tierId partyId variantId uomCode priceMinor minQty validFrom validTo isActive',
          )
          .lean()
      : Promise.resolve([]),
    tierIds.length > 0
      ? PriceTier.find({ orgId, _id: { $in: tierIds } })
          .select('name')
          .lean()
      : Promise.resolve([]),
  ]);

  const toEntry = (e: (typeof entries)[number]): EntryLike => ({
    id: String(e._id),
    tierId: e.tierId ? String(e.tierId) : null,
    partyId: e.partyId ? String(e.partyId) : null,
    variantId: e.variantId ? String(e.variantId) : null,
    uomCode: e.uomCode,
    priceMinor: e.priceMinor,
    minQty: e.minQty,
    validFrom: dateToDay(e.validFrom),
    validTo: dateToDay(e.validTo),
    isActive: e.isActive,
  });

  const names: Record<string, string> = Object.fromEntries(
    tiers.map((t) => [String(t._id), t.name]),
  );
  if (party) names[String(party._id)] = party.displayName ?? party.name;

  try {
    return resolvePrice({
      productId: String(product._id),
      product: {
        baseUom: product.baseUom,
        packs: product.packs ?? [],
        defaultSellPriceMinor: product.defaultSellPriceMinor,
      },
      variant: variant
        ? { id: String(variant._id), priceDeltaMinor: variant.priceDeltaMinor }
        : null,
      dealer: party
        ? {
            partyId: String(party._id),
            tierId: dealerTierId ? String(dealerTierId) : null,
            discountPct: party.dealer?.discountPct ?? 0,
          }
        : null,
      retailTierId: retailTierId ? String(retailTierId) : null,
      uomCode: query.uomCode ?? product.baseUom,
      qty: query.qty,
      date: query.date ?? todayIn(org?.timeZone ?? 'Asia/Dhaka'),
      entries: entries.map(toEntry),
      names,
    });
  } catch (error) {
    if (error instanceof PricingError) throw invalid(error.field, error.message);
    throw error;
  }
}
