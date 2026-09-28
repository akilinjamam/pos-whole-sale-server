import { Types } from 'mongoose';

import { expiryFromShelfLife } from '../domain/warranty.js';
import { ApiError } from '../lib/ApiError.js';
import { dayToDate } from '../lib/period.js';
import { lotForInbound, lotForOutbound } from './lot.service.js';
import { toBase, UomError } from '../shared/uom.js';
import { describeAxes } from '../shared/variant.js';
import { Location } from '../modules/location/location.model.js';
import { Product } from '../modules/product/product.model.js';
import { Variant } from '../modules/variant/variant.model.js';

import type { LineNames, StockDocLineDoc } from '../modules/stock/stockDocLine.js';
import type { ApiFieldError } from '@shared/types.js';
import type { ClientSession } from 'mongoose';

/**
 * Turning entered lines into stock lines, once, for every stock document.
 *
 * Every rule a line must meet is checked here and reported **per field**, so the document editor
 * can put each message on the input that caused it:
 *
 *  - the product exists in this org, and a variant — when named — belongs to it;
 *  - a product with variants names one (stock is kept per variant), and one without does not;
 *  - the unit is one the product declares, and the quantity is whole packs (`toBase`);
 *  - the same item does not appear on two lines, which would make the document ambiguous;
 *  - lot- and serial-tracked products wait for Day 15, which gives them somewhere to record the
 *    lot or the serials — moving 30 machines as an anonymous number would break the warranty
 *    trail before it starts.
 */

export interface LineInput {
  productId: string;
  variantId?: string | null;
  uomCode?: string | null;
  /** Signed only where the document allows it (adjustments). */
  qty: number;
  lotNo?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  serials?: readonly string[];
}

export interface ResolveOptions {
  path?: string;
  /**
   * Whether lot- and serial-tracked products are accepted. Counts say no: counting per lot or per
   * serial is a different sheet, and a product-level count of them would post a variance that
   * no lot or serial could be attached to.
   */
  allowTracked?: boolean;
  /**
   * Whether a positive line brings a lot *into* existence (an adjustment finding stock) and so
   * needs the box's dates. A transfer only moves lots that already exist.
   */
  inboundCreatesLots?: boolean;
}

/** A lot product may appear once per lot; everything else once per item. */
const itemKey = (productId: string, variantId?: string | null, lotNo?: string | null) =>
  `${productId}|${variantId ?? '-'}|${lotNo ?? '-'}`;

export async function resolveStockLines(
  orgId: Types.ObjectId,
  lines: readonly LineInput[],
  { path = 'lines', allowTracked = true, inboundCreatesLots = false }: ResolveOptions = {},
): Promise<StockDocLineDoc[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const variantIds = [...new Set(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))];

  const [products, variants] = await Promise.all([
    Product.find({ orgId, _id: { $in: productIds } })
      .select('sku baseUom packs hasVariants trackingMode attrs')
      .lean(),
    variantIds.length > 0
      ? Variant.find({ orgId, _id: { $in: variantIds } })
          .select('productId')
          .lean()
      : Promise.resolve([]),
  ]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), v]));

  const errors: ApiFieldError[] = [];
  const resolved: StockDocLineDoc[] = [];
  const seen = new Map<string, number>();
  const serialLine = new Map<string, number>();

  lines.forEach((line, i) => {
    const at = (field: string) => `${path}.${i}.${field}`;
    const product = productBy.get(line.productId);
    if (!product) {
      errors.push({ path: at('productId'), message: 'No such product' });
      return;
    }
    if (product.trackingMode !== 'NONE' && !allowTracked) {
      errors.push({
        path: at('productId'),
        message: `${product.sku} is ${product.trackingMode.toLowerCase()}-tracked — it cannot be handled here`,
      });
      return;
    }
    if (product.hasVariants && !line.variantId) {
      errors.push({
        path: at('variantId'),
        message: `${product.sku} is stocked per variant — choose one`,
      });
      return;
    }
    if (!product.hasVariants && line.variantId) {
      errors.push({ path: at('variantId'), message: `${product.sku} has no variants` });
      return;
    }
    if (line.variantId && !variantBy.get(line.variantId)?.productId.equals(product._id)) {
      errors.push({ path: at('variantId'), message: `Not a variant of ${product.sku}` });
      return;
    }

    const lotNo =
      product.trackingMode === 'LOT' ? line.lotNo?.trim().toUpperCase() || null : null;
    const key = itemKey(line.productId, line.variantId, lotNo);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      errors.push({
        path: at('productId'),
        message: `Same item as line ${earlier + 1} — combine them`,
      });
      return;
    }
    seen.set(key, i);

    const uomCode = line.uomCode || product.baseUom;
    let qtyBase: number;
    try {
      // `toBase` works on magnitudes; the sign is the document's business, not the unit's.
      qtyBase =
        Math.sign(line.qty) *
        toBase(Math.abs(line.qty), uomCode, {
          baseUom: product.baseUom,
          packs: product.packs ?? [],
        });
    } catch (error) {
      if (error instanceof UomError) {
        errors.push({
          path: at(error.code === 'UNKNOWN_UOM' ? 'uomCode' : 'qty'),
          message: error.message,
        });
        return;
      }
      throw error;
    }

    // ── Tracking capture ──
    const serials = (line.serials ?? []).map((sn) => sn.trim().toUpperCase());
    let mfgDate: string | null = null;
    let expiryDate: string | null = null;

    if (product.trackingMode === 'SERIAL') {
      if (serials.length !== Math.abs(qtyBase)) {
        errors.push({
          path: at('serials'),
          message: `${Math.abs(qtyBase)} unit(s) need exactly ${Math.abs(qtyBase)} serial number(s) — ${serials.length} given`,
        });
        return;
      }
      for (const sn of serials) {
        const other = serialLine.get(sn);
        if (other !== undefined) {
          errors.push({
            path: at('serials'),
            message:
              other === i ? `${sn} is listed twice` : `${sn} is also on line ${other + 1}`,
          });
          return;
        }
        serialLine.set(sn, i);
      }
    } else if (serials.length > 0) {
      errors.push({ path: at('serials'), message: `${product.sku} is not serial-tracked` });
      return;
    }

    if (product.trackingMode === 'LOT') {
      if (!lotNo) {
        errors.push({
          path: at('lotNo'),
          message: `${product.sku} is lot-tracked — give the lot number`,
        });
        return;
      }
      if (inboundCreatesLots && qtyBase > 0) {
        mfgDate = line.mfgDate ?? null;
        expiryDate = line.expiryDate ?? null;
        const accessory = product.attrs?.type === 'ACCESSORY' ? product.attrs : null;
        if (!expiryDate && mfgDate && accessory?.shelfLifeDays) {
          expiryDate = expiryFromShelfLife(mfgDate, accessory.shelfLifeDays);
        }
        if (accessory?.requiresExpiry && !expiryDate) {
          errors.push({
            path: at('expiryDate'),
            message: `${product.sku} needs an expiry date (or a manufacture date)`,
          });
          return;
        }
      }
    } else if (line.lotNo) {
      errors.push({ path: at('lotNo'), message: `${product.sku} is not lot-tracked` });
      return;
    }

    resolved.push({
      productId: product._id,
      variantId: line.variantId ? new Types.ObjectId(line.variantId) : null,
      uomCode,
      qty: line.qty,
      qtyBase,
      lotNo,
      mfgDate: dayToDate(mfgDate),
      expiryDate: dayToDate(expiryDate),
      serials,
    });
  });

  if (errors.length > 0) throw ApiError.validation('Validation failed', errors);
  return resolved;
}

/**
 * A location in this org that can hold stock for this purpose. `TRANSIT` is never a place a
 * person adjusts, counts or sends *from* by choice — goods reach it only as a transfer's leg.
 */
export async function assertStockLocation(
  orgId: Types.ObjectId,
  locationId: string,
  path: string,
  { allowTransit = false } = {},
): Promise<{ _id: Types.ObjectId; code: string; name: string; type: string }> {
  const location = await Location.findOne({ _id: locationId, orgId })
    .select('code name type isActive')
    .lean();
  if (!location)
    throw ApiError.validation('Validation failed', [{ path, message: 'No such location' }]);
  if (location.type === 'TRANSIT' && !allowTransit) {
    throw ApiError.validation('Validation failed', [
      { path, message: `${location.code} is a transit location — goods only pass through it` },
    ]);
  }
  return location;
}

/** Product and variant names for document lines, in two grouped queries. */
export async function lineNames(
  orgId: Types.ObjectId,
  lines: readonly { productId: Types.ObjectId; variantId: Types.ObjectId | null }[],
): Promise<LineNames> {
  const productIds = [...new Set(lines.map((l) => String(l.productId)))];
  const variantIds = [
    ...new Set(lines.flatMap((l) => (l.variantId ? [String(l.variantId)] : []))),
  ];
  const [products, variants] = await Promise.all([
    Product.find({ orgId, _id: { $in: productIds } })
      .select('name sku baseUom')
      .lean(),
    variantIds.length > 0
      ? Variant.find({ orgId, _id: { $in: variantIds } })
          .select('axes')
          .lean()
      : Promise.resolve([]),
  ]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), describeAxes(v.axes)]));

  return (l) => {
    const p = productBy.get(String(l.productId));
    return {
      productName: p?.name ?? '(deleted product)',
      sku: p?.sku ?? '',
      baseUom: p?.baseUom ?? '',
      variantLabel: l.variantId ? (variantBy.get(String(l.variantId)) ?? null) : null,
    };
  };
}

/**
 * The lot and serial parts of a movement for one document line, resolved inside the posting
 * transaction. `IN` gets-or-creates the lot (with the line's dates); `OUT` requires it to exist.
 */
export async function trackingFor(
  session: ClientSession,
  orgId: Types.ObjectId,
  line: StockDocLineDoc,
  direction: 'IN' | 'OUT',
  actorId: Types.ObjectId,
): Promise<{ lotId: Types.ObjectId | null; serials?: string[] }> {
  let lotId: Types.ObjectId | null = null;
  if (line.lotNo) {
    const ref = {
      productId: line.productId,
      variantId: line.variantId,
      lotNo: line.lotNo,
      mfgDate: line.mfgDate,
      expiryDate: line.expiryDate,
    };
    lotId = (
      direction === 'IN'
        ? await lotForInbound(session, orgId, ref, actorId)
        : await lotForOutbound(session, orgId, ref)
    )._id;
  }
  return { lotId, ...(line.serials?.length ? { serials: line.serials } : {}) };
}
