import { ApiError } from '../lib/ApiError.js';
import { roundHalfUp } from '../shared/money.js';
import { MOVEMENT_SIGN } from '../shared/stock.js';
import { periodKeyOf } from '../lib/period.js';
import { Location } from '../modules/location/location.model.js';
import { Org } from '../modules/org/org.model.js';
import { Product } from '../modules/product/product.model.js';
import { StockBalance } from '../modules/stock/stockBalance.model.js';
import { StockLedger } from '../modules/stock/stockLedger.model.js';
import { Variant } from '../modules/variant/variant.model.js';

import type { StockLedgerDoc } from '../modules/stock/stockLedger.model.js';
import type { StockMovementType } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * THE stock writer — §6.7 of the project plan.
 *
 * `postMovements` is the only code in the system that writes `StockLedger` or `StockBalance`.
 * Opening stock, adjustments, transfers, counts, goods receipts, dispatches and counter sales
 * all end here, so the rules below hold for every one of them without being re-implemented:
 *
 *  - **Every change is a ledger row**, and the balance moves in the same transaction as the row
 *    that explains it.
 *  - **An outbound movement is a guarded conditional update.** The balance is decremented only
 *    `WHERE qtyOnHand >= qty`; if that matches nothing, the movement is refused with
 *    `409 INSUFFICIENT_STOCK`. The filter *is* the concurrency control — two dispatches of the
 *    last five units cannot both match — so overselling is structurally impossible unless the
 *    org has switched on `allowNegativeStock`.
 *  - **All or nothing.** It takes the caller's session and never commits on its own. A refusal
 *    on the fourth movement of a batch throws, the caller's transaction aborts, and the first
 *    three are rolled back with it.
 *
 * It must be called inside `withTransaction`; without a session there would be nothing to roll
 * back to, which is why the session is a required parameter rather than an option.
 */

export interface MovementInput {
  locationId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  /** Signed base units. The sign must agree with `movementType` — see `MOVEMENT_SIGN`. */
  qtyBase: number;
  movementType: StockMovementType;
  refType: string;
  refId?: Types.ObjectId | null;
  refDocNo?: string | null;
  /** Cost per base unit, when the movement knows it. */
  unitCostMinor?: number | null;
  narration?: string | null;
  reversalOfId?: Types.ObjectId | null;
  /** For an OUT that fulfils a reservation (Day 24): how much of `qtyReserved` it releases. */
  releaseReservedBase?: number;
}

export interface PostMovementsArgs {
  orgId: Types.ObjectId;
  movements: readonly MovementInput[];
  postedAt: Date;
  actorId: Types.ObjectId;
}

/**
 * Movement types whose cost feeds the moving average. Opening stock is the first valuation a
 * shelf ever gets; goods receipts and purchase returns join on Day 33 with the costing engine.
 */
const COSTED_INBOUND: readonly StockMovementType[] = ['OPENING'];

/** Refuse a malformed movement before anything is written. These are caller bugs, not user input. */
function assertShape(m: MovementInput, index: number): void {
  if (!Number.isInteger(m.qtyBase) || m.qtyBase === 0) {
    throw ApiError.internal(`Movement ${index}: qtyBase must be a non-zero integer`);
  }
  const sign = MOVEMENT_SIGN[m.movementType];
  if ((sign === 'IN' && m.qtyBase < 0) || (sign === 'OUT' && m.qtyBase > 0)) {
    // A positive SALE would *add* stock; refusing it here is what keeps a sign slip in some
    // future module from quietly inflating the shelf.
    throw ApiError.internal(
      `Movement ${index}: ${m.movementType} must be ${sign === 'IN' ? 'positive' : 'negative'}`,
    );
  }
  const release = m.releaseReservedBase ?? 0;
  // A reservation is only ever released by stock leaving: never by an IN, and never by more than
  // the quantity going out.
  if (release < 0 || (release > 0 && (m.qtyBase > 0 || release > -m.qtyBase))) {
    throw ApiError.internal(
      `Movement ${index}: releaseReservedBase must be between 0 and the quantity out`,
    );
  }
}

/**
 * Check every location, product and variant the batch names, in three queries.
 *
 * Stock is kept **per variant** for a product that has them — a lens is stocked as SPH −2.00,
 * not as "the lens" — so a movement on a variant product must name one, and a movement on a
 * plain product must not.
 */
async function assertReferences(
  session: ClientSession,
  orgId: Types.ObjectId,
  movements: readonly MovementInput[],
): Promise<void> {
  const unique = (ids: (Types.ObjectId | null)[]) => [
    ...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map(String)),
  ];
  const locationIds = unique(movements.map((m) => m.locationId));
  const productIds = unique(movements.map((m) => m.productId));
  const variantIds = unique(movements.map((m) => m.variantId));

  const [locations, products, variants] = await Promise.all([
    Location.find({ orgId, _id: { $in: locationIds } })
      .select('_id')
      .session(session)
      .lean(),
    Product.find({ orgId, _id: { $in: productIds } })
      .select('hasVariants sku')
      .session(session)
      .lean(),
    variantIds.length > 0
      ? Variant.find({ orgId, _id: { $in: variantIds } })
          .select('productId')
          .session(session)
          .lean()
      : Promise.resolve([]),
  ]);

  if (locations.length !== locationIds.length)
    throw ApiError.validation('Validation failed', [
      { path: 'locationId', message: 'No such location' },
    ]);

  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), v]));

  for (const m of movements) {
    const product = productBy.get(String(m.productId));
    if (!product)
      throw ApiError.validation('Validation failed', [
        { path: 'productId', message: 'No such product' },
      ]);

    if (product.hasVariants && !m.variantId) {
      throw ApiError.validation('Validation failed', [
        { path: 'variantId', message: `${product.sku} is stocked per variant — name one` },
      ]);
    }
    if (!product.hasVariants && m.variantId) {
      throw ApiError.validation('Validation failed', [
        { path: 'variantId', message: `${product.sku} has no variants` },
      ]);
    }
    if (m.variantId && !variantBy.get(String(m.variantId))?.productId.equals(m.productId)) {
      throw ApiError.validation('Validation failed', [
        { path: 'variantId', message: `Not a variant of ${product.sku}` },
      ]);
    }
  }
}

/** The moving average after an inbound movement with a known cost. */
function blendedCost(onHand: number, avg: number, qtyIn: number, cost: number): number {
  // A shelf at or below zero has no meaningful average to blend with: the incoming cost is it.
  if (onHand <= 0) return cost;
  return roundHalfUp((onHand * avg + qtyIn * cost) / (onHand + qtyIn));
}

export async function postMovements(
  session: ClientSession,
  { orgId, movements, postedAt, actorId }: PostMovementsArgs,
): Promise<StockLedgerDoc[]> {
  if (movements.length === 0) return [];
  movements.forEach(assertShape);

  const org = await Org.findById(orgId)
    .select('timeZone settings.allowNegativeStock')
    .session(session)
    .lean();
  const allowNegative = Boolean(org?.settings?.allowNegativeStock);
  const periodKey = periodKeyOf(postedAt, org?.timeZone ?? 'Asia/Dhaka');

  await assertReferences(session, orgId, movements);

  const rows: Omit<StockLedgerDoc, '_id' | 'createdAt'>[] = [];

  // In the order given: a batch that takes 5 out and puts 3 back must see its own effects, and
  // `balanceAfterBase` on each row must be the balance right after *that* row.
  for (const m of movements) {
    const key = {
      orgId,
      locationId: m.locationId,
      productId: m.productId,
      variantId: m.variantId ?? null,
    };
    const release = m.releaseReservedBase ?? 0;
    let balanceAfter: number;

    if (m.qtyBase < 0) {
      const needed = -m.qtyBase;
      const guard = allowNegative
        ? {}
        : {
            qtyOnHand: { $gte: needed },
            ...(release > 0 ? { qtyReserved: { $gte: release } } : {}),
          };

      const updated = await StockBalance.findOneAndUpdate(
        { ...key, ...guard },
        {
          $inc: { qtyOnHand: m.qtyBase, qtyReserved: -release },
          $set: { lastMovementAt: postedAt },
        },
        // With negative stock allowed there may be no row yet; create it and go below zero.
        { new: true, session, upsert: allowNegative, setDefaultsOnInsert: true },
      ).lean();

      if (!updated) {
        const current = await StockBalance.findOne(key).session(session).lean();
        throw ApiError.conflict('INSUFFICIENT_STOCK', 'Not enough stock for this movement', {
          locationId: String(m.locationId),
          productId: String(m.productId),
          variantId: m.variantId ? String(m.variantId) : null,
          requested: needed,
          available: current?.qtyOnHand ?? 0,
        });
      }
      balanceAfter = updated.qtyOnHand;
    } else {
      const costed = m.unitCostMinor != null && COSTED_INBOUND.includes(m.movementType);
      let avgCost: number | undefined;
      if (costed) {
        const current = await StockBalance.findOne(key)
          .select('qtyOnHand avgCostMinor')
          .session(session)
          .lean();
        avgCost = blendedCost(
          current?.qtyOnHand ?? 0,
          current?.avgCostMinor ?? 0,
          m.qtyBase,
          m.unitCostMinor!,
        );
      }

      // The filter is exactly the unique index, so a concurrent first receipt of the same item
      // is retried by the server as an update rather than failing on a duplicate key.
      const updated = await StockBalance.findOneAndUpdate(
        key,
        {
          $inc: { qtyOnHand: m.qtyBase },
          $set: {
            lastMovementAt: postedAt,
            ...(avgCost !== undefined ? { avgCostMinor: avgCost } : {}),
          },
        },
        { new: true, session, upsert: true, setDefaultsOnInsert: true },
      ).lean();
      balanceAfter = updated!.qtyOnHand;
    }

    rows.push({
      orgId,
      postedAt,
      periodKey,
      locationId: m.locationId,
      productId: m.productId,
      variantId: m.variantId ?? null,
      lotId: null,
      serialNo: null,
      qtyBase: m.qtyBase,
      movementType: m.movementType,
      refType: m.refType,
      refId: m.refId ?? null,
      refDocNo: m.refDocNo ?? null,
      unitCostMinor: m.unitCostMinor ?? null,
      valueMinor: m.unitCostMinor != null ? m.unitCostMinor * m.qtyBase : null,
      balanceAfterBase: balanceAfter,
      reversalOfId: m.reversalOfId ?? null,
      narration: m.narration ?? null,
      createdBy: actorId,
    });
  }

  return (await StockLedger.insertMany(rows, { session, ordered: true })).map((d) =>
    d.toObject(),
  );
}
