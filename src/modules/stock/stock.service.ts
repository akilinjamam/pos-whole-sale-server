import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { escapeRegex, paginate } from '../../lib/paginate.js';
import { addDays, dayIn, dayToDate, startOfDayIn } from '../../lib/period.js';
import { expiryFromShelfLife } from '../../domain/warranty.js';
import { lotForInbound } from '../../services/lot.service.js';
import { SerialUnit } from '../serialUnit/serialUnit.model.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postMovements } from '../../services/stock.service.js';
import { toBase, UomError } from '../../shared/uom.js';
import { describeAxes } from '../../shared/variant.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Product } from '../product/product.model.js';
import { Variant } from '../variant/variant.model.js';

import { StockBalance, toStockBalancePayload } from './stockBalance.model.js';
import { StockLedger, toStockLedgerPayload } from './stockLedger.model.js';

import type { ListBalancesQuery, ListLedgerQuery } from './stock.schema.js';
import type { StockBalanceDoc } from './stockBalance.model.js';
import type { StockLedgerDoc } from './stockLedger.model.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { OpeningImportInput } from '@shared/stock.js';
import type {
  OpeningImportResult,
  OpeningImportRowResult,
  PageMeta,
  StockBalancePayload,
  StockLedgerPayload,
} from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Reads over the stock cache and ledger, and the opening-stock import.
 *
 * Nothing here writes stock directly: the import prepares movements and hands them to
 * `services/stock.service.ts`, the only writer.
 */

export interface StockActor {
  orgId: Types.ObjectId;
  actorId: Types.ObjectId;
  /** Whether the caller holds `stock:viewCost` — cost fields are stripped, not hidden. */
  includeCost: boolean;
  /** The caller's locations, or null when unrestricted — see `locationScopeOf`. */
  locationScope: string[] | null;
}

const orgZone = async (orgId: Types.ObjectId) =>
  (await Org.findById(orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';

/**
 * Narrow a filter to the caller's locations. A user limited to the counter must not see — or,
 * by summing, infer — what is in the main warehouse.
 */
function scopeLocations<T>(
  filter: FilterQuery<T>,
  actor: StockActor,
  requested?: string,
): FilterQuery<T> {
  if (requested) return { ...filter, locationId: new Types.ObjectId(requested) };
  if (actor.locationScope) {
    return {
      ...filter,
      locationId: { $in: actor.locationScope.map((id) => new Types.ObjectId(id)) },
    };
  }
  return filter;
}

/** Product, variant and location names for a page of rows, in three grouped queries. */
async function namesFor(
  orgId: Types.ObjectId,
  rows: Pick<StockBalanceDoc, 'productId' | 'variantId' | 'locationId'>[],
) {
  const ids = (pick: (r: (typeof rows)[number]) => Types.ObjectId | null) => [
    ...new Set(rows.flatMap((r) => (pick(r) ? [String(pick(r))] : []))),
  ];
  const [products, variants, locations] = await Promise.all([
    Product.find({ orgId, _id: { $in: ids((r) => r.productId) } })
      .select('name sku baseUom')
      .lean(),
    Variant.find({ orgId, _id: { $in: ids((r) => r.variantId) } })
      .select('axes')
      .lean(),
    Location.find({ orgId, _id: { $in: ids((r) => r.locationId) } })
      .select('code name')
      .lean(),
  ]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), describeAxes(v.axes)]));
  const locationBy = new Map(locations.map((l) => [String(l._id), l]));

  return (r: (typeof rows)[number]) => {
    const p = productBy.get(String(r.productId));
    const l = locationBy.get(String(r.locationId));
    return {
      productName: p?.name ?? '(deleted product)',
      sku: p?.sku ?? '',
      baseUom: p?.baseUom ?? '',
      variantLabel: r.variantId ? (variantBy.get(String(r.variantId)) ?? null) : null,
      locationCode: l?.code ?? '',
      locationName: l?.name ?? '',
    };
  };
}

/**
 * `q` on a stock list searches **products** (name or SKU), since that is what someone typing is
 * looking for; the matching ids then filter the balances or ledger rows.
 */
async function productIdsMatching(orgId: Types.ObjectId, q: string): Promise<Types.ObjectId[]> {
  const term = new RegExp(escapeRegex(q), 'i');
  const found = await Product.find({ orgId, $or: [{ name: term }, { sku: term }] })
    .select('_id')
    .limit(500)
    .lean();
  return found.map((p) => p._id);
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

export async function listBalances(
  actor: StockActor,
  query: ListBalancesQuery,
): Promise<{ items: StockBalancePayload[]; meta: PageMeta }> {
  let filter: FilterQuery<StockBalanceDoc> = { orgId: actor.orgId };
  filter = scopeLocations(filter, actor, query.locationId);
  if (query.productId) filter.productId = new Types.ObjectId(query.productId);
  if (query.variantId) filter.variantId = new Types.ObjectId(query.variantId);
  if (query.nonZero) filter.$or = [{ qtyOnHand: { $ne: 0 } }, { qtyReserved: { $ne: 0 } }];
  if (query.q && !query.productId)
    filter.productId = { $in: await productIdsMatching(actor.orgId, query.q) };

  const { items, meta } = await paginate<StockBalanceDoc>(StockBalance, {
    filter,
    query,
    sortable: ['qtyOnHand', 'qtyReserved', 'lastMovementAt'],
    searchFields: [],
    defaultSort: { productId: 1, variantId: 1, locationId: 1 },
    exclude: actor.includeCost ? [] : ['avgCostMinor'],
  });

  const names = await namesFor(actor.orgId, items);
  return {
    items: items.map((b) =>
      toStockBalancePayload(b, { includeCost: actor.includeCost, ...names(b) }),
    ),
    meta,
  };
}

export async function listLedger(
  actor: StockActor,
  query: ListLedgerQuery,
): Promise<{ items: StockLedgerPayload[]; meta: PageMeta }> {
  let filter: FilterQuery<StockLedgerDoc> = { orgId: actor.orgId };
  filter = scopeLocations(filter, actor, query.locationId);
  if (query.productId) filter.productId = new Types.ObjectId(query.productId);
  if (query.variantId) filter.variantId = new Types.ObjectId(query.variantId);
  if (query.movementType) filter.movementType = query.movementType;
  if (query.refType) filter.refType = query.refType;
  if (query.refId) filter.refId = new Types.ObjectId(query.refId);
  if (query.refDocNo) filter.refDocNo = query.refDocNo;
  if (query.serialNo) filter.serialNo = query.serialNo;
  if (query.q && !query.productId)
    filter.productId = { $in: await productIdsMatching(actor.orgId, query.q) };

  if (query.from || query.to) {
    const zone = await orgZone(actor.orgId);
    filter.postedAt = {
      ...(query.from ? { $gte: startOfDayIn(query.from, zone) } : {}),
      // `to` is inclusive: everything before the start of the following day.
      ...(query.to ? { $lt: startOfDayIn(addDays(query.to, 1), zone) } : {}),
    };
  }

  const { items, meta } = await paginate<StockLedgerDoc>(StockLedger, {
    filter,
    query,
    sortable: ['postedAt', 'qtyBase', 'movementType'],
    searchFields: [],
    // Newest first, and `_id` breaks ties so rows posted in one batch keep their order.
    defaultSort: { postedAt: -1, _id: -1 },
    exclude: actor.includeCost ? [] : ['unitCostMinor', 'valueMinor'],
  });

  const names = await namesFor(actor.orgId, items);
  return {
    items: items.map((row) => {
      const n = names(row);
      return toStockLedgerPayload(row, {
        includeCost: actor.includeCost,
        productName: n.productName,
        sku: n.sku,
        variantLabel: n.variantLabel,
        locationCode: n.locationCode,
      });
    }),
    meta,
  };
}

// ─── Opening stock ──────────────────────────────────────────────────────────────────────

interface PlannedRow {
  line: number;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  qtyBase: number;
  unitCostMinor: number | null;
  lotNo: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  serials: string[];
}

const itemKey = (productId: Types.ObjectId, variantId: Types.ObjectId | null) =>
  `${String(productId)}|${String(variantId ?? '-')}`;

/** Items at this location that already have opening stock — inside the session when posting. */
async function existingOpenings(
  orgId: Types.ObjectId,
  locationId: Types.ObjectId,
  productIds: Types.ObjectId[],
  session?: ClientSession,
): Promise<Set<string>> {
  const q = StockLedger.find({
    orgId,
    locationId,
    movementType: 'OPENING',
    productId: { $in: productIds },
  }).select('productId variantId');
  const rows = await (session ? q.session(session) : q).lean();
  return new Set(rows.map((r) => itemKey(r.productId, r.variantId)));
}

/**
 * Load opening stock for one location — the cutover from the old system.
 *
 * Same shape as the price import: every row is validated and reported, a dry run writes
 * nothing, and a commit posts every valid row as `OPENING` movements **in one transaction**,
 * all sharing one `refId` so the load can be found — and, if it was wrong, reversed — as a unit.
 *
 * An item that already has opening stock at this location is refused. Re-running the import
 * would otherwise *double* the stock, silently; a correction after cutover is an adjustment
 * (Day 14), which carries a reason.
 *
 * Lot-tracked rows need a lot number (and an expiry where the product requires one); serial-
 * tracked rows need exactly one serial per unit, none already in stock. Loading 30 machines as an
 * anonymous quantity would leave every warranty claim with nothing to trace.
 */
export async function importOpeningStock(
  actor: StockActor,
  input: OpeningImportInput,
): Promise<OpeningImportResult> {
  const locationId = new Types.ObjectId(input.locationId);
  const location = await Location.findOne({ _id: locationId, orgId: actor.orgId })
    .select('code type')
    .lean();
  if (!location)
    throw ApiError.validation('Validation failed', [
      { path: 'locationId', message: 'No such location' },
    ]);
  if (location.type === 'TRANSIT') {
    throw ApiError.validation('Validation failed', [
      {
        path: 'locationId',
        message: 'Opening stock cannot be in transit — load it where it physically is',
      },
    ]);
  }

  // A user who may not see costs may not set them either (§10's field-level gates).
  if (!actor.includeCost && input.rows.some((r) => r.unitCostMinor != null)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Setting unit costs needs the stock:viewCost permission',
      {
        required: ['stock:viewCost'],
      },
    );
  }

  const zone = await orgZone(actor.orgId);
  const asOf = input.asOf ?? dayIn(new Date(), zone);
  // Midday of the cutover day, in the org's zone: unambiguously that day for the ledger's
  // `periodKey` and for any report that buckets by day.
  const postedAt = new Date(startOfDayIn(asOf, zone).getTime() + 12 * 3_600_000);

  const skus = [...new Set(input.rows.map((r) => r.sku))];
  const variantSkus = [
    ...new Set(input.rows.flatMap((r) => (r.variantSku ? [r.variantSku] : []))),
  ];
  const [products, variants] = await Promise.all([
    Product.find({ orgId: actor.orgId, sku: { $in: skus } })
      .select('name sku baseUom packs hasVariants trackingMode attrs')
      .lean(),
    variantSkus.length > 0
      ? Variant.find({ orgId: actor.orgId, sku: { $in: variantSkus } })
          .select('sku productId axes')
          .lean()
      : Promise.resolve([]),
  ]);
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));
  const already = await existingOpenings(
    actor.orgId,
    locationId,
    products.map((p) => p._id),
  );

  const results: OpeningImportRowResult[] = [];
  const planned: PlannedRow[] = [];
  const seen = new Map<string, number>();
  const serialRow = new Map<string, number>();
  const trackingBy = new Map<number, { serials: string[]; expiryDate: string | null }>();
  // Serials in this file that are already on a shelf somewhere — refused per row, up front.
  const fileSerials = input.rows.flatMap((r) =>
    (r.serials ?? []).map((sn) => sn.trim().toUpperCase()),
  );
  const inStock = new Set(
    fileSerials.length
      ? (
          await SerialUnit.find({
            orgId: actor.orgId,
            serialNo: { $in: fileSerials },
            status: 'IN_STOCK',
          })
            .select('serialNo')
            .lean()
        ).map((u) => u.serialNo)
      : [],
  );

  for (const row of input.rows) {
    const errors: string[] = [];
    const product = productBySku.get(row.sku);
    let variantId: Types.ObjectId | null = null;
    let variantLabel: string | null = null;
    let qtyBase: number | undefined;

    if (!product) {
      errors.push(`No product with SKU ${row.sku}`);
    } else {
      if (product.hasVariants && !row.variantSku) {
        errors.push(`${row.sku} is stocked per variant — give a variantSku`);
      } else if (!product.hasVariants && row.variantSku) {
        errors.push(`${row.sku} has no variants`);
      } else if (row.variantSku) {
        const v = variantBySku.get(row.variantSku);
        if (!v) errors.push(`No variant with SKU ${row.variantSku}`);
        else if (!v.productId.equals(product._id))
          errors.push(`${row.variantSku} is not a variant of ${row.sku}`);
        else {
          variantId = v._id;
          variantLabel = describeAxes(v.axes);
        }
      }

      try {
        qtyBase = toBase(row.qty, row.uomCode || product.baseUom, {
          baseUom: product.baseUom,
          packs: product.packs ?? [],
        });
      } catch (error) {
        if (error instanceof UomError) errors.push(error.message);
        else throw error;
      }

      // ── Tracking capture ──
      const serials = (row.serials ?? []).map((sn) => sn.trim().toUpperCase());
      if (product.trackingMode === 'SERIAL' && qtyBase !== undefined) {
        if (serials.length !== qtyBase) {
          errors.push(
            `${qtyBase} unit(s) need exactly ${qtyBase} serial number(s) — ${serials.length} given`,
          );
        }
        for (const sn of serials) {
          if (inStock.has(sn)) errors.push(`Serial ${sn} is already in stock`);
          const other = serialRow.get(sn);
          if (other !== undefined) errors.push(`Serial ${sn} is also on row ${other}`);
          serialRow.set(sn, row.line);
        }
      } else if (serials.length > 0) {
        errors.push(`${row.sku} is not serial-tracked`);
      }

      let expiryDate = row.expiryDate ?? null;
      if (product.trackingMode === 'LOT') {
        if (!row.lotNo) errors.push(`${row.sku} is lot-tracked — give a lotNo`);
        const accessory = product.attrs?.type === 'ACCESSORY' ? product.attrs : null;
        if (!expiryDate && row.mfgDate && accessory?.shelfLifeDays) {
          expiryDate = expiryFromShelfLife(row.mfgDate, accessory.shelfLifeDays);
        }
        if (accessory?.requiresExpiry && !expiryDate) {
          errors.push(`${row.sku} needs an expiryDate (or an mfgDate)`);
        }
      } else if (row.lotNo) {
        errors.push(`${row.sku} is not lot-tracked`);
      }
      trackingBy.set(row.line, { serials, expiryDate });

      if (errors.length === 0) {
        const key = itemKey(product._id, variantId);
        if (already.has(key))
          errors.push('Already has opening stock here — correct it with an adjustment');
        // Several lots of one item may open together; the same lot twice may not.
        const rowKey = `${key}|${product.trackingMode === 'LOT' ? row.lotNo : '-'}`;
        const earlier = seen.get(rowKey);
        if (earlier !== undefined) errors.push(`Same item as row ${earlier}`);
        seen.set(rowKey, row.line);
      }
    }

    if (errors.length > 0 || !product || qtyBase === undefined) {
      results.push({
        line: row.line,
        status: 'ERROR',
        errors,
        productName: product?.name,
        variantLabel,
      });
      continue;
    }

    const tracking = trackingBy.get(row.line)!;
    planned.push({
      line: row.line,
      productId: product._id,
      variantId,
      qtyBase,
      unitCostMinor: row.unitCostMinor ?? null,
      lotNo: product.trackingMode === 'LOT' ? (row.lotNo ?? null) : null,
      mfgDate: row.mfgDate ?? null,
      expiryDate: tracking.expiryDate,
      serials: tracking.serials,
    });
    results.push({
      line: row.line,
      status: 'POST',
      errors: [],
      productName: product.name,
      variantLabel,
      qtyBase,
    });
  }

  const refDocNo = `OPEN-${location.code}-${asOf}`;
  let refId: Types.ObjectId | null = null;

  if (!input.dryRun && planned.length > 0) {
    refId = new Types.ObjectId();
    const batchRef = refId;
    await withTransaction(async (session) => {
      // Re-checked inside the transaction: two imports racing past the check above would both
      // post. Here, the loser conflicts on the balance rows, is retried, and on the retry sees
      // the winner's movements and is refused.
      const inTxn = await existingOpenings(
        actor.orgId,
        locationId,
        [...new Set(planned.map((p) => p.productId))],
        session,
      );
      const clash = planned.find((p) => inTxn.has(itemKey(p.productId, p.variantId)));
      if (clash) {
        throw ApiError.conflict(
          'DUPLICATE_DOCUMENT',
          `Row ${clash.line} already has opening stock — another import just posted it`,
        );
      }

      const movements: MovementInput[] = [];
      for (const p of planned) {
        const lotId = p.lotNo
          ? (
              await lotForInbound(
                session,
                actor.orgId,
                {
                  productId: p.productId,
                  variantId: p.variantId,
                  lotNo: p.lotNo,
                  mfgDate: dayToDate(p.mfgDate),
                  expiryDate: dayToDate(p.expiryDate),
                },
                actor.actorId,
              )
            )._id
          : null;
        movements.push({
          locationId,
          productId: p.productId,
          variantId: p.variantId,
          qtyBase: p.qtyBase,
          movementType: 'OPENING',
          refType: 'OPENING_IMPORT',
          refId: batchRef,
          refDocNo,
          unitCostMinor: p.unitCostMinor,
          narration: `Opening stock as of ${asOf}`,
          lotId,
          ...(p.serials.length ? { serials: p.serials } : {}),
        });
      }
      await postMovements(session, {
        orgId: actor.orgId,
        movements,
        postedAt,
        actorId: actor.actorId,
      });
    });
  }

  return {
    dryRun: input.dryRun,
    rows: results,
    posted: input.dryRun ? 0 : planned.length,
    failed: results.length - planned.length,
    refId: refId ? String(refId) : null,
    refDocNo: refId ? refDocNo : null,
  };
}
