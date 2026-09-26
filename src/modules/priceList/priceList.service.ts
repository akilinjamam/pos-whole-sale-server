import mongoose, { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { escapeRegex, paginate } from '../../lib/paginate.js';
import { adjustPrice, windowsOverlap } from '../../shared/pricing.js';
import { packFactor, uomOptions } from '../../shared/uom.js';
import { describeAxes } from '../../shared/variant.js';
import { Party } from '../party/party.model.js';
import { PriceTier } from '../priceTier/priceTier.model.js';
import { Product } from '../product/product.model.js';
import { Variant } from '../variant/variant.model.js';

import {
  PriceListEntry,
  dateToDay,
  dayToDate,
  toPriceEntryPayload,
} from './priceList.model.js';

import type { ListPriceEntriesQuery } from './priceList.schema.js';
import type { PriceEntryDoc } from './priceList.model.js';
import type { ProductDoc } from '../product/product.model.js';
import type { VariantDoc } from '../variant/variant.model.js';
import type {
  BulkAdjustInput,
  CreatePriceEntryInput,
  PriceImportInput,
  UpdatePriceEntryInput,
  ValidityWindow,
} from '@shared/pricing.js';
import type {
  BulkAdjustResult,
  PageMeta,
  PriceEntryPayload,
  PriceImportResult,
  PriceImportRowResult,
} from '@shared/types.js';
import type { AnyBulkWriteOperation, FilterQuery } from 'mongoose';

/**
 * Price-list entries: CRUD, CSV import and bulk % adjust.
 *
 * The rule this service exists to hold: **for one scope, product, variant, unit and qty break,
 * at most one price applies on any given day.** Two entries that both apply would leave the
 * Day-12 resolver choosing between them arbitrarily — the dealer is quoted one price on Monday
 * and another on Tuesday for the same order, and nobody can say which was "right".
 *
 * Enforced twice:
 *  - `assertNoOverlap` here, which understands validity windows;
 *  - the compound unique index on the model, which does not, but which holds when two identical
 *    requests race past the service check together.
 */

const SORTABLE = ['priceMinor', 'minQty', 'uomCode', 'validFrom', 'createdAt'] as const;

/** Qty breaks of one product sit together, in ascending order — how a price list is read. */
const DEFAULT_SORT = {
  productId: 1,
  variantId: 1,
  uomCode: 1,
  minQty: 1,
  validFrom: 1,
} as const;

/** Beyond this, a search is too vague to be useful and the `$in` would get unwieldy. */
const SEARCH_PRODUCT_CAP = 500;

// ─── Scope ──────────────────────────────────────────────────────────────────────────────

interface Scope {
  tierId: Types.ObjectId | null;
  partyId: Types.ObjectId | null;
}

/**
 * Resolve and check the tier-or-dealer an entry belongs to. The schema has already made sure
 * exactly one was given; this makes sure it exists in this org — and that a party is a dealer,
 * since a dealer-specific price for a supplier would be a price nobody can ever be quoted.
 */
async function resolveScope(
  orgId: Types.ObjectId,
  input: { tierId?: string | null; partyId?: string | null },
): Promise<Scope> {
  if (input.tierId) {
    const tierId = new Types.ObjectId(input.tierId);
    if (!(await PriceTier.exists({ _id: tierId, orgId }))) {
      throw ApiError.validation('Validation failed', [
        { path: 'tierId', message: 'No such price tier' },
      ]);
    }
    return { tierId, partyId: null };
  }

  const partyId = new Types.ObjectId(input.partyId!);
  if (!(await Party.exists({ _id: partyId, orgId, roles: 'DEALER' }))) {
    throw ApiError.validation('Validation failed', [
      { path: 'partyId', message: 'No such dealer' },
    ]);
  }
  return { tierId: null, partyId };
}

function scopeFilter(scope: Scope): FilterQuery<PriceEntryDoc> {
  return { tierId: scope.tierId, partyId: scope.partyId };
}

// ─── Identity & overlap ─────────────────────────────────────────────────────────────────

/** Everything that makes two entries the same rule, apart from when they apply. */
interface RuleKey extends Scope {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  minQty: number;
}

function windowOf(doc: Pick<PriceEntryDoc, 'validFrom' | 'validTo'>): ValidityWindow {
  return { validFrom: dateToDay(doc.validFrom), validTo: dateToDay(doc.validTo) };
}

function describeWindow(w: ValidityWindow): string {
  if (!w.validFrom && !w.validTo) return 'with no end date';
  return `${w.validFrom ?? 'the beginning'} – ${w.validTo ?? 'open-ended'}`;
}

/**
 * Refuse a rule whose window shares a day with an existing entry for the same key.
 *
 * The message says what to do instead, because the usual cause is a price *change* entered as
 * a second price: the fix is to end-date the old entry, not to delete it.
 */
async function assertNoOverlap(
  orgId: Types.ObjectId,
  key: RuleKey,
  window: ValidityWindow,
  exceptId?: Types.ObjectId,
): Promise<void> {
  const siblings = await PriceListEntry.find({
    orgId,
    ...scopeFilter(key),
    productId: key.productId,
    variantId: key.variantId,
    uomCode: key.uomCode,
    minQty: key.minQty,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select('validFrom validTo priceMinor')
    .lean();

  const clash = siblings.find((s) => windowsOverlap(windowOf(s), window));
  if (clash) {
    throw ApiError.conflict(
      'DUPLICATE_DOCUMENT',
      `A price for this product, unit and quantity already applies ${describeWindow(windowOf(clash))}. ` +
        'End-date that entry, or edit it, rather than adding a second one.',
      { conflictingId: String(clash._id), ...windowOf(clash) },
    );
  }
}

// ─── Product & unit checks ──────────────────────────────────────────────────────────────

type ProductLite = Pick<
  ProductDoc,
  '_id' | 'name' | 'sku' | 'baseUom' | 'packs' | 'hasVariants'
>;

async function loadProduct(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
): Promise<ProductLite> {
  const product = await Product.findOne({ _id: productId, orgId })
    .select('name sku baseUom packs hasVariants')
    .lean();
  if (!product) {
    throw ApiError.validation('Validation failed', [
      { path: 'productId', message: 'No such product' },
    ]);
  }
  return product;
}

/** A unit the product does not declare cannot be priced — it can never appear on an order. */
function assertUom(product: ProductLite, uomCode: string): void {
  if (packFactor(product, uomCode) === null) {
    const allowed = uomOptions(product)
      .map((u) => u.code)
      .join(', ');
    throw ApiError.validation('Validation failed', [
      { path: 'uomCode', message: `${product.sku} is sold in ${allowed} — not ${uomCode}` },
    ]);
  }
}

async function assertVariant(
  orgId: Types.ObjectId,
  product: ProductLite,
  variantId: Types.ObjectId,
): Promise<void> {
  if (!(await Variant.exists({ _id: variantId, orgId, productId: product._id }))) {
    throw ApiError.validation('Validation failed', [
      { path: 'variantId', message: `Not a variant of ${product.sku}` },
    ]);
  }
}

// ─── Serialisation ──────────────────────────────────────────────────────────────────────

/** Resolve display names for a page of entries in four grouped queries, not four per row. */
async function serialize(
  orgId: Types.ObjectId,
  docs: PriceEntryDoc[],
): Promise<PriceEntryPayload[]> {
  const ids = (pick: (d: PriceEntryDoc) => Types.ObjectId | null) => [
    ...new Set(docs.flatMap((d) => (pick(d) ? [String(pick(d))] : []))),
  ];

  const [products, variants, tiers, parties] = await Promise.all([
    Product.find({ orgId, _id: { $in: ids((d) => d.productId) } })
      .select('name sku baseUom packs')
      .lean(),
    Variant.find({ orgId, _id: { $in: ids((d) => d.variantId) } })
      .select('axes')
      .lean(),
    PriceTier.find({ orgId, _id: { $in: ids((d) => d.tierId) } })
      .select('name')
      .lean(),
    Party.find({ orgId, _id: { $in: ids((d) => d.partyId) } })
      .select('name displayName')
      .lean(),
  ]);

  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), describeAxes(v.axes)]));
  const tierBy = new Map(tiers.map((t) => [String(t._id), t.name]));
  const partyBy = new Map(parties.map((p) => [String(p._id), p.displayName ?? p.name]));

  return docs.map((doc) => {
    const product = productBy.get(String(doc.productId));
    return toPriceEntryPayload(doc, {
      productName: product?.name ?? '(deleted product)',
      sku: product?.sku ?? '',
      variantLabel: doc.variantId ? (variantBy.get(String(doc.variantId)) ?? null) : null,
      uomOptions: product
        ? uomOptions(product).map(({ code, factor }) => ({ code, factor }))
        : [],
      tierName: doc.tierId ? (tierBy.get(String(doc.tierId)) ?? null) : null,
      partyName: doc.partyId ? (partyBy.get(String(doc.partyId)) ?? null) : null,
    });
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

/** Products matching a free-text search, by name or SKU — the grid searches products, not prices. */
async function productIdsMatching(orgId: Types.ObjectId, q: string): Promise<Types.ObjectId[]> {
  const term = new RegExp(escapeRegex(q), 'i');
  const matches = await Product.find({ orgId, $or: [{ name: term }, { sku: term }] })
    .select('_id')
    .limit(SEARCH_PRODUCT_CAP)
    .lean();
  return matches.map((p) => p._id);
}

export async function listPriceEntries(
  orgId: Types.ObjectId,
  query: ListPriceEntriesQuery,
): Promise<{ items: PriceEntryPayload[]; meta: PageMeta }> {
  // `paginate` runs an aggregation, and `$match` does not cast — every id must be an ObjectId.
  const filter: FilterQuery<PriceEntryDoc> = { orgId };
  if (query.tierId) filter.tierId = new Types.ObjectId(query.tierId);
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.productId) filter.productId = new Types.ObjectId(query.productId);
  if (query.variantId) filter.variantId = new Types.ObjectId(query.variantId);
  if (query.uomCode) filter.uomCode = query.uomCode;
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  if (query.activeOn) {
    const day = dayToDate(query.activeOn);
    filter.$and = [
      { $or: [{ validFrom: null }, { validFrom: { $lte: day } }] },
      { $or: [{ validTo: null }, { validTo: { $gte: day } }] },
    ];
  }

  if (query.q) {
    const productIds = await productIdsMatching(orgId, query.q);
    filter.productId = filter.productId
      ? { $in: productIds.filter((id) => id.equals(filter.productId as Types.ObjectId)) }
      : { $in: productIds };
  }

  const { items, meta } = await paginate<PriceEntryDoc>(PriceListEntry, {
    filter,
    // `q` has already been turned into a product filter above; `paginate` must not search again.
    query: { ...query, q: undefined },
    sortable: SORTABLE,
    searchFields: [],
    defaultSort: { ...DEFAULT_SORT },
  });

  return { items: await serialize(orgId, items), meta };
}

async function loadOrFail(orgId: Types.ObjectId, id: Types.ObjectId): Promise<PriceEntryDoc> {
  const entry = await PriceListEntry.findOne({ _id: id, orgId }).lean();
  if (!entry) throw ApiError.notFound('Price');
  return entry;
}

export async function getPriceEntry(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<PriceEntryPayload> {
  const [payload] = await serialize(orgId, [await loadOrFail(orgId, id)]);
  return payload!;
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────────

export async function createPriceEntry(
  orgId: Types.ObjectId,
  input: CreatePriceEntryInput,
  actorId: Types.ObjectId,
): Promise<PriceEntryPayload> {
  const scope = await resolveScope(orgId, input);
  const productId = new Types.ObjectId(input.productId);
  const product = await loadProduct(orgId, productId);
  assertUom(product, input.uomCode);

  const variantId = input.variantId ? new Types.ObjectId(input.variantId) : null;
  if (variantId) await assertVariant(orgId, product, variantId);

  const key: RuleKey = {
    ...scope,
    productId,
    variantId,
    uomCode: input.uomCode,
    minQty: input.minQty ?? 1,
  };
  const window = { validFrom: input.validFrom ?? null, validTo: input.validTo ?? null };
  await assertNoOverlap(orgId, key, window);

  const created = await PriceListEntry.create({
    orgId,
    ...key,
    priceMinor: input.priceMinor,
    validFrom: dayToDate(window.validFrom),
    validTo: dayToDate(window.validTo),
    isActive: input.isActive ?? true,
    note: input.note ?? null,
    createdBy: actorId,
    updatedBy: actorId,
  });

  return getPriceEntry(orgId, created._id);
}

export async function updatePriceEntry(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdatePriceEntryInput,
  actorId: Types.ObjectId,
): Promise<PriceEntryPayload> {
  const current = await loadOrFail(orgId, id);

  const window: ValidityWindow = {
    validFrom: input.validFrom !== undefined ? input.validFrom : dateToDay(current.validFrom),
    validTo: input.validTo !== undefined ? input.validTo : dateToDay(current.validTo),
  };
  // The schema checks the window only when both ends arrive together; an edit to one end must
  // still be checked against the stored other end.
  if (window.validFrom && window.validTo && window.validTo < window.validFrom) {
    throw ApiError.validation('Validation failed', [
      { path: 'validTo', message: 'Ends before it starts' },
    ]);
  }

  const minQty = input.minQty ?? current.minQty;
  const identityMoved =
    minQty !== current.minQty ||
    window.validFrom !== dateToDay(current.validFrom) ||
    window.validTo !== dateToDay(current.validTo);

  if (identityMoved) {
    await assertNoOverlap(orgId, { ...current, minQty }, window, id);
  }

  await PriceListEntry.updateOne(
    { _id: id, orgId },
    {
      $set: {
        ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        minQty,
        validFrom: dayToDate(window.validFrom),
        validTo: dayToDate(window.validTo),
        updatedBy: actorId,
      },
    },
  );

  return getPriceEntry(orgId, id);
}

/**
 * A real delete. Nothing references an entry by id — an order line stores the *price* it was
 * quoted, not a pointer to the rule — so removing a mistaken price loses no history. For a price
 * that was genuinely in force, end-dating it is the better record, and the grid says so.
 */
export async function deletePriceEntry(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<void> {
  const { deletedCount } = await PriceListEntry.deleteOne({ _id: id, orgId });
  if (deletedCount === 0) throw ApiError.notFound('Price');
}

// ─── CSV import ─────────────────────────────────────────────────────────────────────────

interface PlannedRow {
  line: number;
  key: RuleKey;
  window: ValidityWindow;
  priceMinor: number;
  note: string | null;
  /** Set when an entry with this exact key and start date exists — the row updates it. */
  existingId: Types.ObjectId | null;
}

const keyString = (k: RuleKey) =>
  [k.productId, k.variantId ?? '-', k.uomCode, k.minQty].map(String).join('|');

/**
 * Import a price list — validate every row, report per row, and on commit write only the valid
 * ones, in one transaction.
 *
 * A row whose rule and start date **exactly** match an existing entry updates it: re-importing
 * next season's sheet should re-price, not fail. A row that merely *overlaps* an existing entry
 * with a different start date is an error, for the same reason as `assertNoOverlap` — so is a
 * row that duplicates or overlaps an earlier row in the same file.
 */
export async function importPriceEntries(
  orgId: Types.ObjectId,
  input: PriceImportInput,
  actorId: Types.ObjectId,
): Promise<PriceImportResult> {
  const scope = await resolveScope(orgId, input);

  // Resolve every SKU in two queries, not two per row.
  const skus = [...new Set(input.rows.map((r) => r.sku))];
  const variantSkus = [
    ...new Set(input.rows.flatMap((r) => (r.variantSku ? [r.variantSku] : []))),
  ];
  const [products, variants] = await Promise.all([
    Product.find({ orgId, sku: { $in: skus } })
      .select('name sku baseUom packs hasVariants')
      .lean(),
    variantSkus.length > 0
      ? Variant.find({ orgId, sku: { $in: variantSkus } })
          .select('sku productId axes')
          .lean()
      : Promise.resolve([] as Pick<VariantDoc, '_id' | 'sku' | 'productId' | 'axes'>[]),
  ]);
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));

  const existing = await PriceListEntry.find({
    orgId,
    ...scopeFilter(scope),
    productId: { $in: products.map((p) => p._id) },
  })
    .select('productId variantId uomCode minQty validFrom validTo')
    .lean();
  const existingByKey = new Map<string, PriceEntryDoc[]>();
  for (const e of existing) {
    const k = keyString({ ...scope, ...e });
    existingByKey.set(k, [...(existingByKey.get(k) ?? []), e]);
  }

  const results: PriceImportRowResult[] = [];
  const planned: PlannedRow[] = [];
  const plannedByKey = new Map<string, PlannedRow[]>();

  for (const row of input.rows) {
    const errors: string[] = [];
    const product = productBySku.get(row.sku);
    let variantId: Types.ObjectId | null = null;
    let variantLabel: string | null = null;

    if (!product) errors.push(`No product with SKU ${row.sku}`);

    if (product && row.variantSku) {
      const variant = variantBySku.get(row.variantSku);
      if (!variant) errors.push(`No variant with SKU ${row.variantSku}`);
      else if (!variant.productId.equals(product._id)) {
        errors.push(`${row.variantSku} is not a variant of ${row.sku}`);
      } else {
        variantId = variant._id;
        variantLabel = describeAxes(variant.axes);
      }
    }

    const uomCode = row.uomCode || product?.baseUom || '';
    if (product && packFactor(product, uomCode) === null) {
      errors.push(
        `${row.sku} is sold in ${uomOptions(product)
          .map((u) => u.code)
          .join(', ')} — not ${uomCode}`,
      );
    }

    const window = { validFrom: row.validFrom ?? null, validTo: row.validTo ?? null };
    if (window.validFrom && window.validTo && window.validTo < window.validFrom) {
      errors.push('validTo is before validFrom');
    }

    let existingId: Types.ObjectId | null = null;
    let key: RuleKey | null = null;

    if (product && errors.length === 0) {
      key = { ...scope, productId: product._id, variantId, uomCode, minQty: row.minQty ?? 1 };
      const k = keyString(key);

      for (const e of existingByKey.get(k) ?? []) {
        if (dateToDay(e.validFrom) === window.validFrom) existingId = e._id;
        else if (windowsOverlap(windowOf(e), window)) {
          errors.push(`Overlaps an existing price (${describeWindow(windowOf(e))})`);
        }
      }

      for (const earlier of plannedByKey.get(k) ?? []) {
        if (windowsOverlap(earlier.window, window)) {
          errors.push(`Same price rule as row ${earlier.line}`);
        }
      }
    }

    if (errors.length > 0 || !key) {
      results.push({
        line: row.line,
        status: 'ERROR',
        errors,
        productName: product?.name,
        variantLabel,
      });
      continue;
    }

    const plan: PlannedRow = {
      line: row.line,
      key,
      window,
      priceMinor: row.priceMinor,
      note: row.note ?? null,
      existingId,
    };
    planned.push(plan);
    plannedByKey.set(keyString(key), [...(plannedByKey.get(keyString(key)) ?? []), plan]);
    results.push({
      line: row.line,
      status: existingId ? 'UPDATE' : 'CREATE',
      errors: [],
      productName: product?.name,
      variantLabel,
    });
  }

  const created = planned.filter((p) => !p.existingId).length;
  const updated = planned.length - created;
  const failed = results.length - planned.length;

  if (!input.dryRun && planned.length > 0) {
    const ops: AnyBulkWriteOperation<PriceEntryDoc>[] = planned.map((p) =>
      p.existingId
        ? {
            updateOne: {
              filter: { _id: p.existingId, orgId },
              update: {
                $set: {
                  priceMinor: p.priceMinor,
                  validTo: dayToDate(p.window.validTo),
                  note: p.note,
                  isActive: true,
                  updatedBy: actorId,
                },
              },
            },
          }
        : {
            insertOne: {
              document: {
                orgId,
                ...p.key,
                priceMinor: p.priceMinor,
                validFrom: dayToDate(p.window.validFrom),
                validTo: dayToDate(p.window.validTo),
                isActive: true,
                note: p.note,
                createdBy: actorId,
                updatedBy: actorId,
              } as PriceEntryDoc,
            },
          },
    );

    // All valid rows or none: a failure half-way (a concurrent insert hitting the unique index,
    // say) must not leave the list half-imported with a report claiming otherwise.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await PriceListEntry.bulkWrite(ops, { session, ordered: true });
      });
    } finally {
      await session.endSession();
    }
  }

  return { dryRun: input.dryRun, rows: results, created, updated, failed };
}

// ─── Bulk % adjust ──────────────────────────────────────────────────────────────────────

const SAMPLE_SIZE = 10;

/**
 * Raise or cut every price in a scope by a percentage, optionally narrowed to a brand, category
 * or product type, rounded to a step.
 *
 * Only **active entries in force today or later** are touched: an entry that ended last year is
 * a record of what was charged, and rewriting it would falsify history.
 */
export async function bulkAdjustPrices(
  orgId: Types.ObjectId,
  input: BulkAdjustInput,
  actorId: Types.ObjectId,
): Promise<BulkAdjustResult> {
  const scope = await resolveScope(orgId, input);
  const today = dayToDate(new Date().toISOString().slice(0, 10));

  const filter: FilterQuery<PriceEntryDoc> = {
    orgId,
    ...scopeFilter(scope),
    isActive: true,
    $or: [{ validTo: null }, { validTo: { $gte: today } }],
  };

  if (input.brandId || input.categoryId || input.productType) {
    const products = await Product.find({
      orgId,
      ...(input.brandId ? { brandId: new Types.ObjectId(input.brandId) } : {}),
      ...(input.categoryId ? { categoryId: new Types.ObjectId(input.categoryId) } : {}),
      ...(input.productType ? { type: input.productType } : {}),
    })
      .select('_id')
      .lean();
    filter.productId = { $in: products.map((p) => p._id) };
  }

  const entries = await PriceListEntry.find(filter)
    .select('productId uomCode minQty priceMinor')
    .sort(DEFAULT_SORT)
    .lean();

  const changes = entries
    .map((e) => ({ entry: e, after: adjustPrice(e.priceMinor, input.pct, input.roundToMinor) }))
    .filter((c) => c.after !== c.entry.priceMinor);

  const sampleProducts = await Product.find({
    orgId,
    _id: { $in: changes.slice(0, SAMPLE_SIZE).map((c) => c.entry.productId) },
  })
    .select('sku')
    .lean();
  const skuOf = new Map(sampleProducts.map((p) => [String(p._id), p.sku]));

  if (!input.dryRun && changes.length > 0) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await PriceListEntry.bulkWrite(
          changes.map((c) => ({
            updateOne: {
              // Guarded on the price read above: an entry someone re-priced in between is left
              // alone rather than having their edit multiplied.
              filter: { _id: c.entry._id, orgId, priceMinor: c.entry.priceMinor },
              update: { $set: { priceMinor: c.after, updatedBy: actorId } },
            },
          })),
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  return {
    dryRun: input.dryRun,
    matched: entries.length,
    changed: changes.length,
    sample: changes.slice(0, SAMPLE_SIZE).map((c) => ({
      id: String(c.entry._id),
      sku: skuOf.get(String(c.entry.productId)) ?? '',
      uomCode: c.entry.uomCode,
      minQty: c.entry.minQty,
      beforeMinor: c.entry.priceMinor,
      afterMinor: c.after,
    })),
  };
}
