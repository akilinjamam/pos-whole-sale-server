import { ApiError } from '../lib/ApiError.js';
import { roundHalfUp } from '../shared/money.js';
import { MOVEMENT_SIGN } from '../shared/stock.js';
import { dayIn, periodKeyOf } from '../lib/period.js';
import { warrantyEndDay } from '../domain/warranty.js';
import { Lot } from '../modules/lot/lot.model.js';
import { LotBalance } from '../modules/lot/lotBalance.model.js';
import { SerialUnit } from '../modules/serialUnit/serialUnit.model.js';
import { Location } from '../modules/location/location.model.js';
import { Org } from '../modules/org/org.model.js';
import { Product } from '../modules/product/product.model.js';
import { StockBalance } from '../modules/stock/stockBalance.model.js';
import { StockLedger } from '../modules/stock/stockLedger.model.js';
import { Variant } from '../modules/variant/variant.model.js';

import type { StockLedgerDoc } from '../modules/stock/stockLedger.model.js';
import type { SerialStatus, StockMovementType } from '@shared/enums.js';
import { mongo } from 'mongoose';

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
  /** Required for a LOT-tracked product, and only for one — see `assertTracking`. */
  lotId?: Types.ObjectId | null;
  /**
   * Required for a SERIAL-tracked product: exactly `|qtyBase|` distinct serial numbers. Each
   * becomes its own ledger row of ±1, so a unit's history is one indexed query.
   */
  serials?: readonly string[];
  /** For a SALE of serialised units (Day 18/24): recorded on each unit sold. */
  sale?: {
    partyId?: Types.ObjectId | null;
    invoiceId?: Types.ObjectId | null;
    sellPriceMinor?: number | null;
  };
}

export interface PostMovementsArgs {
  orgId: Types.ObjectId;
  movements: readonly MovementInput[];
  postedAt: Date;
  actorId: Types.ObjectId;
  /**
   * Only for a stock count posting its own variance: every other caller is refused on a row the
   * count has frozen. See `StockBalance.frozenByCountId`.
   */
  bypassFreeze?: boolean;
}

/**
 * Outbound movements that must leave confirmed orders' reservations intact — they take only
 * *available* stock. Adjustments, damage write-offs and count variances are not on this list:
 * they record what physically happened to the shelf, and refusing them would make the ledger lie.
 * If one of them takes on-hand below what is reserved, the orders are short and the dispatch
 * desk finds out when it tries to ship — which is the truth.
 */
const RESPECTS_RESERVATIONS: readonly StockMovementType[] = [
  'SALE',
  'TRANSFER_OUT',
  'PURCHASE_RETURN',
];

/** The refusal a frozen row produces — its own code, so the UI can say "a count is in progress". */
function frozenError(m: MovementInput, countId: Types.ObjectId): ApiError {
  return ApiError.conflict(
    'STOCK_FROZEN',
    'A stock count is in progress for this item here. Post or cancel the count first.',
    {
      locationId: String(m.locationId),
      productId: String(m.productId),
      variantId: m.variantId ? String(m.variantId) : null,
      countId: String(countId),
    },
  );
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
interface ProductInfo {
  _id: Types.ObjectId;
  sku: string;
  hasVariants: boolean;
  trackingMode: 'NONE' | 'LOT' | 'SERIAL';
  warrantyMonths: number | null;
}

async function assertReferences(
  session: ClientSession,
  orgId: Types.ObjectId,
  movements: readonly MovementInput[],
): Promise<Map<string, ProductInfo>> {
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
      .select('hasVariants sku trackingMode attrs')
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

  const productBy = new Map<string, ProductInfo>(
    products.map((p) => [
      String(p._id),
      {
        _id: p._id,
        sku: p.sku,
        hasVariants: p.hasVariants,
        trackingMode: p.trackingMode,
        warrantyMonths: p.attrs?.type === 'MACHINE' ? (p.attrs.warrantyMonths ?? null) : null,
      },
    ]),
  );
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

  await assertTracking(session, orgId, movements, productBy);
  return productBy;
}

/**
 * The tracking rules, for every movement of every caller (§6.4):
 *
 *  - SERIAL — exactly `|qtyBase|` distinct serials, and no lot. Three machines received with two
 *    serials is refused, not "mostly right": the third machine would be untraceable forever.
 *  - LOT — a lot, belonging to this product and variant.
 *  - NONE — neither; a serial on a pack of cloths is a caller bug.
 */
async function assertTracking(
  session: ClientSession,
  orgId: Types.ObjectId,
  movements: readonly MovementInput[],
  productBy: Map<string, ProductInfo>,
): Promise<void> {
  const lotIds = [...new Set(movements.flatMap((m) => (m.lotId ? [String(m.lotId)] : [])))];
  const lots = lotIds.length
    ? await Lot.find({ orgId, _id: { $in: lotIds } })
        .select('productId variantId')
        .session(session)
        .lean()
    : [];
  const lotBy = new Map(lots.map((l) => [String(l._id), l]));

  for (const m of movements) {
    const p = productBy.get(String(m.productId))!;
    const serials = m.serials ?? [];

    if (p.trackingMode === 'SERIAL') {
      const unique = new Set(serials.map((s) => s.trim().toUpperCase()));
      if (serials.length !== Math.abs(m.qtyBase) || unique.size !== serials.length) {
        throw ApiError.validation('Validation failed', [
          {
            path: 'serials',
            message: `${p.sku} is serial-tracked: ${Math.abs(m.qtyBase)} unit(s) need exactly ${Math.abs(m.qtyBase)} distinct serial number(s) — ${unique.size} given`,
          },
        ]);
      }
    } else if (serials.length > 0) {
      throw ApiError.validation('Validation failed', [
        { path: 'serials', message: `${p.sku} is not serial-tracked` },
      ]);
    }

    if (p.trackingMode === 'LOT') {
      const lot = m.lotId ? lotBy.get(String(m.lotId)) : undefined;
      if (!lot) {
        throw ApiError.validation('Validation failed', [
          { path: 'lotNo', message: `${p.sku} is lot-tracked — name the lot` },
        ]);
      }
      if (
        !lot.productId.equals(m.productId) ||
        String(lot.variantId ?? '') !== String(m.variantId ?? '')
      ) {
        throw ApiError.validation('Validation failed', [
          { path: 'lotNo', message: `That lot is not a lot of ${p.sku}` },
        ]);
      }
    } else if (m.lotId) {
      throw ApiError.validation('Validation failed', [
        { path: 'lotNo', message: `${p.sku} is not lot-tracked` },
      ]);
    }
  }
}

/** What an outbound movement makes of a serialised unit. */
function outboundSerialStatus(type: StockMovementType): SerialStatus {
  switch (type) {
    case 'SALE':
      return 'SOLD';
    case 'TRANSFER_OUT':
      return 'IN_TRANSIT';
    case 'PURCHASE_RETURN':
      return 'RETURNED';
    default:
      // DAMAGE, and a negative ADJUSTMENT or COUNT: it is no longer ours to sell.
      return 'SCRAPPED';
  }
}

/**
 * Move each serialised unit a movement names — one atomic update per unit.
 *
 * Inbound: the unit must not already be in stock anywhere. The filter excludes IN_STOCK, so a
 * unit that is already on a shelf fails to match, the upsert tries to insert, and the unique
 * index on `serialNo` refuses — the same backstop holds for two receipts racing each other.
 *
 * Outbound: the unit must be IN_STOCK **at this location**, as this product. Anything else — sold
 * already, at the other warehouse, never received — is refused and named.
 */
async function moveSerials(
  session: ClientSession,
  orgId: Types.ObjectId,
  m: MovementInput,
  product: ProductInfo,
  postedAt: Date,
  timeZone: string,
): Promise<void> {
  for (const raw of m.serials ?? []) {
    const serialNo = raw.trim().toUpperCase();

    if (m.qtyBase > 0) {
      try {
        await SerialUnit.updateOne(
          { orgId, serialNo, status: { $ne: 'IN_STOCK' }, productId: m.productId },
          {
            $set: {
              status: 'IN_STOCK',
              locationId: m.locationId,
              lastMovementAt: postedAt,
              ...(m.lotId ? { lotId: m.lotId } : {}),
            },
            $setOnInsert: {
              variantId: m.variantId ?? null,
              receivedAt: postedAt,
              unitCostMinor: m.unitCostMinor ?? null,
              warrantyMonths: product.warrantyMonths,
            },
          },
          { upsert: true, session },
        );
      } catch (error) {
        if (error instanceof mongo.MongoServerError && error.code === 11000) {
          // The duplicate key has already aborted this transaction, so the session is unusable:
          // read committed state instead — it is only to word the message.
          const existing = await SerialUnit.findOne({ orgId, serialNo })
            .select('status productId')
            .lean();
          throw ApiError.conflict(
            'DUPLICATE_DOCUMENT',
            existing && !existing.productId.equals(m.productId)
              ? `Serial ${serialNo} belongs to another product`
              : `Serial ${serialNo} is already in stock`,
            { serialNo },
          );
        }
        throw error;
      }
      continue;
    }

    const status = outboundSerialStatus(m.movementType);
    const sold = status === 'SOLD';
    const endDay =
      sold && product.warrantyMonths
        ? warrantyEndDay(dayIn(postedAt, timeZone), product.warrantyMonths)
        : null;

    const { matchedCount } = await SerialUnit.updateOne(
      {
        orgId,
        serialNo,
        status: 'IN_STOCK',
        locationId: m.locationId,
        productId: m.productId,
        variantId: m.variantId ?? null,
      },
      {
        $set: {
          status,
          locationId: null,
          lastMovementAt: postedAt,
          ...(sold
            ? {
                soldAt: postedAt,
                soldPartyId: m.sale?.partyId ?? null,
                soldInvoiceId: m.sale?.invoiceId ?? null,
                sellPriceMinor: m.sale?.sellPriceMinor ?? null,
                // The warranty clock starts at the sale, not at receipt.
                warrantyStartAt: postedAt,
                warrantyEndAt: endDay ? new Date(`${endDay}T00:00:00.000Z`) : null,
              }
            : {}),
        },
      },
      { session },
    );

    if (matchedCount === 0) {
      const unit = await SerialUnit.findOne({ orgId, serialNo })
        .select('status locationId productId')
        .session(session)
        .lean();
      throw ApiError.conflict(
        'INSUFFICIENT_STOCK',
        !unit
          ? `Serial ${serialNo} was never received`
          : !unit.productId.equals(m.productId)
            ? `Serial ${serialNo} belongs to another product`
            : unit.status !== 'IN_STOCK'
              ? `Serial ${serialNo} is ${unit.status.toLowerCase().replace('_', ' ')}`
              : `Serial ${serialNo} is at another location`,
        { serialNo, status: unit?.status ?? null },
      );
    }
  }
}

/**
 * The lot-level balance, moved with the same guard as the product balance: five cannot leave a
 * lot that holds three, whatever the product's total says.
 */
async function moveLot(
  session: ClientSession,
  orgId: Types.ObjectId,
  m: MovementInput,
  postedAt: Date,
  allowNegative: boolean,
): Promise<void> {
  const key = { orgId, locationId: m.locationId, lotId: m.lotId! };
  if (m.qtyBase < 0) {
    const updated = await LotBalance.findOneAndUpdate(
      { ...key, ...(allowNegative ? {} : { qtyOnHand: { $gte: -m.qtyBase } }) },
      { $inc: { qtyOnHand: m.qtyBase }, $set: { lastMovementAt: postedAt } },
      { new: true, session, upsert: allowNegative, setDefaultsOnInsert: true },
    ).lean();
    if (!updated) {
      const current = await LotBalance.findOne(key).session(session).lean();
      const lot = await Lot.findById(m.lotId).select('lotNo').session(session).lean();
      throw ApiError.conflict(
        'INSUFFICIENT_STOCK',
        `Not enough in lot ${lot?.lotNo ?? ''} here`,
        {
          lotId: String(m.lotId),
          requested: -m.qtyBase,
          available: current?.qtyOnHand ?? 0,
        },
      );
    }
    return;
  }
  await LotBalance.updateOne(
    key,
    {
      $inc: { qtyOnHand: m.qtyBase },
      $set: { lastMovementAt: postedAt },
      $setOnInsert: { productId: m.productId, variantId: m.variantId ?? null },
    },
    { upsert: true, session },
  );
}

/** The moving average after an inbound movement with a known cost. */
function blendedCost(onHand: number, avg: number, qtyIn: number, cost: number): number {
  // A shelf at or below zero has no meaningful average to blend with: the incoming cost is it.
  if (onHand <= 0) return cost;
  return roundHalfUp((onHand * avg + qtyIn * cost) / (onHand + qtyIn));
}

export async function postMovements(
  session: ClientSession,
  { orgId, movements, postedAt, actorId, bypassFreeze = false }: PostMovementsArgs,
): Promise<StockLedgerDoc[]> {
  if (movements.length === 0) return [];
  movements.forEach(assertShape);

  const org = await Org.findById(orgId)
    .select('timeZone settings.allowNegativeStock')
    .session(session)
    .lean();
  const allowNegative = Boolean(org?.settings?.allowNegativeStock);
  const periodKey = periodKeyOf(postedAt, org?.timeZone ?? 'Asia/Dhaka');

  const productBy = await assertReferences(session, orgId, movements);
  const timeZone = org?.timeZone ?? 'Asia/Dhaka';

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

    // Units and lots first: when a serial is sold already or a lot is short, that is the error
    // worth reporting — not the product-level shortfall it also causes. All of it is one
    // transaction, so the order changes only which refusal the user reads.
    const product = productBy.get(String(m.productId))!;
    if (m.serials?.length) await moveSerials(session, orgId, m, product, postedAt, timeZone);
    if (m.lotId) await moveLot(session, orgId, m, postedAt, allowNegative);

    if (m.qtyBase < 0) {
      const needed = -m.qtyBase;
      // A sale or transfer may take only what is *available*: on hand less what confirmed orders
      // have reserved (plus whatever of that reservation this movement itself fulfils). Without
      // this a counter sale could sell the units a dealer's order is waiting on.
      const reservedAfterRelease = RESPECTS_RESERVATIONS.includes(m.movementType)
        ? { $expr: { $gte: [{ $subtract: ['$qtyOnHand', '$qtyReserved'] }, needed - release] } }
        : {};
      const guard = allowNegative
        ? {}
        : {
            qtyOnHand: { $gte: needed },
            ...(release > 0 ? { qtyReserved: { $gte: release } } : {}),
            ...reservedAfterRelease,
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
        if (current?.frozenByCountId && !bypassFreeze)
          throw frozenError(m, current.frozenByCountId);
        const onHand = current?.qtyOnHand ?? 0;
        const reserved = current?.qtyReserved ?? 0;
        const heldForOrders =
          onHand >= needed && RESPECTS_RESERVATIONS.includes(m.movementType);
        throw ApiError.conflict(
          'INSUFFICIENT_STOCK',
          heldForOrders
            ? 'Not enough stock for this movement — some of it is reserved for confirmed orders'
            : 'Not enough stock for this movement',
          {
            locationId: String(m.locationId),
            productId: String(m.productId),
            variantId: m.variantId ? String(m.variantId) : null,
            requested: needed,
            onHand,
            reserved,
            available: RESPECTS_RESERVATIONS.includes(m.movementType)
              ? Math.max(0, onHand - reserved + release)
              : onHand,
          },
        );
      }
      // Frozen but with enough stock: the update went through inside this transaction, and
      // throwing now rolls it back with everything else.
      if (updated.frozenByCountId && !bypassFreeze)
        throw frozenError(m, updated.frozenByCountId);
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
      if (updated!.frozenByCountId && !bypassFreeze)
        throw frozenError(m, updated!.frozenByCountId);
      balanceAfter = updated!.qtyOnHand;
    }

    const row = (qtyBase: number, serialNo: string | null, after: number) => ({
      orgId,
      postedAt,
      periodKey,
      locationId: m.locationId,
      productId: m.productId,
      variantId: m.variantId ?? null,
      lotId: m.lotId ?? null,
      serialNo,
      qtyBase,
      movementType: m.movementType,
      refType: m.refType,
      refId: m.refId ?? null,
      refDocNo: m.refDocNo ?? null,
      unitCostMinor: m.unitCostMinor ?? null,
      valueMinor: m.unitCostMinor != null ? m.unitCostMinor * qtyBase : null,
      balanceAfterBase: after,
      reversalOfId: m.reversalOfId ?? null,
      narration: m.narration ?? null,
      createdBy: actorId,
    });

    if (m.serials?.length) {
      // One row per unit, ±1 each. The balance was moved once for the whole quantity, so each
      // row's snapshot is worked back from the final figure.
      const sign = Math.sign(m.qtyBase);
      const n = m.serials.length;
      m.serials.forEach((raw, i) => {
        rows.push(row(sign, raw.trim().toUpperCase(), balanceAfter - sign * (n - 1 - i)));
      });
    } else {
      rows.push(row(m.qtyBase, null, balanceAfter));
    }
  }

  return (await StockLedger.insertMany(rows, { session, ordered: true })).map((d) =>
    d.toObject(),
  );
}

// ─── Reservations (Day 22) ──────────────────────────────────────────────────────────────

export interface ReservationLine {
  locationId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  qtyBase: number;
}

export interface ReserveArgs {
  orgId: Types.ObjectId;
  lines: readonly ReservationLine[];
  /** For the error: which line of the caller's document could not be reserved. */
  pathOf?: (index: number) => string;
}

function assertReservationShape(l: ReservationLine, index: number): void {
  if (!Number.isInteger(l.qtyBase) || l.qtyBase <= 0) {
    throw ApiError.internal(`Reservation ${index}: qtyBase must be a positive integer`);
  }
}

/**
 * Promise stock to a confirmed order: `qtyReserved += qty`, **no ledger row** (§7 — the ledger
 * records physical movement only, so its running sum stays equal to what is on the shelf).
 *
 * Guarded like an outbound movement: the row is updated only `WHERE qtyOnHand − qtyReserved ≥
 * qty`, so two orders confirmed at once cannot both be promised the last ten units — one matches,
 * the other gets `409 INSUFFICIENT_STOCK` naming the line. With `allowNegativeStock` the promise
 * is made regardless, as an outbound movement would be.
 *
 * Takes the caller's session and never commits: a refusal on the third line rolls back the first
 * two with the rest of the confirm.
 */
export async function reserveStock(
  session: ClientSession,
  { orgId, lines, pathOf = (i) => `lines.${i}` }: ReserveArgs,
): Promise<void> {
  lines.forEach(assertReservationShape);
  const org = await Org.findById(orgId)
    .select('settings.allowNegativeStock')
    .session(session)
    .lean();
  const allowNegative = Boolean(org?.settings?.allowNegativeStock);

  for (const [i, l] of lines.entries()) {
    const key = {
      orgId,
      locationId: l.locationId,
      productId: l.productId,
      variantId: l.variantId,
    };
    const guard = allowNegative
      ? {}
      : { $expr: { $gte: [{ $subtract: ['$qtyOnHand', '$qtyReserved'] }, l.qtyBase] } };
    const updated = await StockBalance.findOneAndUpdate(
      { ...key, ...guard },
      { $inc: { qtyReserved: l.qtyBase } },
      { new: true, session, upsert: allowNegative, setDefaultsOnInsert: true },
    ).lean();
    if (!updated) {
      const current = await StockBalance.findOne(key).session(session).lean();
      const onHand = current?.qtyOnHand ?? 0;
      const reserved = current?.qtyReserved ?? 0;
      const [product, variant] = await Promise.all([
        Product.findById(l.productId).select('sku').session(session).lean(),
        l.variantId
          ? Variant.findById(l.variantId).select('sku').session(session).lean()
          : Promise.resolve(null),
      ]);
      throw ApiError.conflict(
        'INSUFFICIENT_STOCK',
        `Not enough ${variant?.sku ?? product?.sku ?? 'stock'} available to reserve`,
        {
          path: pathOf(i),
          locationId: String(l.locationId),
          productId: String(l.productId),
          variantId: l.variantId ? String(l.variantId) : null,
          requested: l.qtyBase,
          onHand,
          reserved,
          available: Math.max(0, onHand - reserved),
        },
      );
    }
  }
}

/**
 * Give a reservation back — a cancelled order, a short close. The inverse of `reserveStock`,
 * guarded so it can never drive `qtyReserved` below zero: a release of more than is held is a
 * bookkeeping bug in the caller, and is refused as one rather than quietly clamped.
 */
export async function releaseReservation(
  session: ClientSession,
  { orgId, lines }: Omit<ReserveArgs, 'pathOf'>,
): Promise<void> {
  lines.forEach(assertReservationShape);
  for (const [i, l] of lines.entries()) {
    const res = await StockBalance.updateOne(
      {
        orgId,
        locationId: l.locationId,
        productId: l.productId,
        variantId: l.variantId,
        qtyReserved: { $gte: l.qtyBase },
      },
      { $inc: { qtyReserved: -l.qtyBase } },
      { session },
    );
    if (res.matchedCount !== 1) {
      throw ApiError.internal(`Release ${i}: more than is reserved at this location`);
    }
  }
}
