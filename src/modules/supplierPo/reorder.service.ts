import { Types } from 'mongoose';

import { poLineOutstanding } from '../../domain/poStateMachine.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { Location } from '../location/location.model.js';
import { Party } from '../party/party.model.js';
import { Product } from '../product/product.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';

import { PurchaseOrder } from './purchaseOrder.model.js';

import type { ReorderQuery } from './supplierPo.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { ReorderSuggestionPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';
import type { PurchaseOrderDoc } from './purchaseOrder.model.js';

/**
 * Reorder suggestions (Day 34): every active product whose stock position is below its reorder
 * point, and how much to order.
 *
 *   position  = on hand − reserved + still to come on open POs
 *   suggested = the product's reorder quantity, or enough to reach the point if that is more
 *
 * Open POs count, so a product already ordered is not suggested twice. Drafts do not: nobody has
 * committed to them. Stock in transit or at a damage location is not stock anyone can sell.
 *
 * The reorder point is per product (variants share it), so a lens with forty powers is judged on
 * all forty together — the buyer chooses the powers in the PO builder.
 */

const OPEN: readonly PurchaseOrderDoc['status'][] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'];

export async function reorderSuggestions(
  actor: RequestActor,
  query: ReorderQuery,
): Promise<ReorderSuggestionPayload[]> {
  const productFilter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    isActive: true,
    reorderPoint: { $gt: 0 },
  };
  if (query.q) {
    const rx = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    productFilter.$or = [{ sku: rx }, { name: rx }];
  }
  const products = await Product.find(productFilter)
    .select(
      'sku name baseUom hasVariants trackingMode reorderPoint reorderQty leadTimeDays avgCostMinor',
    )
    .lean();
  if (products.length === 0) return [];
  const productIds = products.map((p) => p._id);

  // Where stock counts: the chosen location, else the caller's, else every sellable one.
  const scope = locationScopeOf(actor.user);
  const locationFilter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    type: { $nin: ['TRANSIT', 'DAMAGE'] },
  };
  if (query.locationId) locationFilter._id = new Types.ObjectId(query.locationId);
  else if (scope) locationFilter._id = { $in: scope.map((id) => new Types.ObjectId(id)) };
  const locationIds = (await Location.find(locationFilter).select('_id').lean()).map(
    (l) => l._id,
  );

  const [stock, pos] = await Promise.all([
    StockBalance.aggregate<{ _id: Types.ObjectId; onHand: number; reserved: number }>([
      {
        $match: {
          orgId: actor.orgId,
          productId: { $in: productIds },
          locationId: { $in: locationIds },
        },
      },
      {
        $group: {
          _id: '$productId',
          onHand: { $sum: '$qtyOnHand' },
          reserved: { $sum: '$qtyReserved' },
        },
      },
    ]),
    PurchaseOrder.find({
      orgId: actor.orgId,
      isDeleted: false,
      status: { $nin: ['CANCELLED', 'DRAFT'] },
      'lines.productId': { $in: productIds },
    })
      .select('status supplierPartyId locationId orderDate lines')
      .sort({ orderDate: -1, _id: -1 })
      .lean(),
  ]);

  const stockBy = new Map(stock.map((s) => [String(s._id), s]));
  const onOrder = new Map<string, number>();
  const lastSupplier = new Map<string, Types.ObjectId>();
  const counted = new Set(locationIds.map(String));
  for (const po of pos) {
    for (const l of po.lines) {
      const k = String(l.productId);
      // Newest first, so the first PO seen for a product is its latest supplier.
      if (!lastSupplier.has(k)) lastSupplier.set(k, po.supplierPartyId);
      if (OPEN.includes(po.status) && counted.has(String(po.locationId))) {
        onOrder.set(k, (onOrder.get(k) ?? 0) + poLineOutstanding(l));
      }
    }
  }
  const suppliers = await Party.find({
    orgId: actor.orgId,
    _id: { $in: [...new Set([...lastSupplier.values()].map(String))] },
  })
    .select('name')
    .lean();
  const supplierName = new Map(suppliers.map((s) => [String(s._id), s.name]));
  const seesCost = hasPermission(actor.user, 'stock:viewCost');

  return products
    .flatMap((p) => {
      const k = String(p._id);
      const s = stockBy.get(k);
      const onHandBase = s?.onHand ?? 0;
      const reservedBase = s?.reserved ?? 0;
      const onOrderBase = onOrder.get(k) ?? 0;
      const positionBase = onHandBase - reservedBase + onOrderBase;
      if (positionBase >= p.reorderPoint) return [];
      const supplierId = lastSupplier.get(k) ?? null;
      return [
        {
          productId: k,
          sku: p.sku,
          name: p.name,
          baseUom: p.baseUom,
          hasVariants: p.hasVariants,
          trackingMode: p.trackingMode,
          reorderPoint: p.reorderPoint,
          reorderQty: p.reorderQty,
          leadTimeDays: p.leadTimeDays,
          onHandBase,
          reservedBase,
          onOrderBase,
          positionBase,
          suggestedBase: Math.max(p.reorderQty, p.reorderPoint - positionBase),
          lastSupplierPartyId: supplierId ? String(supplierId) : null,
          lastSupplierName: supplierId ? (supplierName.get(String(supplierId)) ?? null) : null,
          // A product with variants is costed per variant; there is no one figure to show.
          avgCostMinor: seesCost && !p.hasVariants ? p.avgCostMinor : null,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.positionBase / a.reorderPoint - b.positionBase / b.reorderPoint ||
        a.sku.localeCompare(b.sku),
    );
}
