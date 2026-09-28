import { compareCounts } from '../../domain/reconcile.js';
import { LotBalance } from '../lot/lotBalance.model.js';
import { Lot } from '../lot/lot.model.js';
import { Location } from '../location/location.model.js';
import { Product } from '../product/product.model.js';
import { SerialUnit } from '../serialUnit/serialUnit.model.js';

import { StockBalance } from './stockBalance.model.js';
import { StockLedger } from './stockLedger.model.js';

import type { DriftRow } from '../../domain/reconcile.js';
import type { ReconcileDriftPayload, ReconcileResult } from '@shared/types.js';
import type { Types } from 'mongoose';

/**
 * `stock:reconcile` — re-sum the ledger and report every cache that disagrees (§6.7, Day 16).
 *
 * Three independent checks, each against the ledger:
 *  1. **Balances** — Σ qtyBase per (location, product, variant) vs `StockBalance.qtyOnHand`.
 *  2. **Lots** — Σ qtyBase per (location, lot) vs `LotBalance.qtyOnHand`.
 *  3. **Serials** — units IN_STOCK per (location, product, variant) vs the balance, for
 *     serial-tracked products: the shelf's count must equal the number of units the register
 *     says are on it.
 *
 * On demand for now; Day 39's notifications can run it nightly.
 */

const k = (...parts: (Types.ObjectId | null | undefined)[]) =>
  parts.map((p) => (p ? String(p) : '-')).join('|');

type Grouped = {
  _id: {
    l: Types.ObjectId;
    p?: Types.ObjectId;
    v?: Types.ObjectId | null;
    lot?: Types.ObjectId;
  };
  n: number;
};

export async function reconcileStock(
  orgId: Types.ObjectId,
  locationId?: Types.ObjectId,
): Promise<ReconcileResult> {
  const where = { orgId, ...(locationId ? { locationId } : {}) };
  const startedAt = Date.now();

  const [ledgerByItem, balances, ledgerByLot, lotBalances, serialProducts] = await Promise.all([
    StockLedger.aggregate<Grouped>([
      { $match: where },
      {
        $group: {
          _id: { l: '$locationId', p: '$productId', v: '$variantId' },
          n: { $sum: '$qtyBase' },
        },
      },
    ]),
    StockBalance.find(where).select('locationId productId variantId qtyOnHand').lean(),
    StockLedger.aggregate<Grouped>([
      { $match: { ...where, lotId: { $ne: null } } },
      { $group: { _id: { l: '$locationId', lot: '$lotId' }, n: { $sum: '$qtyBase' } } },
    ]),
    LotBalance.find(where).select('locationId lotId qtyOnHand').lean(),
    Product.find({ orgId, trackingMode: 'SERIAL' }).select('_id').lean(),
  ]);

  const itemTruth = new Map(ledgerByItem.map((g) => [k(g._id.l, g._id.p, g._id.v), g.n]));
  const itemCache = new Map(
    balances.map((b) => [k(b.locationId, b.productId, b.variantId), b.qtyOnHand]),
  );
  const balanceDrift = compareCounts(itemTruth, itemCache);

  const lotTruth = new Map(ledgerByLot.map((g) => [k(g._id.l, g._id.lot), g.n]));
  const lotCache = new Map(lotBalances.map((b) => [k(b.locationId, b.lotId), b.qtyOnHand]));
  const lotDrift = compareCounts(lotTruth, lotCache);

  // Serials: the register's IN_STOCK count is the truth for *which units* are on the shelf, the
  // balance for *how many*; they must agree.
  const serialIds = serialProducts.map((p) => p._id);
  let serialDrift: DriftRow[] = [];
  if (serialIds.length > 0) {
    const inStock = await SerialUnit.aggregate<Grouped>([
      {
        $match: {
          orgId,
          status: 'IN_STOCK',
          productId: { $in: serialIds },
          ...(locationId ? { locationId } : {}),
        },
      },
      {
        $group: { _id: { l: '$locationId', p: '$productId', v: '$variantId' }, n: { $sum: 1 } },
      },
    ]);
    const serialTruth = new Map(inStock.map((g) => [k(g._id.l, g._id.p, g._id.v), g.n]));
    const serialCache = new Map(
      balances
        .filter((b) => serialIds.some((id) => id.equals(b.productId)))
        .map((b) => [k(b.locationId, b.productId, b.variantId), b.qtyOnHand]),
    );
    serialDrift = compareCounts(serialTruth, serialCache);
  }

  const describe = await describer(orgId, [...balanceDrift, ...lotDrift, ...serialDrift]);

  return {
    checkedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    locationId: locationId ? String(locationId) : null,
    counts: { balances: itemCache.size, ledgerGroups: itemTruth.size, lots: lotCache.size },
    balanceDrift: balanceDrift.map((d) => describe(d, 'ITEM')),
    lotDrift: lotDrift.map((d) => describe(d, 'LOT')),
    serialDrift: serialDrift.map((d) => describe(d, 'ITEM')),
    clean: balanceDrift.length + lotDrift.length + serialDrift.length === 0,
  };
}

/** Human labels for drift rows: location code, SKU, lot number. Only called when there is drift. */
async function describer(orgId: Types.ObjectId, rows: DriftRow[]) {
  const ids = (i: number) => [
    ...new Set(
      rows.map((r) => r.key.split('|')[i]).filter((x): x is string => Boolean(x) && x !== '-'),
    ),
  ];
  const [locations, products, lots] = rows.length
    ? await Promise.all([
        Location.find({ orgId, _id: { $in: ids(0) } })
          .select('code')
          .lean(),
        Product.find({ orgId, _id: { $in: ids(1) } })
          .select('sku')
          .lean(),
        Lot.find({ orgId, _id: { $in: ids(1) } })
          .select('lotNo productId')
          .lean(),
      ])
    : [[], [], []];
  const code = new Map(locations.map((l) => [String(l._id), l.code]));
  const sku = new Map(products.map((p) => [String(p._id), p.sku]));
  const lotNo = new Map(lots.map((l) => [String(l._id), l.lotNo]));

  return (d: DriftRow, kind: 'ITEM' | 'LOT'): ReconcileDriftPayload => {
    const [l, a, v] = d.key.split('|');
    return {
      ...d,
      locationId: l!,
      locationCode: code.get(l!) ?? '?',
      ...(kind === 'ITEM'
        ? { productId: a!, variantId: v === '-' ? null : (v ?? null), sku: sku.get(a!) ?? '?' }
        : { lotId: a!, lotNo: lotNo.get(a!) ?? '?' }),
    };
  };
}
