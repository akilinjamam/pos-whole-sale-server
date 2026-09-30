import { Types } from 'mongoose';

import { checkCredit } from '../../domain/creditCheck.js';
import { computeTotals, PricingError } from '../../domain/pricing.js';
import { ApiError } from '../../lib/ApiError.js';
import { assertLocationAllowed } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { assertStockLocation, resolveStockLines } from '../../services/stockLines.js';
import { applyPct } from '../../shared/money.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { resolveForRequest } from '../pricing/pricing.service.js';
import { Product } from '../product/product.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';
import { Variant } from '../variant/variant.model.js';

import type { OrderDiscountSpecDoc, OrderLineDoc } from './wholesaleOrder.model.js';
import type { OrderDiscount } from '../../domain/pricing.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { PartyDoc } from '../party/party.model.js';
import type { OrderLineInput } from '@shared/orders.js';
import type {
  OrderCreditPosition,
  OrderDiscountSpec,
  OrderQuote,
  PriceResolution,
} from '@shared/types.js';

/**
 * Price a wholesale order — **the one pricing path** for create, update, confirm and quote.
 *
 * Every price comes from the pricing engine (`resolveForRequest`, Day 12) for this dealer, product,
 * unit and quantity; every total from `computeTotals`, which prorates the order discount by largest
 * remainder so the lines always add up to the header. Nothing money-shaped is taken from the
 * client except an explicit override or discount, each behind its own permission.
 *
 * Reads only. Callers that write do so afterwards, in their own transaction.
 */

export interface PriceOrderInput {
  dealerPartyId: string;
  locationId: string;
  lines: readonly OrderLineInput[];
  orderDiscount?: OrderDiscountSpec | null;
  shippingMinor?: number;
}

export interface PriceOrderOptions {
  /**
   * The draft being edited. An override or discount already on it may be resubmitted *unchanged*
   * by someone without the permission — a rep can fix a quantity on an order a manager discounted
   * without being refused for a discount they did not give.
   */
  previous?: {
    lines: readonly OrderLineDoc[];
    orderDiscount: OrderDiscountSpecDoc | null;
  } | null;
  /** Repricing a saved order at confirm: every override and discount on it was authorised on save. */
  trustInput?: boolean;
}

export interface PricedLine {
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  sku: string;
  productName: string;
  uomCode: string;
  uomQty: number;
  qtyBase: number;
  resolution: PriceResolution;
  unitPriceMinor: number;
  priceOverridden: boolean;
  discountPct: number;
  discountMinor: number;
  lineTotalMinor: number;
}

export interface PricedOrder {
  dealer: PartyDoc;
  locationId: Types.ObjectId;
  lines: PricedLine[];
  orderDiscount: OrderDiscountSpec | null;
  subtotalMinor: number;
  orderDiscountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  roundingMinor: number;
  grandTotalMinor: number;
}

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

const needs = (permission: 'order:priceOverride' | 'order:discount', path: string) =>
  new ApiError(
    403,
    'FORBIDDEN',
    permission === 'order:discount'
      ? 'Discounts need the order:discount permission'
      : 'Changing a price needs the order:priceOverride permission',
    { required: [permission], fields: [path] },
  );

const itemKey = (productId: unknown, variantId: unknown, uomCode: string) =>
  `${String(productId)}|${variantId ? String(variantId) : '-'}|${uomCode}`;

const sameDiscount = (
  a: OrderDiscountSpec | null | undefined,
  b: OrderDiscountSpecDoc | null | undefined,
) =>
  (!a && !b) ||
  (a?.kind === 'AMOUNT' && b?.kind === 'AMOUNT' && a.amountMinor === b.amountMinor) ||
  (a?.kind === 'PCT' && b?.kind === 'PCT' && a.pct === b.pct);

/** The dealer an order is for: exists, is a dealer, is active. A credit hold is the caller's call. */
export async function loadDealer(orgId: Types.ObjectId, id: string): Promise<PartyDoc> {
  const dealer = await Party.findOne({ _id: id, orgId, roles: 'DEALER' }).lean();
  if (!dealer) throw refuse('dealerPartyId', 'No such dealer');
  if (!dealer.isActive) throw refuse('dealerPartyId', `${dealer.name} is inactive`);
  return dealer;
}

/** Where an order ships from: a location the caller works at, that holds sellable stock. */
export async function assertOrderLocation(
  actor: RequestActor,
  locationId: string,
): Promise<void> {
  const location = await assertStockLocation(actor.orgId, locationId, 'locationId');
  if (location.type === 'DAMAGE') {
    throw refuse(
      'locationId',
      `${location.code} holds damaged stock — orders cannot ship from it`,
    );
  }
  assertLocationAllowed(actor.user, locationId);
}

export async function priceOrder(
  actor: RequestActor,
  input: PriceOrderInput,
  { previous = null, trustInput = false }: PriceOrderOptions = {},
): Promise<PricedOrder> {
  const [dealer] = await Promise.all([
    loadDealer(actor.orgId, input.dealerPartyId),
    assertOrderLocation(actor, input.locationId),
  ]);

  // Products, variants and units — the same rules as every stock document. Tracked products are
  // welcome on an order; which serials or lot is a dispatch-time question (Day 24).
  const stockLines = await resolveStockLines(
    actor.orgId,
    input.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.qty,
    })),
    { requireCapture: false },
  );
  const products = await Product.find({
    orgId: actor.orgId,
    _id: { $in: stockLines.map((l) => l.productId) },
  })
    .select('name sku isActive isSellableWholesale')
    .lean();
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  stockLines.forEach((l, i) => {
    const p = productBy.get(String(l.productId))!;
    if (!p.isActive || !p.isSellableWholesale) {
      throw refuse(`lines.${i}.productId`, `${p.sku} is not sold wholesale`);
    }
  });
  const variants = await Variant.find({
    orgId: actor.orgId,
    _id: { $in: stockLines.flatMap((l) => (l.variantId ? [l.variantId] : [])) },
  })
    .select('sku')
    .lean();
  const variantSku = new Map(variants.map((v) => [String(v._id), v.sku]));

  // ── Permissions for anything that departs from the engine ──
  const canOverride = trustInput || hasPermission(actor.user, 'order:priceOverride');
  const canDiscount = trustInput || hasPermission(actor.user, 'order:discount');
  const before = new Map(
    (previous?.lines ?? []).map((l) => [itemKey(l.productId, l.variantId, l.uomCode), l]),
  );

  const priced = await Promise.all(
    input.lines.map(async (line, i) => {
      const l = stockLines[i]!;
      const resolution = await resolveForRequest(actor.orgId, {
        productId: String(l.productId),
        ...(l.variantId ? { variantId: String(l.variantId) } : {}),
        partyId: String(dealer._id),
        uomCode: l.uomCode,
        qty: l.qty,
      });
      const was = before.get(itemKey(l.productId, l.variantId, l.uomCode));

      let unitPriceMinor = resolution.unitPriceMinor;
      let priceOverridden = false;
      if (
        line.unitPriceMinor !== undefined &&
        line.unitPriceMinor !== resolution.unitPriceMinor
      ) {
        const unchanged = was?.priceOverridden && was.unitPriceMinor === line.unitPriceMinor;
        if (!canOverride && !unchanged)
          throw needs('order:priceOverride', `lines.${i}.unitPriceMinor`);
        unitPriceMinor = line.unitPriceMinor;
        priceOverridden = true;
      }

      const discountPct = line.discountPct ?? 0;
      if (discountPct > 0 && !canDiscount && was?.discountPct !== discountPct) {
        throw needs('order:discount', `lines.${i}.discountPct`);
      }
      return { l, resolution, unitPriceMinor, priceOverridden, discountPct };
    }),
  );

  const spec = input.orderDiscount ?? null;
  const discounting = spec
    ? spec.kind === 'AMOUNT'
      ? spec.amountMinor > 0
      : spec.pct > 0
    : false;
  if (discounting && !canDiscount && !sameDiscount(spec, previous?.orderDiscount)) {
    throw needs('order:discount', 'orderDiscount');
  }

  let totals;
  try {
    totals = computeTotals(
      priced.map((p) => ({
        unitPriceMinor: p.unitPriceMinor,
        qty: p.l.qty,
        lineDiscountMinor: applyPct(p.unitPriceMinor * p.l.qty, p.discountPct),
      })),
      (spec ?? { kind: 'NONE' }) as OrderDiscount,
    );
  } catch (error) {
    if (error instanceof PricingError) throw refuse(error.field, error.message);
    throw error;
  }

  const shippingMinor = input.shippingMinor ?? 0;
  const lines: PricedLine[] = priced.map((p, i) => {
    const t = totals.lines[i]!;
    const product = productBy.get(String(p.l.productId))!;
    return {
      productId: p.l.productId,
      variantId: p.l.variantId,
      sku: (p.l.variantId && variantSku.get(String(p.l.variantId))) || product.sku,
      productName: product.name,
      uomCode: p.l.uomCode,
      uomQty: p.l.qty,
      qtyBase: p.l.qtyBase,
      resolution: p.resolution,
      unitPriceMinor: p.unitPriceMinor,
      priceOverridden: p.priceOverridden,
      discountPct: p.discountPct,
      discountMinor: t.lineDiscountMinor + t.orderDiscountMinor,
      lineTotalMinor: t.netMinor,
    };
  });

  return {
    dealer,
    locationId: new Types.ObjectId(input.locationId),
    lines,
    orderDiscount: discounting ? spec : null,
    subtotalMinor: totals.subtotalMinor,
    orderDiscountMinor: totals.orderDiscountMinor,
    // VAT held at zero until open question 1 (VAT/Mushak) is answered.
    taxMinor: 0,
    shippingMinor,
    roundingMinor: 0,
    grandTotalMinor: totals.totalMinor + shippingMinor,
  };
}

/**
 * Priced lines as stored order lines. Counters start at zero; a line that survives an edit keeps
 * its `_id` (matched by product, variant and unit), so references to it stay stable.
 */
export function toOrderLines(
  priced: readonly PricedLine[],
  previous: readonly OrderLineDoc[] = [],
): OrderLineDoc[] {
  const idBy = new Map(
    previous.map((l) => [itemKey(l.productId, l.variantId, l.uomCode), l._id] as const),
  );
  return priced.map((p, i) => ({
    _id: idBy.get(itemKey(p.productId, p.variantId, p.uomCode)) ?? new Types.ObjectId(),
    lineNo: i + 1,
    productId: p.productId,
    variantId: p.variantId,
    uomCode: p.uomCode,
    uomQty: p.uomQty,
    qtyBase: p.qtyBase,
    qtyReservedBase: 0,
    qtyDispatchedBase: 0,
    qtyInvoicedBase: 0,
    qtyReturnedBase: 0,
    qtyCancelledBase: 0,
    unitPriceMinor: p.unitPriceMinor,
    priceOverridden: p.priceOverridden,
    originalPriceMinor: p.priceOverridden ? p.resolution.unitPriceMinor : null,
    discountPct: p.discountPct,
    discountMinor: p.discountMinor,
    taxPct: 0,
    taxMinor: 0,
    lineTotalMinor: p.lineTotalMinor,
  }));
}

/** A stored order's lines as pricing input — for repricing at confirm. */
export function linesAsInput(lines: readonly OrderLineDoc[]): OrderLineInput[] {
  return lines.map((l) => ({
    productId: String(l.productId),
    variantId: l.variantId ? String(l.variantId) : null,
    uomCode: l.uomCode,
    qty: l.uomQty,
    ...(l.priceOverridden ? { unitPriceMinor: l.unitPriceMinor } : {}),
    ...(l.discountPct > 0 ? { discountPct: l.discountPct } : {}),
  }));
}

export function specOf(doc: OrderDiscountSpecDoc | null): OrderDiscountSpec | null {
  if (!doc) return null;
  return doc.kind === 'AMOUNT'
    ? { kind: 'AMOUNT', amountMinor: doc.amountMinor }
    : { kind: 'PCT', pct: doc.pct };
}

/**
 * The dealer's credit against this order — **stubbed exposure** until Day 31: what they owe now
 * plus this order. Day 31 adds open orders and unallocated receipts to the same function.
 */
export async function creditPosition(
  actor: RequestActor,
  dealer: PartyDoc,
  orderTotalMinor: number,
): Promise<OrderCreditPosition> {
  const org = await Org.findById(actor.orgId).select('settings.enforceCreditLimit').lean();
  const verdict = checkCredit(
    {
      creditHold: Boolean(dealer.dealer?.creditHold),
      creditHoldReason: dealer.dealer?.creditHoldReason ?? null,
      creditLimitMinor: dealer.dealer?.creditLimitMinor ?? 0,
      currentBalanceMinor: dealer.currentBalanceMinor,
    },
    orderTotalMinor,
    org?.settings?.enforceCreditLimit ?? true,
  );
  return {
    balanceMinor: dealer.currentBalanceMinor,
    limitMinor: dealer.dealer?.creditLimitMinor ?? 0,
    creditHold: Boolean(dealer.dealer?.creditHold),
    exposureAfterMinor: verdict.exposureAfterMinor,
    verdict: verdict.ok ? 'OK' : verdict.reason,
    message: verdict.ok ? null : verdict.message,
    canOverride: hasPermission(actor.user, 'order:creditOverride'),
  };
}

/** What the builder shows: every line priced, with availability, and the credit panel. */
export async function quote(actor: RequestActor, input: PriceOrderInput): Promise<OrderQuote> {
  const priced = await priceOrder(actor, input);
  const balances = await StockBalance.find({
    orgId: actor.orgId,
    locationId: priced.locationId,
    productId: { $in: priced.lines.map((l) => l.productId) },
  })
    .select('productId variantId qtyOnHand qtyReserved')
    .lean();
  const availableBy = new Map(
    balances.map((b) => [
      itemKey(b.productId, b.variantId, ''),
      Math.max(0, b.qtyOnHand - b.qtyReserved),
    ]),
  );

  return {
    lines: priced.lines.map((l) => ({
      productId: String(l.productId),
      variantId: l.variantId ? String(l.variantId) : null,
      sku: l.sku,
      productName: l.productName,
      uomCode: l.uomCode,
      qty: l.uomQty,
      qtyBase: l.qtyBase,
      priceSource: l.resolution.source,
      listUnitPriceMinor: l.resolution.listUnitPriceMinor,
      tradeDiscountPct: l.resolution.discountPct,
      resolvedUnitPriceMinor: l.resolution.unitPriceMinor,
      unitPriceMinor: l.unitPriceMinor,
      priceOverridden: l.priceOverridden,
      discountPct: l.discountPct,
      discountMinor: l.discountMinor,
      lineTotalMinor: l.lineTotalMinor,
      nextBreak: l.resolution.nextBreak,
      availableBase: availableBy.get(itemKey(l.productId, l.variantId, '')) ?? 0,
    })),
    subtotalMinor: priced.subtotalMinor,
    orderDiscountMinor: priced.orderDiscountMinor,
    taxMinor: priced.taxMinor,
    shippingMinor: priced.shippingMinor,
    grandTotalMinor: priced.grandTotalMinor,
    credit: await creditPosition(actor, priced.dealer, priced.grandTotalMinor),
  };
}
